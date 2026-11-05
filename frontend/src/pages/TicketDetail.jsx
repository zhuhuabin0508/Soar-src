// 工单详情页：流程步骤条 + 节点处理时间线 + 当前节点操作表单
// - 上游节点字段对处理人只读展示；当前节点表单按快照字段定义动态渲染
// - 处理权限由服务端返回（can_handle：当前节点分组成员或 admin；先到先得）
// - 流转去向：按条件路由自动建议，处理人可确认调整；到达结束节点后工单完成
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, CheckCircle2, XCircle, Clock, Paperclip, X,
  SendHorizonal, Ban, UserRound, ChevronRight, Flag, Link2, Archive, ArchiveRestore,
  ShieldCheck, ShieldBan, Database, AlertTriangle, ClipboardList, Plus, UsersRound, Users,
  Download, CornerUpLeft, Bot, Zap, ArrowRightLeft, UserCheck, MessageSquare, Sparkles, Search, Loader2, Info, Lock,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputBaseCls, inputCls, labelCls, hintCls } from '../components/property/FormControls'
import {Button, PageContainer, CompactSelect, ComboInput, DatePicker, AutoGrowTextarea } from '../components/ui'
import { hasPermission, guardNavPermission } from '../utils/permissions'
import ticketApi, { attachmentUrl } from '../api/tickets'
import { evalRoutes, fieldDefMap, fieldValueText, FIELD_TYPE_LABELS, flatFieldDefs, matchedRuleFields, collectRefOptions, durationToParts, durationFromParts, DURATION_UNITS, evalParamExpr, deviceDurationLabel } from '../utils/ticketFlow'
import { RichEditable, RichTextView, ATTACHMENT_ACCEPT, ATTACHMENT_EXTS, attachmentFileError } from '../components/TicketRichText'
import { CcChips, CcSelectModal, ccKey } from '../components/CcPicker'
import { validateIPExpression } from '../utils/ipValidation'

const STATUS_META = {
  processing: { label: '进行中', cls: 'bg-blue-500/10 text-blue-500', Icon: Clock },
  completed: { label: '已完成', cls: 'bg-emerald-500/10 text-emerald-500', Icon: CheckCircle2 },
  cancelled: { label: '已取消', cls: 'bg-muted text-muted-foreground', Icon: XCircle },
}
const PRIORITY_META = {
  low: { label: '低', cls: 'bg-muted text-muted-foreground' },
  medium: { label: '中', cls: 'bg-blue-500/10 text-blue-500' },
  high: { label: '高', cls: 'bg-amber-500/10 text-amber-500' },
  critical: { label: '紧急', cls: 'bg-red-500/10 text-red-500' },
}
const ACTION_META = {
  create: { label: '发起工单', cls: 'bg-primary/10 text-primary', dot: 'border-primary' },
  submit: { label: '提交流转', cls: 'bg-emerald-500/10 text-emerald-500', dot: 'border-emerald-500' },
  cancel: { label: '取消工单', cls: 'bg-red-500/10 text-red-500', dot: 'border-red-500' },
  rollback: { label: '退回上一步', cls: 'bg-amber-500/10 text-amber-500', dot: 'border-amber-500' },
  urge: { label: '催办', cls: 'bg-amber-500/10 text-amber-500', dot: 'border-amber-500' },
  transfer: { label: '转办', cls: 'bg-sky-500/10 text-sky-500', dot: 'border-sky-500' },
  claim: { label: '认领', cls: 'bg-violet-500/10 text-violet-500', dot: 'border-violet-500' },
  comment: { label: '评论', cls: 'bg-muted text-muted-foreground', dot: 'border-muted-foreground/50' },
  device_action: { label: '设备动作', cls: 'bg-cyan-500/10 text-cyan-500', dot: 'border-cyan-500' },
}
// 设备异步执行状态：排队/执行中/成功/失败/已撤销（旧记录无 status 时按 success 兼容）
const DEVICE_RUN_STATUS = {
  queued: { label: '排队中', cls: 'bg-amber-500/10 text-amber-600' },
  running: { label: '执行中', cls: 'bg-sky-500/10 text-sky-600' },
  success: { label: '已下发', cls: 'bg-emerald-500/10 text-emerald-600' },
  failed: { label: '下发失败', cls: 'bg-red-500/10 text-red-600' },
  compensated: { label: '已撤销', cls: 'bg-muted text-muted-foreground' },
}

// 节点 device_result 兼容读取：新记录 {"items":[...]}，旧记录单对象
const deviceItemsOfRecord = (record) => {
  const data = record?.device_result
  if (!data) return []
  return Array.isArray(data.items) ? data.items : [data]
}
// 状态兼容：旧记录没有 status，按 success 判断
const deviceRunStatus = (item) => item?.status || (item?.success === false ? 'failed' : 'success')
const deviceRunPending = (item) => ['queued', 'running'].includes(deviceRunStatus(item))
// 设备参数默认值模板：预览按工单上下文实时解析，不把解析结果冻进提交参数
const DEVICE_TEMPLATE_VAR_RE = /\{(ticket_no|ticket_title|creator|node|f:[A-Za-z0-9_]+)\}/g

// 设备参数预览：字段上下文 = 历史记录 + 当前表单（本次值按 key 出现即覆盖历史）
const deviceTemplateContext = (ticket, values) => {
  const fields = {}
  ;(ticket?.records || []).forEach((r) => {
    Object.entries(r.field_values || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== '') fields[k] = v
    })
  })
  Object.entries(values || {}).forEach(([k, v]) => { fields[k] = v })
  return {
    ticket_no: ticket?.ticket_no || '',
    ticket_title: ticket?.title || '',
    creator: ticket?.created_by_name || '',
    node: ticket?.current_node?.name || '',
    fields,
  }
}

const resolveDeviceTemplate = (template, ctx) => String(template || '').replace(DEVICE_TEMPLATE_VAR_RE, (_, key) => {
  const value = key.startsWith('f:') ? (ctx?.fields || {})[key.slice(2)] : ctx?.[key]
  return value === undefined || value === null ? '' : String(value)
})

// 自定义时长统一按秒输入：把 -1/永久/3天/259200 等存量或预设值换算成秒展示
const DURATION_UNIT_SECONDS = { 分钟: 60, 小时: 3600, 天: 86400 }
const durationValueToSeconds = (value) => {
  const s = String(value ?? '').trim()
  if (!s) return ''
  // -1 = 永久；其余负数非法，留空让用户重新填写
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (n === -1) return '-1'
    return n > 0 ? String(n) : ''
  }
  const parts = durationToParts(s)
  if (parts.permanent) return '-1'
  if (!parts.num || Number.isNaN(Number(parts.num))) return ''
  return String(Number(parts.num) * (DURATION_UNIT_SECONDS[parts.unit] || 1))
}

const initialDeviceParams = (form, records) => {
  const prior = {}
  ;(records || []).forEach((r) => {
    Object.entries(r.field_values || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== '') prior[k] = v
    })
  })
  // 字段值只经旧版参数映射（参数名 → 字段 key）或默认值模板进入设备参数，
  // 不再用同名历史字段兜底，避免历史 reason 之类的字段盖掉模板
  const fieldMap = form?.param_field_map || {}
  const init = {}
  ;(form?.params || []).forEach((p) => {
    const mapped = fieldMap[p.name]
    if (mapped && prior[mapped] !== undefined) init[p.name] = prior[mapped]
    else if (p.default !== undefined && p.default !== null && String(p.default) !== '') init[p.name] = p.default
    else init[p.name] = ''
  })
  return init
}

// 流转记录 comment 的显示标题（按动作区分语义）
const ACTION_COMMENT_LABELS = {
  create: '发起备注', submit: '处置意见', cancel: '取消原因', rollback: '回退原因',
  transfer: '转办原因', comment: '评论内容',
}

// 字段值只读展示（KV 行）
function FieldValueView({ field, value }) {
  if (field?.type === 'file' && value) {
    const url = attachmentUrl(value)
    const name = decodeURIComponent(String(value).split('/').pop() || '附件')
    // 附件一律提供下载（download 属性同源强制下载，不在线预览）
    return (
      <a href={url} download={name}
        className="inline-flex max-w-full items-center gap-1 truncate text-sm text-primary hover:underline">
        <Paperclip className="h-3.5 w-3.5 shrink-0" />{name}
        <Download className="h-3 w-3 shrink-0 opacity-70" />
      </a>
    )
  }
  // textarea 值含图片引用（![x](url)）时按富文本渲染
  if (field?.type === 'textarea' && typeof value === 'string' && value.includes('](')) {
    return <RichTextView text={value} />
  }
  return <span className="break-all text-sm text-foreground">{fieldValueText(field, value)}</span>
}

// 威胁情报严重程度中文
const THREAT_SEVERITY_LABELS = { high: '高', medium: '中', low: '低' }

// 自动研判单来源块：资产匹配 + 威胁情报全量字段逐项展示（空值统一显示 --）
function EnrichRow({ label, children }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  )
}

// 智能体研判结果展示映射：风险等级徽章配色 + 处置动作中文
const AGENT_RISK_CLS = {
  严重: 'bg-red-500/10 text-red-500', 高危: 'bg-red-500/10 text-red-500', 高: 'bg-red-500/10 text-red-500',
  中危: 'bg-amber-500/10 text-amber-500', 中: 'bg-amber-500/10 text-amber-500',
  低危: 'bg-sky-500/10 text-sky-500', 低: 'bg-sky-500/10 text-sky-500',
}
const AGENT_ACTION_LABELS = { ban: '建议封禁', monitor: '观察监控', ignore: '忽略（暂不处置）' }

// 决策依据兜底：reasons 非数组（字符串/空）时的展示文本
function fmtAgentReasonText(reasons) {
  if (Array.isArray(reasons)) return reasons.length ? null : '--'
  if (reasons == null || reasons === '') return '--'
  return String(reasons)
}

// 资产字段中文映射
const ASSET_CRITICALITY_LABELS = { low: '低', medium: '中', high: '高', critical: '严重' }
const ASSET_STATUS_LABELS = { in_use: '在用', idle: '闲置', repair: '维修', retired: '报废', lost: '丢失' }
const ASSET_SOURCE_LABELS = { kb_ingest: '知识库梳理', manual: '手动录入', agent_add: '对话录入' }

// 资产字段值格式化：数组连接、对象序列化；空值返回 null（展示时显示 --）
function fmtAssetVal(v) {
  if (v == null || v === '') return null
  if (Array.isArray(v)) return v.length ? v.map(String).join('、') : null
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// 资产匹配结果字段网格：标准字段 + 自定义字段（extra_fields 逐项）+ 标签，全字段展示
function AssetMatchFields({ asset, fallbackIp }) {
  const na = <span className="text-muted-foreground">--</span>
  const f = asset.fields
  const rows = []
  const push = (label, v) => {
    const text = fmtAssetVal(v)
    rows.push([label, text])
  }
  if (f) {
    push('资产类型', f.asset_type)
    push('IP 地址', f.ip || asset.asset_ip || fallbackIp)
    push('所属部门', f.department)
    push('负责人', f.owner)
    push('位置', f.location)
    push('重要性', f.criticality ? (ASSET_CRITICALITY_LABELS[f.criticality] || f.criticality) : null)
    push('状态', f.status ? (ASSET_STATUS_LABELS[f.status] || f.status) : null)
    push('来源', f.source ? (ASSET_SOURCE_LABELS[f.source] || f.source) : null)
    push('来源知识库', f.kb_name)
    // 自定义字段逐项展示（extra_fields 为对象）
    const extra = f.extra_fields && typeof f.extra_fields === 'object' && !Array.isArray(f.extra_fields) ? f.extra_fields : {}
    Object.entries(extra).forEach(([k, v]) => push(k, v))
  } else {
    // 旧结构工单（enrichment_data 无 fields）：退回冗余键展示基本信息
    push('IP 地址', asset.asset_ip || fallbackIp)
  }
  const tags = f?.tags || []
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
      {rows.map(([label, text]) => (
        <div key={label} className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 text-muted-foreground">{label}：</span>
          <span className="min-w-0 break-all">{text != null ? text : na}</span>
        </div>
      ))}
      <div className="col-span-2 flex min-w-0 items-start gap-2">
        <span className="shrink-0 text-muted-foreground">标签：</span>
        {tags.length ? (
          <span className="flex min-w-0 flex-wrap gap-1">
            {tags.map((tg) => (
              <span key={tg.id} className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{tg.name}</span>
            ))}
          </span>
        ) : na}
      </div>
    </div>
  )
}

// 资产发现命中字段展示映射（compact 结构通用字段；缺省键自动显示 --）
const DISCOVERY_FIELD_LABELS = [
  ['资源类型', 'resource_label'],
  ['实例名称', 'instance_name'],
  ['IP 地址', 'ip_address'],
  ['浮动 IP', 'floatip_address'],
  ['网段', 'cidr'],
  ['所属部门', 'user_department'],
  ['申请部门', 'applicant_department'],
  ['操作系统', 'operating_system'],
  ['主机状态', 'host_status'],
  ['资源区域', 'biz_region_name'],
  ['带宽(M)', 'bandwidth'],
  ['绑定实例', 'bind_instance'],
  ['CMDB ID', 'cmdb_id'],
  ['实例 ID', 'instance_id'],
  ['唯一标识', 'source_id'],
]

// 数据来源标签配色：浅底深字（80% 透明浅底 + 高对比文字），
// 资产发现用青绿、资产清单用主色，两来源并列时一眼可辨且不喧宾夺主
const SOURCE_TONES = {
  discovery: {
    box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
    dot: 'bg-emerald-500',
    accent: 'border-l-emerald-500/70',
  },
  inventory: {
    box: 'border-primary/30 bg-primary/10 text-primary',
    dot: 'bg-primary',
    accent: 'border-l-primary/70',
  },
}

// 数据来源标签：着重展示「资产发现-裸金属资产」「资产清单-A会保持在线系统清单」
// 这类到清单颗粒度的来源，避免处理人只看到笼统的「资产发现 / 资产清单」
function SourceLabel({ tone = 'inventory', sm = false, children }) {
  const c = SOURCE_TONES[tone] || SOURCE_TONES.inventory
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded border font-semibold ${
        sm ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'
      } ${c.box}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
      <span className="min-w-0 break-all">{children}</span>
    </span>
  )
}

// 资产发现匹配结果展示：asset 为 discovery 命中结构（matches 多命中逐条展示）
function DiscoveryMatchFields({ asset, fallbackIp }) {
  const na = <span className="text-muted-foreground">--</span>
  const matches = Array.isArray(asset.matches) && asset.matches.length ? asset.matches : [asset]
  const multi = matches.length > 1
  return (
    <div className="space-y-2">
      {matches.map((m, idx) => (
        <div
          key={m.source_id || m.cmdb_id || idx}
          className={multi ? 'rounded border border-border/60 bg-background/60 p-2' : ''}
        >
          {/* 多命中可能跨资源类型：逐条标注各自的详细来源 */}
          {multi ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <SourceLabel tone="discovery" sm>
                {m.source_label || m.resource_label || '资产发现'}
              </SourceLabel>
              <span className="text-[11px] text-muted-foreground">#{idx + 1}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
            {DISCOVERY_FIELD_LABELS.map(([label, key]) => {
              const raw = m[key] ?? (key === 'ip_address' ? (asset.asset_ip || fallbackIp) : null)
              const text = fmtAssetVal(raw)
              return (
                <div key={key} className="flex min-w-0 items-start gap-2">
                  <span className="shrink-0 text-muted-foreground">{label}：</span>
                  <span className="min-w-0 break-all">{text != null ? text : na}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {asset.truncated ? (
        <div className="text-xs text-muted-foreground">命中较多，仅展示前 {matches.length} 条，完整数据请点击资产名跳转资产发现查看</div>
      ) : null}
    </div>
  )
}

function EnrichSourceView({ s, onFill }) {
  const t = s.threat
  const geo = t?.geo_info || {}
  const geoText = [geo.country, geo.region, geo.city, geo.isp].filter(Boolean).join(' / ')
  const na = <span className="text-muted-foreground">--</span>
  const fmtTime = (v) => (v ? String(v).replace('T', ' ') : na)
  // 资产匹配来源：资产发现优先并列展示；旧结构工单（无 discovery/inventory
  // 键）按 asset.source 判定来源，缺失时按资产清单处理
  const assetMatch = s.asset || {}
  const legacyOnly = !assetMatch.discovery && !assetMatch.inventory
  const legacyTone = legacyOnly && assetMatch.source === 'asset_discovery' ? 'discovery' : 'inventory'
  const legacyLabel = legacyTone === 'discovery' ? '资产发现' : '资产清单'
  const inventoryAsset = assetMatch.inventory || (legacyOnly ? assetMatch : null)
  const inventoryLabel = assetMatch.inventory?.source_label || assetMatch.source_label || legacyLabel
  return (
    <div className="rounded-md border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="whitespace-nowrap rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{s.label || s.role}</span>
        <span className="font-mono text-sm font-medium text-foreground">{s.ip}</span>
        {t?.is_malicious ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
            <AlertTriangle className="h-3 w-3" />恶意
          </span>
        ) : t ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
            <ShieldCheck className="h-3 w-3" />非恶意
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">威胁情报查询失败</span>
        )}
      </div>
      {/* 资产匹配 / 威胁情报 / 智能体研判分区展示（窄屏自动上下排列） */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* 资产匹配子卡：资产发现与资产清单两来源都查，发现优先、并列展示 */}
        <div className="min-w-0 rounded-md border border-border bg-secondary p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
            <Database className="h-3.5 w-3.5 shrink-0 text-primary" />资产匹配
            {s.asset?.matched ? (
              s.asset.source === 'asset_discovery' ? (
                <Link
                  to={`/assets/discovery?keyword=${encodeURIComponent(s.asset.asset_ip || s.ip)}${s.asset.resource_type ? `&table=${encodeURIComponent(s.asset.resource_type)}` : ''}`}
                  onClick={(e) => { if (!guardNavPermission('asset_discovery', 'view', '资产发现')) e.preventDefault() }}
                  className="min-w-0 break-all font-normal text-primary hover:underline"
                  title={`在资产发现中查看：${s.asset.asset_name || '--'}（${s.asset.asset_ip || s.ip}）`}
                >
                  {s.asset.asset_name || '--'}
                </Link>
              ) : (
                <Link
                  to={`/assets/list?keyword=${encodeURIComponent(s.asset.asset_ip || s.ip)}`}
                  onClick={(e) => { if (!guardNavPermission('asset_list', 'view', '资产清单')) e.preventDefault() }}
                  className="min-w-0 break-all font-normal text-primary hover:underline"
                  title={`在资产清单中查看：${s.asset.asset_name || '--'}（${s.asset.asset_ip || s.ip}）`}
                >
                  {s.asset.asset_name || '--'}
                </Link>
              )
            ) : (
              <span className="font-normal text-muted-foreground">资产库未匹配</span>
            )}
          </div>
          {s.asset?.matched ? (
            <div className="space-y-2.5">
              {/* 资产发现结果（优先）：头部着重展示详细数据来源 */}
              {assetMatch.discovery ? (
                <div className={`min-w-0 rounded-md border border-border/60 border-l-2 bg-background/50 p-2.5 ${SOURCE_TONES.discovery.accent}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <SourceLabel tone="discovery">
                      {assetMatch.discovery.source_label || '资产发现'}
                    </SourceLabel>
                  </div>
                  <DiscoveryMatchFields asset={assetMatch.discovery} fallbackIp={s.ip} />
                </div>
              ) : null}
              {/* 资产清单结果：命中时展示资产全部字段（旧结构工单无
                  discovery/inventory 键，退回 asset 本体渲染） */}
              {inventoryAsset ? (
                <div className={`min-w-0 rounded-md border border-border/60 border-l-2 bg-background/50 p-2.5 ${SOURCE_TONES[legacyTone].accent}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <SourceLabel tone={legacyTone}>{inventoryLabel}</SourceLabel>
                  </div>
                  <AssetMatchFields asset={inventoryAsset} fallbackIp={s.ip} />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">资产发现与资产清单中均未找到与该 IP 匹配的资产</div>
          )}
        </div>
        {/* 威胁情报子卡：查询结果全量字段 */}
        <div className="min-w-0 rounded-md border border-border bg-secondary p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-primary" />威胁情报
          </div>
          {t ? (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
                <EnrichRow label="研判结论：">
                  {t.is_malicious
                    ? <span className="font-medium text-red-500">恶意</span>
                    : <span className="font-medium text-emerald-500">非恶意</span>}
                </EnrichRow>
                <EnrichRow label="置信度：">
                  {t.confidence != null ? `${Math.round(t.confidence * 100)}%` : na}
                </EnrichRow>
                <EnrichRow label="严重程度：">
                  {t.severity ? (THREAT_SEVERITY_LABELS[t.severity] || t.severity) : na}
                </EnrichRow>
                <EnrichRow label="威胁标签：">
                  {t.tags?.length ? (
                    <span className="flex flex-wrap gap-1">
                      {t.tags.map((tag) => (
                        <span key={tag} className="whitespace-nowrap rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-500">{tag}</span>
                      ))}
                    </span>
                  ) : na}
                </EnrichRow>
                <EnrichRow label="威胁类型：">
                  {t.threat_types?.length ? t.threat_types.join('、') : na}
                </EnrichRow>
                <EnrichRow label="首次发现：">{fmtTime(t.first_seen)}</EnrichRow>
                <EnrichRow label="最近发现：">{fmtTime(t.last_seen)}</EnrichRow>
                <EnrichRow label="地理/归属：">{geoText || na}</EnrichRow>
                <EnrichRow label="关联恶意软件：">
                  {t.related_malware?.length ? t.related_malware.join('、') : na}
                </EnrichRow>
                <EnrichRow label="情报来源：">{t.source || na}</EnrichRow>
                <EnrichRow label="攻击模式：">
                  {t.attack_patterns?.length ? t.attack_patterns.join('；') : na}
                </EnrichRow>
              </div>
              <div className="mt-2 flex min-w-0 items-start gap-2 text-[13px]">
                <span className="shrink-0 text-muted-foreground">情报描述：</span>
                {t.description
                  ? <span className="min-w-0 break-all rounded-md bg-muted px-3 py-1.5 leading-relaxed text-foreground">{t.description}</span>
                  : na}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted-foreground">威胁情报查询失败</div>
          )}
        </div>
        {/* 智能体研判子卡：仅 auto_agent 开启的 IP 生成；占满整行，内部两列。
            只展示风险等级 / 处置建议 / 决策依据，处置结果不落库不展示；
            pending 为后台研判中（发起不阻塞，完成后轮询自动更新） */}
        {s.agent !== undefined && (
          <div className="min-w-0 rounded-md border border-border bg-secondary p-3 xl:col-span-2">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Bot className="h-3.5 w-3.5 text-primary" />智能体研判
              <span className="font-normal text-muted-foreground">IP风险智能研判与封禁决策</span>
              {onFill && s.agent && !s.agent.pending && (
                <button type="button" onClick={() => onFill(s)}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 text-[11px] font-normal text-primary transition hover:bg-primary/10"
                  title="将智能体研判结果一键填入处理意见，可编辑后提交">
                  <Sparkles className="h-3 w-3" />填入处置意见
                </button>
              )}
            </div>
            {s.agent?.pending ? (
              <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                <span className="flex items-end gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
                </span>
                智能体正在思考中，研判结果将自动更新…
              </div>
            ) : s.agent ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] xl:grid-cols-2">
                <div className="grid content-start gap-y-1.5">
                  <EnrichRow label="风险等级：">
                    <span className={`inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${AGENT_RISK_CLS[s.agent.risk_level] || 'bg-muted text-muted-foreground'}`}>
                      {s.agent.risk_level || '未知'}
                    </span>
                  </EnrichRow>
                  <EnrichRow label="处置建议：">
                    <span>
                      {AGENT_ACTION_LABELS[s.agent.action] || s.agent.action || na}
                      {s.agent.monitoring_advice ? `（${s.agent.monitoring_advice}）` : ''}
                    </span>
                  </EnrichRow>
                </div>
                <EnrichRow label="决策依据：">
                  {Array.isArray(s.agent.reasons) && s.agent.reasons.length ? (
                    <ul className="list-disc space-y-1 pl-5">
                      {s.agent.reasons.map((r, i) => <li key={i} className="break-all">{String(r)}</li>)}
                    </ul>
                  ) : (
                    <span className="text-muted-foreground">{fmtAgentReasonText(s.agent.reasons)}</span>
                  )}
                </EnrichRow>
              </div>
            ) : (
              <div className="text-[13px] text-muted-foreground">智能体研判失败</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 自动研判卡片：发起时对 src_ip/dst_ip 按字段开关执行资产匹配（auto_asset）、
// 威胁情报查询（auto_intel）与智能体研判（auto_agent），随工单流转只读展示
function EnrichmentView({ enrichment, onFill }) {
  if (!enrichment?.sources?.length) return null
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <span className="font-semibold text-foreground">安全上下文（自动研判）</span>
        <span className="text-xs text-muted-foreground">发起时按字段开关自动执行资产匹配、威胁情报查询与智能体研判，随工单流转只读展示</span>
        {enrichment.enriched_at && (
          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            研判时间：{new Date(enrichment.enriched_at).toLocaleString('zh-CN', { hour12: false })}
          </span>
        )}
      </div>
      <div className="space-y-3">
        {enrichment.sources.map((s) => <EnrichSourceView key={`${s.role}-${s.ip}`} s={s} onFill={onFill} />)}
      </div>
      {!!enrichment.errors?.length && (
        <div className="mt-2 break-all text-xs text-amber-500">部分研判失败：{enrichment.errors.join('；')}</div>
      )}
    </div>
  )
}

// 封禁剩余时长格式化（毫秒 → X天X小时 / X小时X分 / X分钟）
function fmtBanRemaining(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d) return `${d}天${h}小时`
  if (h) return `${h}小时${mm}分`
  return `${mm}分钟`
}

// 安博通黑名单条目字段中文标签（未列出的键原样展示键名，保证设备新字段也能看到）
const ANBOTONG_ENTRY_LABELS = {
  blist: '黑名单条目', age: '封禁时长', leftTime: '剩余时长', effectTime: '生效时间',
  reason: '封禁原因', policy_group_name: '策略组', state: '状态', enable: '启用',
  hit_num: '命中次数', node_id: '节点 ID',
}

// 安博通条目字段值格式化：age/leftTime 秒值转中文时长（-1 为永久）；enable 0/1 转启用/停用
function fmtBanEntryVal(key, v) {
  if (v == null || v === '') return <span className="text-muted-foreground">--</span>
  if (key === 'age' || key === 'leftTime') {
    const n = Number(v)
    if (!Number.isNaN(n)) return n < 0 ? '永久' : fmtBanRemaining(n * 1000)
  }
  if (key === 'enable') return v === 1 || v === '1' || v === true ? '启用' : '停用'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// 安全上下文 · 封禁查询：进入 Tab 自动查询工单涉及的 IP（安博通阻断器「查询指定黑名单」实时查询）
function BanStatusView({ autoIps }) {
  const [query, setQuery] = useState(autoIps.join('，'))
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  // 请求序号 + 卸载守卫：连续查询时慢的旧响应不覆盖新结果；切 Tab 卸载后不再 setState
  const reqSeq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const doQuery = useCallback((ipsStr) => {
    const ips = [...new Set(String(ipsStr).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean))]
    if (!ips.length) return
    if (ips.length > 20) return toast.error('单次最多查询 20 个 IP')
    const seq = ++reqSeq.current
    const ok = () => mounted.current && reqSeq.current === seq
    setLoading(true)
    ticketApi.banStatus(ips)
      .then((res) => { if (ok()) setResult(res) })
      .catch((e) => { if (ok()) toast.error(e.message || '查询封禁状态失败') })
      .finally(() => { if (ok()) setLoading(false) })
  }, [])
  useEffect(() => { if (autoIps.length) doQuery(autoIps.join(',')) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const results = result && result.results ? Object.entries(result.results) : []
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldBan className="h-4 w-4 text-primary" />
        <span className="font-semibold text-foreground">封禁状态查询（安博通阻断器）</span>
        <span className="text-xs text-muted-foreground">通过安博通阻断器「查询指定黑名单」动作实时查询设备侧黑名单信息</span>
      </div>
      {result?.device && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />{result.device.name}
          </span>
          <span>共查询 {results.length} 个 IP，封禁中 {results.filter(([, st]) => st.banned).length} 个</span>
        </div>
      )}
      {result?.device_error && (
        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[13px] text-amber-600">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />安博通阻断器不可用
          </div>
          <p className="mt-1 break-all">{result.device_error}</p>
        </div>
      )}
      <div className="mb-3 flex gap-2">
        <input className={inputCls} placeholder="输入 IP 地址，多个 IP 用逗号分隔"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) doQuery(query) }} />
        <Button size="sm" className="shrink-0" loading={loading} disabled={!query.trim()} onClick={() => doQuery(query)}>
          <Search className="mr-1 h-3.5 w-3.5" />查询
        </Button>
      </div>
      {!result && !loading && (
        <p className={hintCls}>{autoIps.length ? '正在自动查询工单涉及的 IP…' : '暂无自动查询的 IP，可手动输入 IP 查询封禁状态'}</p>
      )}
      {!!results.length && (
        <div className="space-y-2">
          {results.map(([ip, st]) => (
            <div key={ip} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">{ip}</span>
                {st.banned ? (
                  <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-500">封禁中</span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">未封禁</span>
                )}
                {st.error && <span className="text-xs text-red-500">查询失败：{st.error}</span>}
                {!st.error && st.note && <span className="text-xs text-amber-600">{st.note}</span>}
              </div>
              {st.entry ? (
                <div className="mt-2 rounded-md bg-muted p-2.5 text-[13px]">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {Object.entries(st.entry).map(([k, v]) => (
                      <div key={k} className="flex min-w-0 items-start gap-2">
                        <span className="shrink-0 text-muted-foreground">{ANBOTONG_ENTRY_LABELS[k] || k}：</span>
                        <span className="min-w-0 break-all text-foreground">{fmtBanEntryVal(k, v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (!st.error && (
                <p className="mt-1.5 text-[13px] text-muted-foreground">设备上未找到该 IP 的黑名单条目</p>
              ))}
              {st.raw != null && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">设备原始响应</summary>
                  <pre className="mt-1 max-h-56 overflow-auto rounded bg-muted p-2 text-xs leading-relaxed text-foreground">{JSON.stringify(st.raw, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TicketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const canDelete = hasPermission('ticket', 'delete')

  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [values, setValues] = useState({})
  const [routeTo, setRouteTo] = useState('')
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  // 回退上一步：弹窗 + 必填原因
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [rollbackReason, setRollbackReason] = useState('')
  const [rollbackTarget, setRollbackTarget] = useState('')
  const [rollingBack, setRollingBack] = useState(false)
  const [uploadingKey, setUploadingKey] = useState('')
  // 详情页 Tab：工单详情（流转历史）/ 安全上下文（自动研判）
  const [activeTab, setActiveTab] = useState('detail')
  // 抄送选择弹窗开关
  const [ccPickerOpen, setCcPickerOpen] = useState(false)
  // 催办（发起人/抄送人/admin 对处理中工单一键提醒当前节点分组）
  const [urging, setUrging] = useState(false)
  // 组内认领锁定（认领后本节点仅认领人/admin 可提交）
  const [claiming, setClaiming] = useState(false)
  // 转办/改派（当前节点处理人 → 其他分组或指定人）
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTarget, setTransferTarget] = useState('') // 'group:{id}' | 'user:{id}'
  const [transferReason, setTransferReason] = useState('')
  const [transferring, setTransferring] = useState(false)
  const [transferOptions, setTransferOptions] = useState({ users: [], groups: [] })
  // 时间线内部评论（区别于处置意见）
  const [commentDraft, setCommentDraft] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [actionParams, setActionParams] = useState({})
  const [deviceMissing, setDeviceMissing] = useState([])
  const [deviceIpErrors, setDeviceIpErrors] = useState({})
  // 设备参数"自定义"模式（token = `${item.index}:${param.name}`）：点开自定义后保持原输入控件可见
  const [deviceCustom, setDeviceCustom] = useState({})
  // 处理人手动改过的设备参数（index → 参数名列表），随提交告知服务端优先用用户输入
  const [deviceOverrides, setDeviceOverrides] = useState({})
  // 设备动作异步交互忙碌态：`${runId}:retry|compensate`、`batch:retry`
  const [deviceBusy, setDeviceBusy] = useState({})

  const load = useCallback(() => {
    setLoading(true)
    ticketApi.getTicket(id)
      .then((res) => {
        setTicket(res)
        // 初始化当前节点表单（含匹配规则下的扩展字段 default）
        if (res.can_handle && res.current_node) {
          const init = {}
          flatFieldDefs(res.current_node.fields).forEach((f) => {
            let v = f.default ?? ''
            if (f.type === 'switch') v = v === true || v === 'true' || v === '是'
            init[f.key] = v
          })
          setValues(init)
          const { options, suggested } = evalRoutes(res.current_node.routes, init)
          setRouteTo(suggested || (options.length === 1 ? options[0].to : '') || '')
          setComment('')
          setActionParams({})
          setDeviceMissing([])
          setDeviceIpErrors({})
          setDeviceCustom({})
          setDeviceOverrides({})
        }
      })
      .catch((e) => toast.error(e.message || '加载工单失败'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  // 静默刷新：只更新 ticket 数据，不重置当前节点表单/意见（轮询、手动刷新共用）
  const refreshTicketSilently = useCallback(() => {
    ticketApi.getTicket(id)
      .then((res) => setTicket(res))
      .catch(() => {})
  }, [id])

  // 智能体研判后台进行中（agent.pending）：静默轮询刷新研判结果
  //（只更新 ticket，不重置当前节点表单/意见，完成后停止轮询）
  const hasPendingAgent = useMemo(
    () => (ticket?.enrichment_data?.sources || []).some((s) => s?.agent?.pending),
    [ticket],
  )
  // 设备动作异步执行中（排队/执行中）：轮询刷新时间线状态，完成后自动停止
  const hasPendingDeviceRun = useMemo(() => {
    if (Number(ticket?.pending_device_runs || 0) > 0) return true
    return (ticket?.records || []).some((r) => deviceItemsOfRecord(r).some(deviceRunPending))
  }, [ticket])
  // 全工单设备执行条目：用于把撤销记录关联回原封禁记录
  const allDeviceItems = useMemo(
    () => (ticket?.records || []).flatMap(deviceItemsOfRecord),
    [ticket],
  )
  // 异步完成提醒：轮询发现“排队/执行中 → 成功/失败”时给一次 toast，避免用户长时间等待无反馈
  const deviceRunStatusRef = useRef(new Map())
  useEffect(() => {
    const itemById = new Map()
    const next = new Map()
    allDeviceItems.forEach((it) => {
      if (it?.run_id && (it.action_name || it.device_name)) {
        itemById.set(String(it.run_id), it)
        next.set(String(it.run_id), deviceRunStatus(it))
      }
    })
    const prev = deviceRunStatusRef.current
    if (prev.size) {
      const finished = []
      next.forEach((status, runId) => {
        const before = prev.get(runId)
        if (before && deviceRunPending({ status: before }) && !deviceRunPending({ status })) {
          finished.push({ status, item: itemById.get(runId) })
        }
      })
      if (finished.length) {
        const comps = finished.filter((f) => f.item?.kind === 'compensate')
        const execs = finished.filter((f) => f.item?.kind !== 'compensate')
        const compOk = comps.filter((f) => f.status !== 'failed').length
        const compFail = comps.filter((f) => f.status === 'failed').length
        const execOk = execs.filter((f) => f.status !== 'failed').length
        const execFail = execs.filter((f) => f.status === 'failed').length
        if (execOk) toast.success(`设备动作执行完成：${execOk} 个成功`)
        if (execFail) toast.error(`设备动作执行失败：${execFail} 个，可在流转历史中重试`)
        if (compOk) toast.success(`封禁撤销完成：${compOk} 个`)
        if (compFail) toast.error(`封禁撤销失败：${compFail} 个，可在流转历史中重试`)
      }
    }
    deviceRunStatusRef.current = next
  }, [allDeviceItems])
  useEffect(() => {
    if (!hasPendingAgent && !hasPendingDeviceRun) return undefined
    const timer = setInterval(refreshTicketSilently, 5000)
    return () => clearInterval(timer)
  }, [hasPendingAgent, hasPendingDeviceRun, refreshTicketSilently])

  const snapshot = ticket?.flow_snapshot || {}
  const nodes = snapshot.nodes || []
  const currentNode = ticket?.current_node
  const { options: routeOptions, suggested: routeSuggested } = useMemo(
    () => evalRoutes(currentNode?.routes, values),
    [currentNode, values],
  )
  // 条件路由锁定：填写的字段值命中路由条件时（如「是否需要处置=是」→ 应急处置），
  // 去向强制为该条件路由（按钮禁用不可改选，后端 _resolve_route 同步强制校验）；
  // 无建议时一律清空（含单路由节点）：跨节点流转后残留上一个节点的选择
  // （如研判分析的 n_emergency）会把本节点不存在/自身 key 当作去向提交，被后端白名单拒绝
  useEffect(() => {
    if (routeSuggested) {
      setRouteTo(routeSuggested)
      return
    }
    // 残留的 routeTo 不在当前节点可选项内（节点切换后的旧值）时清空，避免误流转：
    // 上一节点条件路由锁定的去向（如 n_emergency）流转后残留，单路由节点不清空会被
    // 直接提交，后端白名单校验拒绝（"流转去向 X 不在节点的路由白名单内"）
    setRouteTo((cur) => (cur && routeOptions.some((r) => r.to === cur) ? cur : ''))
  }, [routeSuggested, routeOptions])
  const currentFields = currentNode?.fields || []
  // 匹配规则：顶层字段 + 当前值命中规则展开的扩展字段（必填校验/提交同步使用该集合）
  const renderFields = useMemo(() => {
    const out = []
    for (const f of currentFields) {
      out.push({ field: f, ext: false })
      matchedRuleFields(f, values[f.key]).forEach((rf) => out.push({ field: rf, ext: true }))
    }
    return out
  }, [currentFields, values]) // eslint-disable-line react-hooks/exhaustive-deps

  // 设备参数默认值模板预览上下文（历史记录 + 当前表单）
  const devicePreviewCtx = useMemo(
    () => deviceTemplateContext(ticket, values),
    [ticket, values],
  )

  // 设备动作判断字段实时联动：判断字段为本节点字段时，按处理人当前填写值决定是否调用设备
  // （填了「是」→ 立即出现参数表单；改回「否」→ 收起）；判断字段引用前面节点（存量模板）
  // 时，当前表单没有该字段，回退后端按历史记录计算的结果
  // 开关字段在表单里是布尔值（true/false），与后端 _normalize_cond_value 同口径归一化为 是/否 再比较
  const normDeviceVal = (v) => {
    if (v === true || String(v) === 'true' || String(v) === 'True') return '是'
    if (v === false || String(v) === 'false' || String(v) === 'False') return '否'
    return v
  }
  const liveDeviceExecute = (it) => {
    if (!it) return false
    if (!it.judge_field) return !!it.execute
    const cur = values[it.judge_field]
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') {
      return String(normDeviceVal(cur)) === String(it.judge_value || '是')
    }
    return !!it.execute
  }
  const liveDeviceActual = (it) => {
    const cur = it?.judge_field ? values[it.judge_field] : undefined
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') return String(normDeviceVal(cur))
    return it?.judge_actual || ''
  }
  // 本次提交命中建议执行值：无独立设备执行权限（ticket:execute）时禁止提交流转
  const deviceNeedsPermission = (ticket?.device_action_form?.items || []).some((it) => liveDeviceExecute(it))

  // 联动字段刚展开时自动定位并聚焦：如「是否需要处置」选「是」后出现必填的「处置建议」，
  // 避免处理人仍按原位置点击提交、实际漏填被拦截却以为"没有反应"
  const prevExtKeysRef = useRef(null)
  useEffect(() => {
    const keys = new Set(renderFields.filter(({ ext }) => ext).map(({ field: f }) => f.key))
    if (prevExtKeysRef.current) {
      const added = [...keys].filter((k) => !prevExtKeysRef.current.has(k))
      if (added.length) {
        requestAnimationFrame(() => {
          const box = document.querySelector(`[data-fkey="${added[0]}"]`)
          if (!box) return
          box.scrollIntoView({ behavior: 'smooth', block: 'center' })
          box.querySelector('input:not([type="radio"]), textarea, select, [contenteditable="true"]')
            ?.focus({ preventScroll: true })
        })
      }
    }
    prevExtKeysRef.current = keys
  }, [renderFields])

  // 引用联动字段选项：本工单已提交记录值 + 本次提交值（与后端 advance_ticket 口径一致）
  const refOpts = useMemo(
    () => collectRefOptions(ticket?.flow_snapshot, [...(ticket?.records || []), { field_values: values }]),
    [ticket, values],
  )

  // 工单涉及的 IP（安全上下文 Tab 自动封禁查询）：研判 IP + IP 类型字段已填的 IPv4 值
  const ticketIps = useMemo(() => {
    const out = []
    const push = (v) => {
      const s = String(v || '').trim()
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) && !out.includes(s)) out.push(s)
    }
    ;(ticket?.enrichment_data?.sources || []).forEach((s) => push(s.ip))
    const ipKeys = new Set()
    ;(ticket?.flow_snapshot?.nodes || []).forEach((n) => {
      flatFieldDefs(n.fields || []).forEach((f) => { if (f.type === 'ip') ipKeys.add(f.key) })
    })
    ;(ticket?.records || []).forEach((r) => {
      Object.entries(r.field_values || {}).forEach(([k, v]) => { if (ipKeys.has(k)) push(v) })
    })
    return out.slice(0, 20)
  }, [ticket])

  // 步骤条节点顺序：处理节点 + 结束
  const stepNodes = useMemo(() => {
    const tasks = nodes.filter((n) => n.type !== 'end')
    const endNode = nodes.find((n) => n.type === 'end')
    return endNode ? [...tasks, endNode] : tasks
  }, [nodes])

  const handledKeys = useMemo(
    () => new Set((ticket?.records || []).filter((r) => r.action !== 'cancel').map((r) => r.node_key)),
    [ticket],
  )

  // 必填校验：缺失字段红框高亮（输入后自动清除），提交时滚动定位到第一个缺失项
  const [missingKeys, setMissingKeys] = useState([])
  // IP 字段格式错误（与后端硬拦截口径一致）
  const [ipErrors, setIpErrors] = useState({})
  const setFieldValue = (key, v) => {
    setValues((s) => ({ ...s, [key]: v }))
    if (missingKeys.includes(key)) setMissingKeys((ks) => ks.filter((k) => k !== key))
    if (ipErrors[key]) setIpErrors((e) => ({ ...e, [key]: '' }))
  }
  // inputCls 自带 border-input，红框需 !important 覆盖（Tailwind 同特异性按生成顺序，destructive 会被 input 吃掉）
  const fieldCls = (f) => ((missingKeys.includes(f.key) || ipErrors[f.key])
    ? `${inputCls} !border-destructive ring-1 !ring-destructive`
    : inputCls)
  // 当前表单错误提示（提交被拦截后贴在按钮上方，避免只靠顶部 toast 被忽略）
  const formErrorText = useMemo(() => {
    const missing = missingKeys
      .map((k) => renderFields.find(({ field: f }) => f.key === k)?.field.label || k)
    const ipErrs = Object.entries(ipErrors).filter(([, v]) => v).map(([, v]) => v)
    const labels = [...new Set([...missing, ...ipErrs])]
    return labels.length ? `请先完善以下必填项：${labels.join('、')}` : ''
  }, [missingKeys, ipErrors, renderFields])

  const uploadFile = async (fkey, file) => {
    if (!file) return
    const err = attachmentFileError(file)
    if (err) return toast.error(err)
    setUploadingKey(fkey)
    try {
      const res = await ticketApi.uploadAttachment(file)
      setValues((s) => ({ ...s, [fkey]: res.url }))
      setMissingKeys((ks) => ks.filter((k) => k !== fkey))
      toast.success(`附件「${res.name}」已上传`)
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        toast.error('附件上传超时，请重试；请确认文件可正常读取且在 10MB 内')
      } else {
        toast.error(e.message || '附件上传失败')
      }
    } finally {
      setUploadingKey('')
    }
  }

  const handleSubmit = () => {
    const missing = renderFields.filter(({ field: f }) => f.required
      && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''))
    if (missing.length) {
      setMissingKeys(missing.map(({ field: f }) => f.key))
      toast.error(`请填写必填字段：${missing.map(({ field: f }) => f.label).join('、')}`)
      document.querySelector(`[data-fkey="${missing[0].field.key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    // IP 字段格式校验（与后端硬拦截口径一致）
    const ipErrs = {}
    for (const { field: f } of renderFields) {
      if (f.type !== 'ip') continue
      const v = values[f.key]
      if (v === undefined || v === null || String(v).trim() === '') continue
      const msg = validateIPExpression(v, f.label || f.key)
      if (msg) ipErrs[f.key] = msg
    }
    if (Object.keys(ipErrs).length) {
      setIpErrors(ipErrs)
      const firstKey = Object.keys(ipErrs)[0]
      toast.error(Object.values(ipErrs)[0])
      document.querySelector(`[data-fkey="${firstKey}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setIpErrors({})
    const deviceForm = ticket?.device_action_form
    const actionItems = deviceForm?.mode === 'actions' ? (deviceForm.items || []) : []
    const deviceRuns = []
    if (actionItems.length) {
      const miss = []
      const nextIp = {}
      const tplCtx = deviceTemplateContext(ticket, values)
      for (const it of actionItems) {
        if (!liveDeviceExecute(it)) continue
        if (it.error) {
          toast.error(it.error)
          return
        }
        const params = actionParams[it.index] || initialDeviceParams(it, ticket.records)
        for (const p of it.params || []) {
          const raw = params[p.name]
          const hasRaw = raw !== undefined && raw !== null && String(raw).trim() !== ''
          // 模板参数按历史 + 当前表单实时预览；隐藏/只读由服务端定稿，不在前端拦截空值
          const templated = p.default_template ? resolveDeviceTemplate(p.default_template, tplCtx) : ''
          const v = hasRaw ? raw : templated
          const empty = v === undefined || v === null || String(v).trim() === ''
          const token = `${it.index}:${p.name}`
          const serverFinalized = !!p.default_template && ['readonly', 'hidden'].includes(p.display)
          if (p.required && empty && !serverFinalized) miss.push(token)
          if (!empty && ['ip', 'cidr'].includes(String(p.type || '').toLowerCase())) {
            const msg = validateIPExpression(v, p.description || p.name)
            if (msg) nextIp[token] = msg
          }
        }
        deviceRuns.push({
          index: it.index,
          action_id: it.action_id,
          run: true,
          params,
          overridden_params: deviceOverrides[it.index] || [],
        })
      }
      if (miss.length || Object.keys(nextIp).length) {
        setDeviceMissing(miss)
        setDeviceIpErrors(nextIp)
        toast.error(miss.length ? '请填写设备动作必填参数' : Object.values(nextIp)[0])
        document.querySelector('[data-device-choice]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }
    setDeviceMissing([])
    setDeviceIpErrors({})
    // 未命中规则的扩展字段的值不提交
    const submitValues = Object.fromEntries(renderFields.map(({ field: f }) => [f.key, values[f.key]]))
    if (routeOptions.length > 1 && !routeTo && !routeSuggested) return toast.error('请选择流转去向')
    // 条件路由命中 → 强制走条件去向（与后端 _resolve_route 一致，处理人不可改选）；
    // 单路由节点忽略 routeTo（防跨节点残留值），留空由后端按默认路由流转
    const targetKey = routeSuggested || (routeOptions.length > 1 ? routeTo : '') || ''
    const target = nodes.find((n) => n.key === targetKey)
    // 会签感知的确认文案：当前并行节点中间提交 / 目标并行节点 / 目标结束 / 普通流转
    const sp = ticket?.sign_progress
    let flowText
    if (currentNode?.type === 'parallel' && (sp?.pending?.length || 0) > 1) {
      flowText = `本次提交代表本分组完成会签，其余 ${sp.pending.length} 组完成后继续流转`
    } else if (target?.type === 'end') {
      flowText = '提交后工单将流转至结束节点并完成'
    } else if (target?.type === 'parallel') {
      flowText = `提交后流转至「${target.name || targetKey}」并行会签（${target.finish_policy === 'any' ? '任一分组提交即流转' : '全部完成后流转'}）`
    } else {
      flowText = `提交后流转至「${target?.name || targetKey}」（${ticket.group_names?.[String(target?.group_id)] || '对应分组'}处理）`
    }
    const willRun = actionItems.filter((it) => liveDeviceExecute(it))
    let message
    if (willRun.length && !ticket?.can_execute_device) {
      toast.error('您没有设备动作执行权限（ticket:execute），无法提交流转触发设备')
      return
    }
    if (willRun.length) {
      // 确认摘要：设备 / 动作 + 关键参数（IP、时长优先，长文本截断），避免处理人误下发
      const paramChip = (k, v, specs) => {
        const label = String(specs.find((p) => p.name === k)?.description || k).split('：')[0]
        let val = String(v)
        if (/duration|expire|ttl/i.test(k)) {
          const lab = deviceDurationLabel(v)
          if (lab && lab !== val) val = `${val}（${lab}）`
        }
        return (
          <span key={k} title={`${label}=${val}`}
            className="inline-flex max-w-[13rem] shrink items-baseline rounded bg-background/70 px-1.5 py-0.5">
            <span className="shrink-0 opacity-70">{label}</span>
            <span className="mx-0.5 shrink-0 opacity-40">=</span>
            <span className="min-w-0 truncate text-foreground/80">{val}</span>
          </span>
        )
      }
      const deviceCard = (it) => {
        const run = deviceRuns.find((x) => x.index === it.index)
        const params = run?.params || {}
        const specs = it.params || []
        // 只保留关键参数：IP 类 → 时长类 → 其余，最多 3 个
        const rank = (k) => (/^(ip|blist|target)$/i.test(k) ? 0 : /duration|expire|ttl/i.test(k) ? 1 : 2)
        const chips = Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
          .sort(([a], [b]) => rank(a) - rank(b))
          .slice(0, 3)
          .map(([k, v]) => paramChip(k, v, specs))
        return (
          <div key={it.index} className="rounded-md border border-border/70 bg-muted/60 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Zap className="h-3.5 w-3.5 shrink-0 text-cyan-500" />
              <span className="min-w-0 truncate">{it.device_name || '设备'}</span>
              <span className="shrink-0 text-muted-foreground/60">/</span>
              <span className="min-w-0 truncate">{it.action_name || '动作'}</span>
            </div>
            {chips.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">{chips}</div>}
          </div>
        )
      }
      message = (
        <div className="space-y-2 text-left">
          <p className="text-sm text-foreground">将下发 {willRun.length} 个设备动作：</p>
          <div className="space-y-1.5">{willRun.map(deviceCard)}</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            提交后工单立即流转，设备异步执行，结果可在流转历史中查看、重试或撤销。
          </p>
        </div>
      )
    } else if (actionItems.length) {
      message = `未命中建议执行值，本次不调用设备，工单按去向继续。${flowText}。确认提交？`
    } else {
      message = `${flowText}。确认提交？`
    }
    confirm({ title: '确认提交流转', message, confirmText: '提交流转' }).then((ok) => {
      if (!ok) return
      setSubmitting(true)
      ticketApi.advanceTicket(id, {
        field_values: submitValues,
        route_to: targetKey,
        comment: comment.trim() || null,
        device_runs: deviceRuns,
      })
        .then((res) => {
          toast.success(target?.type === 'end' ? '工单已完成' : `已流转至「${target?.name}」`)
          setTicket(res)
          setValues({})
          setComment('')
          setMissingKeys([])
          setActionParams({})
          setDeviceCustom({})
          setDeviceOverrides({})
        })
        .catch((e) => toast.error(e.message || '流转失败'))
        .finally(() => setSubmitting(false))
    })
  }

  // 设备动作异步结果：失败重试 / 封禁成功撤销（补偿）
  const setDeviceRunBusy = (key, busy) => {
    setDeviceBusy((prev) => {
      if (!busy) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: true }
    })
  }

  const handleRetryDeviceRun = async (dr) => {
    if (!dr?.run_id) return
    const key = `${dr.run_id}:retry`
    if (deviceBusy[key]) return
    // 确认框期间就锁定按钮，避免连点弹出多个确认框/重复排队
    setDeviceRunBusy(key, true)
    const ok = await confirm({
      title: '重试设备动作',
      message: `将重新下发「${dr.device_name || '设备'} / ${dr.action_name || '动作'}」，确认继续？`,
      confirmText: '重试',
    })
    if (!ok) {
      setDeviceRunBusy(key, false)
      return
    }
    try {
      const res = await ticketApi.retryDeviceRun(id, dr.run_id)
      setTicket(res)
      toast.success('已重新排队，执行结果将自动刷新')
    } catch (e) {
      toast.error(e.message || '重试失败')
      // 排队失败时后端会把记录标记为 failed，主动刷新一次让失败原因立即可见
      refreshTicketSilently()
    } finally {
      setDeviceRunBusy(key, false)
    }
  }

  // 批量重试：仅重新排队失败项（成功/执行中的动作不受影响）
  const handleRetryFailedDeviceRuns = async (items) => {
    const targets = (items || []).filter((x) => x?.run_id)
    if (!targets.length || deviceBusy['batch:retry']) return
    setDeviceRunBusy('batch:retry', true)
    const ok = await confirm({
      title: '重试全部失败动作',
      message: `将重新排队 ${targets.length} 个失败动作，已成功或执行中的动作不受影响。确认继续？`,
      confirmText: '全部重试',
    })
    if (!ok) {
      setDeviceRunBusy('batch:retry', false)
      return
    }
    let success = 0
    let latest = null
    const errors = []
    try {
      for (const dr of targets) {
        try {
          latest = await ticketApi.retryDeviceRun(id, dr.run_id)
          success += 1
        } catch (e) {
          errors.push(`${dr.action_name || '动作'}：${e.message || '重试失败'}`)
        }
      }
      if (latest) setTicket(latest)
      if (success) toast.success(`已重新排队 ${success}/${targets.length} 个动作`)
      if (errors.length) toast.error(errors.join('；'))
      // 部分排队失败时同步后端最新状态
      if (errors.length) refreshTicketSilently()
    } finally {
      setDeviceRunBusy('batch:retry', false)
    }
  }

  const handleCompensateDeviceRun = async (dr, busyKey) => {
    if (!dr?.run_id) return
    const key = busyKey || `${dr.run_id}:compensate`
    if (deviceBusy[key]) return
    const target = dr.params?.ip || dr.params?.blist || '原封禁对象'
    setDeviceRunBusy(key, true)
    const ok = await confirm({
      title: '撤销封禁',
      message: `将向「${dr.device_name || '设备'}」下发解封「${target}」，并同步工作台封禁台账。确认撤销该封禁？`,
      confirmText: '确认撤销',
    })
    if (!ok) {
      setDeviceRunBusy(key, false)
      return
    }
    try {
      const res = await ticketApi.compensateDeviceRun(id, dr.run_id)
      setTicket(res)
      toast.success('撤销任务已排队，执行结果将自动刷新')
    } catch (e) {
      toast.error(e.message || '撤销失败')
      refreshTicketSilently()
    } finally {
      setDeviceRunBusy(key, false)
    }
  }

  const handleCancel = () => {
    if (!cancelReason.trim()) return toast.error('请填写取消原因')
    setCancelling(true)
    ticketApi.cancelTicket(id, { comment: cancelReason.trim() })
      .then((res) => { toast.success('工单已取消'); setTicket(res); setCancelOpen(false) })
      .catch((e) => toast.error(e.message || '取消失败'))
      .finally(() => setCancelling(false))
  }

  // 回退目标：白名单（rollback_to）→ 白名单内节点；缺省 → 自动上一节点
  // （来源 = 最近一条把工单送入当前节点的记录 create 发起 / submit 流转；
  //   会签中间提交 route_to 为空不影响判断；create 落在首节点时无上家可退）
  const rollbackTargets = useMemo(() => {
    const rb = currentNode?.rollback_to
    if (Array.isArray(rb)) {
      return rb.map((k) => nodes.find((n) => n.key === k)).filter((n) => n && n.type !== 'end')
    }
    const records = ticket?.records || []
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const r = records[i]
      if ((r.action === 'submit' || r.action === 'create') && r.route_to === ticket?.current_node_key) {
        if (r.node_key === ticket.current_node_key) return []
        const src = nodes.find((n) => n.key === r.node_key)
        return src ? [src] : []
      }
    }
    return []
  }, [ticket, nodes, currentNode])
  const canRollback = !!ticket?.can_handle && rollbackTargets.length > 0
  // 当前选中的回退目标节点（单目标直接取；多目标按弹窗下拉选择）
  const rollbackTargetNode = rollbackTargets.length === 1
    ? rollbackTargets[0]
    : rollbackTargets.find((n) => n.key === rollbackTarget)

  const handleRollback = () => {
    if (!rollbackReason.trim()) return toast.error('请填写回退原因')
    if (rollbackTargets.length > 1 && !rollbackTarget) return toast.error('请选择回退目标节点')
    setRollingBack(true)
    ticketApi.rollbackTicket(id, {
      comment: rollbackReason.trim(),
      target: rollbackTargets.length > 1 ? rollbackTarget : (currentNode?.rollback_to && rollbackTargets[0]?.key) || undefined,
    })
      .then((res) => {
        toast.success(`工单已退回至「${res.current_node_name}」，已通知目标节点处理组`)
        setTicket(res)
        setRollbackOpen(false)
        setRollbackReason('')
        setRollbackTarget('')
        setValues({})
        setComment('')
      })
      .catch((e) => toast.error(e.message || '回退失败'))
      .finally(() => setRollingBack(false))
  }

  // 归档 / 取消归档（仅完结工单可归档；归档后从默认列表隐藏，可随时恢复）
  const finished = ticket?.status === 'completed' || ticket?.status === 'cancelled'
  const handleArchive = () => {
    confirm({
      title: '归档工单',
      message: `归档后工单「${ticket.ticket_no}」将从默认列表隐藏（可在工单中心「已归档」Tab 查看），处理记录完整保留，可随时取消归档。确认归档？`,
      confirmText: '确认归档',
    }).then((ok) => {
      if (!ok) return
      ticketApi.archiveTicket(id)
        .then((res) => { toast.success(`工单 ${res.ticket_no} 已归档`); setTicket(res) })
        .catch((e) => toast.error(e.message || '归档失败'))
    })
  }

  const handleUnarchive = () => {
    ticketApi.unarchiveTicket(id)
      .then((res) => { toast.success(`工单 ${res.ticket_no} 已恢复展示`); setTicket(res) })
      .catch((e) => toast.error(e.message || '取消归档失败'))
  }

  // 抄送行 → chips 数据（后端 TicketCc.to_dict：id/target_type/target_id/target_name/source）
  // 模板固定抄送（source=template）由模板强制指定不可移除；手动追加项可在 can_manage_cc 时移除
  const ccRows = (ticket?.cc_targets || []).map((r) => ({
    type: r.target_type, id: r.target_id, name: r.target_name, source: r.source, ccId: r.id,
  }))
  const ccTemplate = ccRows.filter((t) => t.source === 'template')
  const ccManual = ccRows.filter((t) => t.source !== 'template')
  const handleAddCc = (targets) => {
    ticketApi.addCc(id, targets)
      .then((res) => { setTicket(res); toast.success('已添加抄送并通知对方') })
      .catch((e) => toast.error(e.message || '添加抄送失败'))
  }
  const handleRemoveCc = (t) => {
    confirm({
      title: '移除抄送',
      message: `确认移除抄送对象「${t.name}」？移除后对方将不再收到本工单的完结通知。`,
      confirmText: '确认移除',
    }).then((ok) => {
      if (!ok) return
      ticketApi.removeCc(id, t.ccId)
        .then((res) => { setTicket(res); toast.success('已移除抄送对象') })
        .catch((e) => toast.error(e.message || '移除抄送失败'))
    })
  }

  // 催办：通知当前节点分组成员（后端 30 分钟限频）
  const handleUrge = () => {
    setUrging(true)
    ticketApi.urgeTicket(id)
      .then((res) => { setTicket(res); toast.success('已向当前节点处理分组发送催办提醒') })
      .catch((e) => toast.error(e.message || '催办失败'))
      .finally(() => setUrging(false))
  }

  // 认领锁定：确认后本节点仅认领人（或管理员）可提交，流转/退回后自动释放
  const handleClaim = () => {
    confirm({
      title: '认领本节点',
      message: '认领后本节点将锁定为仅您（或管理员）可提交处理，其他组员转为只读；提交流转或退回后自动释放。确认认领？',
      confirmText: '确认认领',
    }).then((ok) => {
      if (!ok) return
      setClaiming(true)
      ticketApi.claimTicket(id)
        .then((res) => { setTicket(res); toast.success('认领成功，本节点已锁定为您处理') })
        .catch((e) => toast.error(e.message || '认领失败'))
        .finally(() => setClaiming(false))
    })
  }

  const openTransfer = () => {
    setTransferTarget('')
    setTransferReason('')
    ticketApi.ccOptions()
      .then((res) => {
        setTransferOptions({
          users: (res.users || []).filter((u) => u.is_active),
          groups: (res.groups || []).filter((g) => g.enabled),
        })
        setTransferOpen(true)
      })
      .catch((e) => toast.error(e.message || '加载转办对象失败'))
  }

  // 转办：分组模式=变更当前节点处理组；人员模式=该人个人接管（复用认领锁定）
  const handleTransfer = () => {
    if (!transferTarget) return toast.error('请选择转办分组或人员')
    if (!transferReason.trim()) return toast.error('请填写转办原因')
    const [kind, rawId] = transferTarget.split(':')
    const body = { reason: transferReason.trim() }
    if (kind === 'group') body.group_id = Number(rawId)
    else body.user_id = Number(rawId)
    setTransferring(true)
    ticketApi.transferTicket(id, body)
      .then((res) => {
        toast.success('转办成功，已通知对方')
        setTicket(res)
        setTransferOpen(false)
        setValues({})
        setComment('')
        setMissingKeys([])
      })
      .catch((e) => toast.error(e.message || '转办失败'))
      .finally(() => setTransferring(false))
  }

  // 时间线内部评论：写入流转历史（action=comment），不改工单状态
  const handleAddComment = () => {
    const content = commentDraft.trim()
    if (!content) return toast.error('评论内容不能为空')
    setCommenting(true)
    ticketApi.addComment(id, content)
      .then((res) => { setTicket(res); setCommentDraft(''); toast.success('评论已发布') })
      .catch((e) => toast.error(e.message || '评论失败'))
      .finally(() => setCommenting(false))
  }

  // AI 处置意见一键填充：把智能体研判结果整理为多行文本追加到处理意见
  const fillFromAgent = (s) => {
    const a = s?.agent
    if (!a) return
    const lines = [`【智能体研判·${s.label || s.role} ${s.ip}】`]
    lines.push(`风险等级：${a.risk_level || '未知'}`)
    const actionText = AGENT_ACTION_LABELS[a.action] || a.action
    lines.push(`处置建议：${actionText}${a.monitoring_advice ? `（${a.monitoring_advice}）` : ''}`)
    if (Array.isArray(a.reasons) && a.reasons.length) {
      lines.push('决策依据：')
      a.reasons.forEach((r) => lines.push(`- ${String(r)}`))
    } else if (a.reasons != null && a.reasons !== '') {
      lines.push(`决策依据：${String(a.reasons)}`)
    }
    setComment((c) => (c && c.trim() ? `${c}\n${lines.join('\n')}` : lines.join('\n')))
    toast.success('已将智能体研判结果填入处置意见，可编辑后提交')
  }

  if (loading) {
    return (
      <PageContainer>
        <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />加载中...
        </div>
      </PageContainer>
    )
  }
  if (!ticket) return null

  const st = STATUS_META[ticket.status] || STATUS_META.processing
  const pr = PRIORITY_META[ticket.priority] || PRIORITY_META.medium

  return (
    <PageContainer>
      {/* 头部 */}
      <div className="mb-4 rounded-md border border-border bg-card px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <button onClick={() => navigate('/tickets')} className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />返回工单列表
            </button>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm font-semibold text-primary">{ticket.ticket_no}</span>
              <h1 className="text-[20px] font-semibold text-foreground">{ticket.title}</h1>
              <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${st.cls}`}>
                <st.Icon className="h-3.5 w-3.5" />{st.label}
              </span>
              <span className={`inline-flex whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${pr.cls}`}>{pr.label}</span>
              {ticket.archived && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                  title="已归档：从默认列表隐藏，可在工单中心「已归档」Tab 查看">
                  <Archive className="h-3.5 w-3.5" />已归档
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
              <span>流程：<Link to="/ticket-config/flows" className="text-foreground hover:text-primary">{ticket.flow_name}</Link>（快照 v{snapshot.version ?? '--'}）</span>
              <span className="flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />发起人：{ticket.created_by_name || '--'}</span>
              <span className="tabular-nums">发起时间：{ticket.created_at ? new Date(ticket.created_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</span>
              {ticket.related_alert_id && (
                <span className="flex items-center gap-1">
                  <Link2 className="h-3.5 w-3.5" />
                  关联告警：<Link to={`/alerts?alert_id=${ticket.related_alert_id}`} onClick={(e) => { if (!guardNavPermission('alert', 'view', '告警列表')) e.preventDefault() }} className="text-primary hover:underline">#{ticket.related_alert_id}</Link>
                </span>
              )}
            </div>
            {/* 抄送：模板固定（强制不可移除，带「模板」徽标）+ 手动追加（can_manage_cc 可增减） */}
            {(ccRows.length > 0 || ticket.can_manage_cc) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  <UsersRound className="h-3.5 w-3.5" />抄送：
                </span>
                {ccTemplate.length > 0 && <CcChips targets={ccTemplate} showSource max={8} />}
                {ccManual.length > 0 && (
                  <CcChips targets={ccManual} max={8} onRemove={ticket.can_manage_cc ? handleRemoveCc : undefined} />
                )}
                {ticket.can_manage_cc && (
                  <button
                    type="button"
                    onClick={() => setCcPickerOpen(true)}
                    className="flex items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  >
                    <Plus className="h-3 w-3" />添加抄送
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {ticket.can_urge && (
              <Button variant="secondary" size="sm" loading={urging} onClick={handleUrge}
                title="向当前节点处理分组发送催办提醒（30 分钟内仅可催办一次）">
                <Zap className="mr-1 h-3.5 w-3.5" />催办
              </Button>
            )}
            {ticket.can_cancel && (
              <Button variant="danger" size="sm" onClick={() => { setCancelReason(''); setCancelOpen(true) }}>
                <Ban className="mr-1 h-3.5 w-3.5" />取消工单
              </Button>
            )}
            {canDelete && ticket.archived && (
              <Button variant="secondary" size="sm" onClick={handleUnarchive}>
                <ArchiveRestore className="mr-1 h-3.5 w-3.5" />取消归档
              </Button>
            )}
            {canDelete && !ticket.archived && finished && (
              <Button variant="secondary" size="sm" onClick={handleArchive}>
                <Archive className="mr-1 h-3.5 w-3.5" />归档
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tab 行：工单详情（流转历史）/ 安全上下文（自动研判） */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-border">
        <button
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${activeTab === 'detail' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('detail')}
        >
          <ClipboardList className="h-3.5 w-3.5" />工单详情
        </button>
        <button
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition ${activeTab === 'enrich' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('enrich')}
        >
          <ShieldCheck className="h-3.5 w-3.5" />安全上下文
        </button>
      </div>

      <div className="flex items-start gap-4">
        {/* 左侧：按 Tab 切换内容 */}
        <div className="min-w-0 flex-1 space-y-4">
          {activeTab === 'detail' && (
          <>
          {/* 流程步骤条 */}
          <div className="rounded-md border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-1">
              {stepNodes.map((n, i) => {
                const done = handledKeys.has(n.key)
                const active = ticket.status === 'processing' && ticket.current_node_key === n.key
                const isEnd = n.type === 'end'
                const endDone = ticket.status === 'completed'
                return (
                  <div key={n.key} className="flex items-center">
                    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium transition ${active ? 'border-primary bg-primary/10 text-primary' : done || (isEnd && endDone) ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-500' : 'border-border text-muted-foreground'}`}>
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${active ? 'bg-primary text-white' : done || (isEnd && endDone) ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'}`}>
                        {isEnd ? '✓' : done || (isEnd && endDone) ? '✓' : i + 1}
                      </span>
                      <span>{n.name || n.key}</span>
                      {n.type === 'parallel' && (
                        <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${active ? 'bg-primary/15 text-primary' : 'bg-violet-500/15 text-violet-500'}`}>会签</span>
                      )}
                      {!isEnd && n.type !== 'parallel' && ticket.group_names?.[String(n.group_id)] && (
                        <span className="text-[11px] font-normal text-muted-foreground">（{ticket.group_names[String(n.group_id)]}）</span>
                      )}
                      {!isEnd && n.type === 'parallel' && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          （{(n.sign_groups || []).map((g) => ticket.group_names?.[String(g)]).filter(Boolean).join('、') || '多分组'}会签）
                        </span>
                      )}
                    </div>
                    {i < stepNodes.length - 1 && <ChevronRight className="mx-0.5 h-4 w-4 text-muted-foreground" />}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 流转历史：时间轴 + 各节点处置意见 */}
          <div className="rounded-md border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">流转历史</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{(ticket.records || []).length} 条</span>
              {Number(ticket.pending_device_runs || 0) > 0 && (
                <button type="button" onClick={refreshTicketSilently}
                  className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 transition hover:bg-amber-500/20"
                  title="设备动作异步执行中，点击立即刷新状态">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {ticket.pending_device_runs} 个设备动作执行中
                </button>
              )}
              <span className="text-xs text-muted-foreground">按处理时间正序展示，含每个节点的处理人与处置意见</span>
            </div>
            {(ticket.records || []).length > 0 ? (
              <div className="relative space-y-4 pl-7">
                <div className="absolute bottom-3 left-[5px] top-3 w-px bg-border" />
                {ticket.records.map((r) => {
                  const nodeDef = nodes.find((n) => n.key === r.node_key)
                  const defs = fieldDefMap(nodeDef?.fields)
                  const am = ACTION_META[r.action] || ACTION_META.submit
                  const routeTarget = r.route_to ? nodes.find((n) => n.key === r.route_to) : null
                  // 本节点设备动作统计/失败项/撤销关联，用于批量重试与部分成功提示
                  const recordDeviceItems = deviceItemsOfRecord(r)
                  const activeDeviceItems = recordDeviceItems.filter(
                    (it) => it && !it.skipped && (it.action_name || it.device_name),
                  )
                  const failedDeviceItems = activeDeviceItems.filter(
                    (it) => deviceRunStatus(it) === 'failed' && it.run_id,
                  )
                  const pendingDeviceCount = activeDeviceItems.filter(deviceRunPending).length
                  const deviceCounts = activeDeviceItems.reduce((acc, it) => {
                    const s = deviceRunStatus(it)
                    acc[s] = (acc[s] || 0) + 1
                    return acc
                  }, {})
                  const compByRunId = {}
                  allDeviceItems.forEach((it) => {
                    if (it?.kind === 'compensate' && it.compensation_of_run_id) {
                      // 同一原记录若有多条撤销记录，按时间线顺序后者覆盖前者（最新状态）
                      compByRunId[String(it.compensation_of_run_id)] = it
                    }
                  })
                  return (
                    <div key={r.id} className="relative">
                      <span className={`absolute -left-7 top-6 flex h-[11px] w-[11px] items-center justify-center rounded-full border-2 bg-card ${am.dot}`} />
                      <div className="rounded-md border border-border p-4">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{r.node_key}</span>
                          <span className="font-semibold text-foreground">{r.node_name || r.node_key}</span>
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${am.cls}`}>{am.label}</span>
                          {r.group_id && ticket.group_names?.[String(r.group_id)] && (
                            <span className="text-xs text-muted-foreground">分组：{ticket.group_names[String(r.group_id)]}</span>
                          )}
                          <div className="flex-1" />
                          <span className="text-xs text-muted-foreground">{r.handler_name || '--'}</span>
                          <span className="tabular-nums text-xs text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</span>
                        </div>
                        {Object.keys(r.field_values || {}).length > 0 && (
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-muted p-4">
                            {Object.entries(r.field_values).map(([k, v]) => (
                              <div key={k} className="flex items-start gap-2 text-sm">
                                <span className="shrink-0 text-muted-foreground">{defs[k]?.label || k}：</span>
                                <FieldValueView field={defs[k]} value={v} />
                              </div>
                            ))}
                          </div>
                        )}
                        {recordDeviceItems.map((dr, di) => {
                          if (!dr) return null
                          if (dr.skipped) {
                            const skipLabel = dr.by === 'judge' ? '判断组建议不执行' : dr.by === 'condition' ? '条件未命中' : '未执行'
                            return (
                              <div key={di} className="mt-1.5 flex items-center gap-1.5 rounded border border-dashed border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
                                <span className="shrink-0">{skipLabel}</span>
                                {(dr.device_name || dr.action_name) && (
                                  <>
                                    <span className="shrink-0 opacity-40">·</span>
                                    <span className="min-w-0 truncate">
                                      {dr.device_name || '设备'}{dr.action_name ? ` / ${dr.action_name}` : ''}
                                    </span>
                                  </>
                                )}
                              </div>
                            )
                          }
                          if (!(dr.skipped === false || dr.action_name || dr.device_name)) return null
                          const isComp = dr.kind === 'compensate'
                          const status = deviceRunStatus(dr)
                          const meta = DEVICE_RUN_STATUS[status] || DEVICE_RUN_STATUS.success
                          const isPending = deviceRunPending(dr)
                          const statusLabel = isComp
                            ? { queued: '撤销排队中', running: '撤销执行中', success: '已撤销', failed: '撤销失败' }[status] || '撤销'
                            : meta.label
                          // 原封禁记录的撤销进度（撤销动作在独立时间线记录中）
                          const compItem = isComp ? null : compByRunId[String(dr.run_id)]
                          const compStatus = compItem ? deviceRunStatus(compItem) : null
                          const compBusyKey = compItem?.run_id ? `${compItem.run_id}:retry` : `${dr.run_id}:compensate`
                          const retryBusy = !!deviceBusy[`${dr.run_id}:retry`]
                          const compBusy = !!deviceBusy[compBusyKey]
                          const canRetry = status === 'failed' && !!dr.run_id && !!ticket.can_execute_device
                          const canCompensate = !isComp && status === 'success' && dr.action_type === 'block_ip'
                            && !!dr.run_id && !!ticket.can_execute_device
                            && (!compStatus || compStatus === 'failed')
                          // 参数只保留有效值：主目标（ip/blist）与时长优先，长文本靠 title 查看全文
                          const paramEntries = dr.params && typeof dr.params === 'object'
                            ? Object.entries(dr.params)
                              .filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
                              .sort(([a], [b]) => {
                                const rank = (k) => (/^(ip|blist|target)$/i.test(k) ? 0 : /duration|expire|ttl|age/i.test(k) ? 1 : 2)
                                return rank(a) - rank(b)
                              })
                            : []
                          const compProgress = !isComp && compStatus
                            ? { queued: '撤销排队中', running: '撤销执行中', failed: '撤销失败' }[compStatus]
                            : null
                          return (
                            <div key={di} className="mt-2 rounded-md border border-border/70 bg-muted/60 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                                <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                                  {isComp
                                    ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                    : <Zap className="h-3.5 w-3.5 shrink-0 text-cyan-500" />}
                                  <span className="min-w-0 truncate">{dr.device_name || '设备'}</span>
                                  <span className="shrink-0 text-muted-foreground/60">/</span>
                                  <span className="min-w-0 truncate">{dr.action_name || '动作'}</span>
                                </span>
                                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.cls}`}>{statusLabel}</span>
                                {isPending && <Loader2 className="h-3 w-3 animate-spin text-amber-500" />}
                                {compProgress && (
                                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${DEVICE_RUN_STATUS[compStatus].cls}`}>
                                    {compProgress}
                                  </span>
                                )}
                                {Number(dr.attempts) > 1 && (
                                  <span className="text-[11px] text-muted-foreground" title={`共尝试 ${dr.attempts} 次`}>
                                    第 {dr.attempts} 次
                                  </span>
                                )}
                                {status === 'failed' && !dr.error && dr.status_code ? (
                                  <span className="text-[11px] text-muted-foreground">HTTP {dr.status_code}</span>
                                ) : null}
                                {(canRetry || canCompensate) && (
                                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                    {canRetry && (
                                      <button type="button" disabled={retryBusy}
                                        className="flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 text-[11px] text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                                        onClick={() => handleRetryDeviceRun(dr)}>
                                        {retryBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                                        重试
                                      </button>
                                    )}
                                    {canCompensate && (
                                      <button type="button" disabled={compBusy}
                                        className="flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                                        onClick={() => handleCompensateDeviceRun(dr, compBusyKey)}>
                                        {compBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                                        {compStatus === 'failed' ? '重试撤销' : '撤销封禁'}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                              {paramEntries.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {paramEntries.map(([k, v]) => {
                                    let disp = String(v)
                                    // 时长类参数附加友好显示（如 259200（3天）、-1（永久））
                                    if (/duration|expire|ttl/i.test(k)) {
                                      const lab = deviceDurationLabel(v)
                                      if (lab && lab !== String(v)) disp = `${v}（${lab}）`
                                    }
                                    return (
                                      <span key={k}
                                        className="inline-flex max-w-[15rem] items-baseline rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                        title={`${k}=${disp}`}>
                                        <span className="shrink-0 opacity-70">{k}</span>
                                        <span className="mx-0.5 shrink-0 opacity-40">=</span>
                                        <span className="min-w-0 truncate text-foreground/80">{disp}</span>
                                      </span>
                                    )
                                  })}
                                </div>
                              )}
                              {dr.error && (
                                <div className="mt-1.5 flex items-start gap-1.5 rounded bg-destructive/5 px-2 py-1 text-[11px] leading-relaxed text-destructive">
                                  {dr.status_code ? <span className="shrink-0 font-mono opacity-80">HTTP {dr.status_code}</span> : null}
                                  <span className="break-all">{dr.error}</span>
                                </div>
                              )}
                            </div>
                          )
                        })}
                        {activeDeviceItems.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
                            <span>设备动作 {activeDeviceItems.length} 个</span>
                            {[['queued', '排队'], ['running', '执行中'], ['success', '成功'], ['failed', '失败'], ['compensated', '已撤销']]
                              .filter(([s]) => deviceCounts[s])
                              .map(([s, label]) => (
                                <span key={s} className={`rounded px-1.5 py-0.5 font-medium ${DEVICE_RUN_STATUS[s]?.cls || ''}`}>
                                  {label} {deviceCounts[s]}
                                </span>
                              ))}
                            {pendingDeviceCount > 0 && (
                              <button type="button" onClick={refreshTicketSilently}
                                className="flex items-center gap-1 text-amber-600 hover:underline"
                                title="设备异步执行中，点击立即刷新状态">
                                <Loader2 className="h-3 w-3 animate-spin" />刷新
                              </button>
                            )}
                            <div className="flex-1" />
                            {failedDeviceItems.length > 1 && !!ticket.can_execute_device && (
                              <button type="button" disabled={!!deviceBusy['batch:retry']}
                                className="flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => handleRetryFailedDeviceRuns(failedDeviceItems)}>
                                {deviceBusy['batch:retry'] && <Loader2 className="h-3 w-3 animate-spin" />}
                                重试全部失败（{failedDeviceItems.length}）
                              </button>
                            )}
                          </div>
                        )}
                        {r.comment && (
                          <div className={`mt-2 rounded-r-md border-l-2 px-3 py-2 ${
                            r.action === 'rollback' ? 'border-amber-500/60 bg-amber-500/5' : 'border-primary/60 bg-primary/5'
                          }`}>
                            <div className={`mb-0.5 text-[11px] font-medium ${r.action === 'rollback' ? 'text-amber-500' : 'text-primary'}`}>
                              {ACTION_COMMENT_LABELS[r.action] || '处置意见'}
                            </div>
                            <div className="text-sm leading-relaxed text-foreground"><RichTextView text={r.comment} /></div>
                          </div>
                        )}
                        {routeTarget && (
                          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {r.action === 'rollback'
                              ? <><CornerUpLeft className="h-3.5 w-3.5 text-amber-500" />退回至「{routeTarget.name || routeTarget.key}」</>
                              : <><SendHorizonal className="h-3.5 w-3.5" />流转至「{routeTarget.name || routeTarget.key}」</>}
                            {routeTarget.type !== 'end' && (
                              routeTarget.type === 'parallel' ? (
                                <span>（{(routeTarget.sign_groups || []).map((g) => ticket.group_names?.[String(g)]).filter(Boolean).join('、') || '多分组'}并行会签）</span>
                              ) : ticket.group_names?.[String(routeTarget.group_id)] && (
                                <span>（{ticket.group_names[String(routeTarget.group_id)]}处理）</span>
                              )
                            )}
                          </div>
                        )}
                        {!r.route_to && nodeDef?.type === 'parallel' && r.action === 'submit' && (
                          <div className="mt-2 flex items-center gap-1.5 text-xs text-violet-500">
                            <Users className="h-3.5 w-3.5" />会签提交：本分组已完成，等待其余分组会签
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">暂无流转记录</div>
            )}
            {/* 内部评论：写入时间线（区别于处置意见），通知发起人与当前处理组 */}
            {ticket.can_comment && (
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                <input className={inputCls} placeholder="添加评论：对处理过程的补充说明（Enter 发布）"
                  value={commentDraft} disabled={commenting}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && commentDraft.trim()) handleAddComment()
                  }} />
                <Button variant="secondary" size="sm" className="shrink-0" loading={commenting}
                  disabled={!commentDraft.trim()} onClick={handleAddComment}>
                  <MessageSquare className="mr-1 h-3.5 w-3.5" />评论
                </Button>
              </div>
            )}
          </div>
          </>
          )}
          {activeTab === 'enrich' && (
            <>
              <BanStatusView autoIps={ticketIps} />
              <EnrichmentView enrichment={ticket.enrichment_data} onFill={ticket.can_handle ? fillFromAgent : undefined} />
            </>
          )}
        </div>

        {/* 右侧：当前节点操作面板 */}
        <div className="w-[380px] shrink-0 space-y-4">
          {ticket.can_handle ? (
            <div className="rounded-md border border-primary/40 bg-card p-5">
              <div className="mb-1 flex items-center gap-2 font-semibold text-foreground">
                <Flag className="h-4 w-4 text-primary" />当前节点：{currentNode?.name || '--'}
              </div>
              {currentNode?.type === 'parallel' && (
                <p className="mb-2 text-xs text-muted-foreground">
                  本节点为并行会签节点，由「{(currentNode.sign_groups || []).map((g) => ticket.group_names?.[String(g)]).filter(Boolean).join('、') || '多分组'}」各自处理，
                  {currentNode.finish_policy === 'any' ? '任一分组提交即流转' : '全部会签完成后才流转'}
                </p>
              )}
              {/* 并行会签进度：已签 / 待签分组（后端 sign_progress） */}
              {currentNode?.type === 'parallel' && ticket.sign_progress && (
                <div className="mb-4 space-y-1 rounded-md border border-violet-500/30 bg-violet-500/[0.08] px-3 py-2.5 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-violet-500">
                    <Users className="h-3.5 w-3.5 shrink-0" />会签进度
                    <span className="font-normal text-muted-foreground">（{ticket.sign_progress.policy === 'any' ? '任一分组提交即流转' : '全部会签完成才流转'}）</span>
                  </div>
                  <div className="text-muted-foreground">
                    已签：<span className="text-foreground">{ticket.sign_progress.signed?.length ? ticket.sign_progress.signed.map((g) => g.name).join('、') : '暂无'}</span>
                  </div>
                  <div className="text-muted-foreground">
                    待签：<span className="text-foreground">{ticket.sign_progress.pending?.length ? ticket.sign_progress.pending.map((g) => g.name).join('、') : '全部完成'}</span>
                  </div>
                </div>
              )}
              {/* 认领锁定提示：被认领后其他组员只读 */}
              {ticket.claimed_by_name && (
                <p className="mb-4 flex items-start gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-500">
                  <UserCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  已由 {ticket.claimed_by_name} 认领处理，本节点仅认领人或管理员可提交
                </p>
              )}
              {!ticket.claimed_by_name && !(currentNode?.type === 'parallel' && ticket.sign_progress) && <div className="mb-4" />}
              <div className="space-y-4">
                {renderFields.map(({ field: f, ext }) => {
                const control = (
                  <>
                    <label className={labelCls}>
                      {f.label || f.key}
                      {f.required && <span className="text-red-500">*</span>}
                      {!['switch', 'file'].includes(f.type) && (
                        <span className="ml-1.5 font-normal text-muted-foreground">（{FIELD_TYPE_LABELS[f.type] || f.type}）</span>
                      )}
                    </label>
                    {f.type === 'textarea' && (
                      <RichEditable className={fieldCls(f)} minHeight={64} placeholder={f.placeholder || ''} value={values[f.key] ?? ''}
                        onChange={(v) => setFieldValue(f.key, v)} />
                    )}
                    {f.type === 'select' && (
                      <CompactSelect size="lg" block value={values[f.key] ?? ''} onChange={(e) => setFieldValue(f.key, e.target.value)}>
                        <option value="">请选择</option>
                        {(f.options || []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                      </CompactSelect>
                    )}
                    {f.type === 'switch' && (
                      <div className="flex h-9 items-center gap-4">
                        {[true, false].map((b) => (
                          <label key={String(b)} className="flex cursor-pointer items-center gap-1.5">
                            <input type="radio" className="h-4 w-4 accent-primary" checked={values[f.key] === b}
                              onChange={() => setFieldValue(f.key, b)} />
                            <span className="text-sm text-foreground">{b ? '是' : '否'}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {f.type === 'datetime' && (
                      <DatePicker type="datetime" block value={values[f.key] ?? ''}
                        placeholder={f.label || f.key} title={f.label || f.key}
                        onChange={(e) => setFieldValue(f.key, e.target.value)} />
                    )}
                    {f.type === 'number' && (
                      <input type="number" className={fieldCls(f)} placeholder={f.placeholder || ''} value={values[f.key] ?? ''}
                        onChange={(e) => setFieldValue(f.key, e.target.value)} />
                    )}
                    {f.type === 'file' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm text-foreground transition hover:bg-muted ${uploadingKey === f.key ? 'pointer-events-none opacity-60' : ''} ${missingKeys.includes(f.key) ? 'border-destructive bg-destructive/5' : 'border-input bg-background hover:border-primary/50'}`}>
                          <Paperclip className="h-3.5 w-3.5" />
                          {uploadingKey === f.key ? '上传中...' : '上传附件'}
                          <input type="file" className="hidden" accept={ATTACHMENT_ACCEPT}
                            onChange={(e) => { uploadFile(f.key, e.target.files?.[0]); e.target.value = '' }} />
                        </label>
                        {values[f.key] ? (
                          <div className="flex min-w-0 items-center gap-1.5">
                            <a href={attachmentUrl(values[f.key])} download={decodeURIComponent(String(values[f.key]).split('/').pop() || '附件')}
                              className="inline-flex min-w-0 items-center gap-1 truncate text-sm text-primary hover:underline">
                              <Paperclip className="h-3.5 w-3.5 shrink-0" />
                              {decodeURIComponent(String(values[f.key]).split('/').pop() || '附件')}
                              <Download className="h-3 w-3 shrink-0 opacity-70" />
                            </a>
                            <button onClick={() => setFieldValue(f.key, '')} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="移除">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : <span className="text-xs text-muted-foreground">未上传，支持：{ATTACHMENT_EXTS.join(' / ')}（10MB 内）</span>}
                      </div>
                    )}
                    {['text', 'ip', 'url'].includes(f.type) && (
                      <>
                        <input
                          className={fieldCls(f)}
                          placeholder={f.placeholder || (f.type === 'ip' ? '如：192.168.1.10' : '')}
                          value={values[f.key] ?? ''}
                          onChange={(e) => setFieldValue(f.key, e.target.value)}
                          onBlur={() => {
                            if (f.type !== 'ip') return
                            const v = values[f.key]
                            if (v === undefined || v === null || String(v).trim() === '') return
                            const msg = validateIPExpression(v, f.label || f.key)
                            setIpErrors((e) => ({ ...e, [f.key]: msg || '' }))
                          }}
                        />
                        {ipErrors[f.key] && (
                          <div className="mt-1 text-[11px] text-destructive">{ipErrors[f.key]}</div>
                        )}
                      </>
                    )}
                    {f.type === 'reference' && (() => {
                      const opts = refOpts[f.key] || []
                      if (f.allow_custom) {
                        // 主题化组合框（可自由输入 + 候选列表），替代原生 datalist 的系统样式弹层
                        return (
                          <ComboInput
                            options={opts}
                            error={missingKeys.includes(f.key)}
                            placeholder={f.placeholder || '可输入，或从已填过的值中选择'}
                            value={values[f.key] ?? ''}
                            onChange={(e) => setFieldValue(f.key, e.target.value)}
                          />
                        )
                      }
                      return (
                        <CompactSelect size="lg" block value={values[f.key] ?? ''}
                          onChange={(e) => setFieldValue(f.key, e.target.value)}>
                          <option value="">{opts.length ? '请选择' : '暂无可选项（被引用字段尚未填写）'}</option>
                          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                        </CompactSelect>
                      )
                    })()}
                    {f.type === 'duration' && (() => {
                      const parts = durationToParts(values[f.key])
                      return (
                        <div className="flex items-center gap-2">
                          {parts.permanent ? (
                            <span className="flex h-9 flex-1 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                              永久封禁
                            </span>
                          ) : (
                            <>
                              <input type="number" min="0"
                                className={`${inputBaseCls} min-w-0 flex-1 ${missingKeys.includes(f.key) ? '!border-destructive ring-1 !ring-destructive' : ''}`}
                                placeholder="如：30"
                                value={parts.num}
                                onChange={(e) => setFieldValue(f.key, durationFromParts({ ...parts, num: e.target.value }))} />
                              <div className="w-24 shrink-0">
                                <CompactSelect size="lg" block value={parts.unit}
                                  onChange={(e) => setFieldValue(f.key, durationFromParts({ ...parts, unit: e.target.value }))}>
                                  {DURATION_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                                </CompactSelect>
                              </div>
                            </>
                          )}
                          <label className="flex shrink-0 cursor-pointer items-center gap-1.5"
                            title="勾选后不设到期时间，需手动解封">
                            <input type="checkbox" className="h-4 w-4 accent-primary" checked={parts.permanent}
                              onChange={(e) => setFieldValue(f.key, durationFromParts({ ...parts, permanent: e.target.checked }))} />
                            <span className="text-sm text-foreground">永久</span>
                          </label>
                        </div>
                      )
                    })()}
                  </>
                )
                if (ext) {
                  // 命中匹配规则的扩展字段：分组容器内展示
                  return (
                    <div key={`${currentNode?.key || 'n'}-${f.key}`} data-fkey={f.key}
                      className="rounded-md border-l-2 border-primary/40 bg-primary/[0.03] px-3 py-2.5">
                      <div>{control}</div>
                    </div>
                  )
                }
                return (
                  <div key={`${currentNode?.key || 'n'}-${f.key}`} data-fkey={f.key}>{control}</div>
                )
                })}
                {!currentFields.length && <div className="rounded-md border border-dashed border-border py-4 text-center text-sm text-muted-foreground">本节点无需填写字段</div>}

                {routeOptions.length > 1 && (
                  <div>
                    <label className={labelCls}>流转去向{routeSuggested ? null : <span className="text-red-500">*</span>}</label>
                    <div className="flex flex-wrap gap-2">
                      {routeOptions.map((r) => {
                        const isSug = routeSuggested === r.to
                        const target = nodes.find((n) => n.key === r.to)
                        // 条件命中：去向锁定为条件路由，其余按钮禁用不可改选
                        const locked = !!routeSuggested
                        return (
                          <button key={r.to} type="button" disabled={locked && !isSug}
                            onClick={() => { if (!locked) setRouteTo(r.to) }}
                            className={`rounded-md border px-3 py-1.5 text-[13px] font-medium transition ${routeTo === r.to ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:border-primary/50'} ${locked && !isSug ? 'cursor-not-allowed opacity-40' : ''}`}>
                            {r.label || target?.name || r.to}
                            {isSug && <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-500">{locked ? '条件命中·锁定' : '条件建议'}</span>}
                          </button>
                        )
                      })}
                    </div>
                    <p className={hintCls}>
                      {routeSuggested
                        ? '填写内容已命中流转条件，去向锁定为条件路由，不可手动调整'
                        : '未命中流转条件，请选择流转去向'}
                    </p>
                  </div>
                )}
                {routeOptions.length === 1 && routeOptions[0].to && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <SendHorizonal className="h-3.5 w-3.5" />
                    提交后流转至「{nodes.find((n) => n.key === routeOptions[0].to)?.name || routeOptions[0].to}」
                  </div>
                )}

                {(ticket.device_action_form?.bound && deviceNeedsPermission && !ticket.can_execute_device) && (
                  <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>您没有设备动作执行权限（ticket:execute），当前命中建议执行值无法提交流转，请联系管理员授权。</span>
                  </div>
                )}
                {(ticket.device_action_form?.items || []).map((it) => {
                  if (!liveDeviceExecute(it)) {
                    const actual = liveDeviceActual(it)
                    return (
                      <div key={it.index} className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        {actual
                          ? `判断为「${actual}」，本次不调用设备。`
                          : `填写判断字段并命中建议执行值后，将调用 ${it.device_name || '设备'} / ${it.action_name || '动作'}。`}
                      </div>
                    )
                  }
                  const params = actionParams[it.index] || initialDeviceParams(it, ticket.records)
                  const setP = (name, v) => {
                    const base = actionParams[it.index] || initialDeviceParams(it, ticket.records)
                    setActionParams((s) => ({ ...s, [it.index]: { ...base, [name]: v } }))
                    // 记录处理人手改过的参数，提交时告知服务端优先用其输入而不是模板
                    setDeviceOverrides((m) => ({
                      ...m,
                      [it.index]: [...new Set([...(m[it.index] || []), name])],
                    }))
                    const token = `${it.index}:${name}`
                    if (deviceMissing.includes(token)) setDeviceMissing((ks) => ks.filter((k) => k !== token))
                    if (deviceIpErrors[token]) setDeviceIpErrors((e) => ({ ...e, [token]: '' }))
                  }
                  return (
                    <div key={it.index} data-device-choice className="rounded-md border border-border p-3">
                      <div className="text-sm font-semibold text-foreground">{it.device_name || '设备'} / {it.action_name || '动作'}</div>
                      {it.error && <div className="mt-2 text-xs text-destructive">{it.error}</div>}
                      <div className="mt-3 space-y-3">
                          {(it.params || []).map((p) => {
                            const token = `${it.index}:${p.name}`
                            const bad = deviceMissing.includes(token) || deviceIpErrors[token]
                            const cls = bad ? `${inputCls} !border-destructive ring-1 !ring-destructive` : inputCls
                            // 参数快捷选项（模板设计者配置）：选择即映射为实际参数值；可切"自定义"手动填写
                            const presets = (p.presets || [])
                              .map((x) => ({ ...x, resolved: evalParamExpr(x.value) }))
                              .filter((x) => String(x.label || '').trim() && x.resolved !== null && x.resolved !== '')
                            const cur = params[p.name]
                            const hasCur = cur !== undefined && cur !== null && String(cur) !== ''
                            // 默认值模板预览：历史记录 + 当前表单实时解析，仅用于展示，不写回 actionParams
                            const tplPreview = p.default_template ? resolveDeviceTemplate(p.default_template, devicePreviewCtx) : ''
                            const matched = presets.find((x) => String(x.resolved) === String(cur))
                            const customMode = (hasCur && !matched) || !!deviceCustom[token]
                            // 时长类参数：type=duration，或设备 schema 标为 string 但参数名是 duration/expire/ttl/age
                            const isDur = String(p.type || '').toLowerCase() === 'duration'
                              || ['duration', 'expire', 'ttl', 'age'].includes(String(p.name || '').toLowerCase())
                            // 展示方式（模板设计者经 param_config 配置）：hidden 不渲染，按解析后的默认值提交；readonly 只读展示
                            if (p.display === 'hidden') return null
                            const isReadOnly = p.display === 'readonly'
                            const renderCustom = () => (isDur ? (
                              <div className="flex items-center gap-2">
                                <input type="number" min="-1" step="1"
                                  max={p.max ? Number(p.max) : undefined}
                                  className={`${inputBaseCls} min-w-0 flex-1`}
                                  value={durationValueToSeconds(cur)}
                                  placeholder="请输入秒数"
                                  title={p.max ? `单位为秒，-1 表示永久，上限 ${p.max} 秒` : '单位为秒，-1 表示永久'}
                                  onChange={(e) => setP(p.name, e.target.value)} />
                                <span className="shrink-0 text-sm text-muted-foreground">秒</span>
                              </div>
                            ) : p.options?.length ? (
                              <CompactSelect size="lg" block value={cur ?? ''} onChange={(e) => setP(p.name, e.target.value)}>
                                <option value="">请选择</option>
                                {p.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                              </CompactSelect>
                            ) : (
                              <input className={cls} value={cur ?? ''}
                                placeholder={tplPreview || undefined}
                                onChange={(e) => setP(p.name, e.target.value)}
                                onBlur={() => {
                                  if (!['ip', 'cidr'].includes(String(p.type || '').toLowerCase())) return
                                  const v = params[p.name]
                                  if (v === undefined || v === null || String(v).trim() === '') return
                                  const msg = validateIPExpression(v, p.description || p.name)
                                  setDeviceIpErrors((e) => ({ ...e, [token]: msg || '' }))
                                }} />
                            ))
                            const defVal = (p.default !== undefined && p.default !== null && String(p.default) !== '') ? p.default : null
                            // 只读展示服务端定稿结果：模板实时预览优先，否则动作默认值
                            const readonlyText = tplPreview || (defVal === null ? '' : String(defVal))
                            return (
                              <div key={p.name}>
                                <div className="flex items-center justify-between gap-2">
                                  <label className={labelCls}>
                                    {p.description || p.name}
                                    {p.required && <span className="text-red-500">*</span>}
                                  </label>
                                </div>
                                {isReadOnly ? (
                                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2">
                                    <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={readonlyText}>{readonlyText}</span>
                                  </div>
                                ) : presets.length ? (
                                  <div>
                                    <CompactSelect size="lg" block
                                      value={customMode ? '__custom' : (matched ? matched.label : '')}
                                      onChange={(e) => {
                                        const v = e.target.value
                                        if (v === '__custom') {
                                          setDeviceCustom((m) => ({ ...m, [token]: true }))
                                        } else {
                                          setDeviceCustom((m) => ({ ...m, [token]: false }))
                                          const sel = presets.find((x) => x.label === v)
                                          setP(p.name, sel ? sel.resolved : '')
                                        }
                                      }}>
                                      <option value="">请选择</option>
                                      {presets.map((x) => (
                                        <option key={x.label} value={x.label}>{x.label}</option>
                                      ))}
                                      <option value="__custom">自定义…</option>
                                    </CompactSelect>
                                    {customMode && <div className="mt-1.5">{renderCustom()}</div>}
                                  </div>
                                ) : renderCustom()}
                                {deviceIpErrors[token] && <div className="mt-1 text-[11px] text-destructive">{deviceIpErrors[token]}</div>}
                              </div>
                            )
                          })}
                        </div>
                    </div>
                  )
                })}


                <div>
                  <label className={labelCls}>处理意见（选填）</label>
                  <RichEditable className={inputCls} minHeight={64} placeholder="填写本节点的处理说明，可直接粘贴截图" value={comment}
                    onChange={setComment} />
                </div>
                {formErrorText && (
                  <div role="alert"
                    className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{formErrorText}</span>
                  </div>
                )}
                <Button variant="primary" className="w-full" loading={submitting}
                  disabled={deviceNeedsPermission && !ticket.can_execute_device}
                  title={deviceNeedsPermission && !ticket.can_execute_device ? '无设备动作执行权限（ticket:execute）' : undefined}
                  onClick={handleSubmit}>
                  <SendHorizonal className="mr-1 h-4 w-4" />提交流转
                </Button>
                {canRollback && (
                  <Button variant="secondary" className="w-full" disabled={submitting}
                    onClick={() => { setRollbackTarget(rollbackTargets.length === 1 ? rollbackTargets[0].key : ''); setRollbackOpen(true) }}>
                    <CornerUpLeft className="mr-1 h-4 w-4" />
                    {rollbackTargets.length === 1
                      ? `退回上一步（${rollbackTargets[0].name || rollbackTargets[0].key}）`
                      : `退回指定节点（${rollbackTargets.length} 个可选）`}
                  </Button>
                )}
                {ticket.can_claim && (
                  <Button variant="secondary" className="w-full" disabled={submitting} loading={claiming} onClick={handleClaim}>
                    <UserCheck className="mr-1 h-4 w-4" />认领本节点（锁定后仅我可提交）
                  </Button>
                )}
                {/* 并行会签节点不支持转办（多分组同时处理，由后端拒绝；前端直接隐藏） */}
                {currentNode?.type !== 'parallel' && (
                  <Button variant="secondary" className="w-full" disabled={submitting} onClick={openTransfer}>
                    <ArrowRightLeft className="mr-1 h-4 w-4" />转办 / 改派
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
              {ticket.status === 'processing' ? (
                <div className="flex items-start gap-2">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                  <span>
                    工单当前停留于「{ticket.current_node_name}」，
                    由「{ticket.current_group_name || '对应分组'}」处理；
                    {ticket.claimed_by_name
                      ? `已由 ${ticket.claimed_by_name} 认领，本节点仅认领人或管理员可提交，您当前只读。`
                      : '您不在该分组内，本节点内容对您只读。'}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {ticket.status === 'completed' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span>
                    {ticket.status === 'completed'
                      ? `工单已按流程完成（${ticket.closed_at ? new Date(ticket.closed_at).toLocaleString('zh-CN', { hour12: false }) : '--'}）`
                      : `工单已取消（${ticket.closed_at ? new Date(ticket.closed_at).toLocaleString('zh-CN', { hour12: false }) : '--'}）`}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 工单信息摘要 */}
          <div className="rounded-md border border-border bg-card p-5">
            <div className="mb-3 text-sm font-semibold text-foreground">工单信息</div>
            <div className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">工单号</span><span className="font-mono text-foreground">{ticket.ticket_no}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">流程模板</span><span className="text-foreground">{ticket.flow_name}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">快照版本</span><span className="text-foreground">{snapshot.version !== undefined ? `v${snapshot.version}` : '--'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">发起人</span><span className="text-foreground">{ticket.created_by_name || '--'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">发起时间</span><span className="tabular-nums text-foreground">{ticket.created_at ? new Date(ticket.created_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</span></div>
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">完结时间</span><span className="tabular-nums text-foreground">{ticket.closed_at ? new Date(ticket.closed_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</span></div>
              {ticket.claimed_by_name && (
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">认领人</span><span className="text-foreground">{ticket.claimed_by_name}</span></div>
              )}
              {(ticket.remind_count || 0) > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">超时提醒</span>
                  <span className="text-foreground" title={ticket.last_reminded_at ? `最近提醒：${new Date(ticket.last_reminded_at).toLocaleString('zh-CN', { hour12: false })}` : undefined}>
                    已提醒 {ticket.remind_count} 次
                  </span>
                </div>
              )}
              {ticket.related_alert_uuid && (
                <div className="flex justify-between gap-3"><span className="text-muted-foreground">关联告警 UUID</span><span className="truncate font-mono text-xs text-foreground" title={ticket.related_alert_uuid}>{ticket.related_alert_uuid}</span></div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 取消工单弹窗 */}
      <Modal
        open={cancelOpen}
        title="取消工单"
        onClose={() => setCancelOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCancelOpen(false)}>返回</Button>
            <Button variant="danger" size="sm" loading={cancelling} onClick={handleCancel}>确认取消</Button>
          </>
        }
      >
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            取消后工单终止流转，全部处理记录保留；不可恢复。
          </div>
          <div>
            <label className={labelCls}>取消原因<span className="text-red-500">*</span></label>
            <AutoGrowTextarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明取消该工单的原因" value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)} />
          </div>
        </div>
      </Modal>

      {/* 回退弹窗：白名单多目标时可选回退目标节点（必填原因，回退后通知目标节点处理组） */}
      <Modal
        open={rollbackOpen}
        title={rollbackTargets.length > 1 ? '退回指定节点' : '退回上一步'}
        onClose={() => setRollbackOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRollbackOpen(false)}>返回</Button>
            <Button variant="primary" size="sm" loading={rollingBack} onClick={handleRollback}>确认退回</Button>
          </>
        }
      >
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            {rollbackTargetNode
              ? `退回后工单将回到「${rollbackTargetNode.name || rollbackTargetNode.key}」节点重新处理，由该节点处理组跟进；回退原因将写入流转历史并通知对方。`
              : '请选择回退目标节点；退回后由该节点处理组跟进，回退原因将写入流转历史并通知对方。'}
          </div>
          {rollbackTargets.length > 1 && (
            <div>
              <label className={labelCls}>回退目标<span className="text-red-500">*</span></label>
              <CompactSelect size="lg" block value={rollbackTarget} onChange={(e) => setRollbackTarget(e.target.value)}>
                <option value="">请选择回退目标节点</option>
                {rollbackTargets.map((n) => <option key={n.key} value={n.key}>{n.name || n.key}</option>)}
              </CompactSelect>
            </div>
          )}
          <div>
            <label className={labelCls}>回退原因<span className="text-red-500">*</span></label>
            <AutoGrowTextarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明退回该工单的原因" value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)} />
          </div>
        </div>
      </Modal>

      {/* 转办/改派弹窗：转给其他分组（变更当前节点处理组）或指定人员（个人接管锁定） */}
      <Modal
        open={transferOpen}
        title="转办 / 改派"
        onClose={() => setTransferOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setTransferOpen(false)}>返回</Button>
            <Button variant="primary" size="sm" loading={transferring} onClick={handleTransfer}>确认转办</Button>
          </>
        }
      >
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            转办给分组：当前节点处理组整体变更为该分组（节点计时与提醒重新计算）；
            转办给人员：由该人员个人接管并锁定提交权。转办原因将写入流转历史并通知对方。
          </div>
          <div>
            <label className={labelCls}>转办对象<span className="text-red-500">*</span></label>
            <CompactSelect size="lg" block value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
              <option value="">请选择转办分组或人员</option>
              <optgroup label="转办给分组">
                {transferOptions.groups
                  .filter((g) => g.id !== currentNode?.group_id)
                  .map((g) => <option key={`g-${g.id}`} value={`group:${g.id}`}>{g.name}</option>)}
              </optgroup>
              <optgroup label="转办给人员（个人接管锁定）">
                {transferOptions.users
                  .map((u) => <option key={`u-${u.id}`} value={`user:${u.id}`}>{u.display_name || u.username}</option>)}
              </optgroup>
            </CompactSelect>
          </div>
          <div>
            <label className={labelCls}>转办原因<span className="text-red-500">*</span></label>
            <AutoGrowTextarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明转办原因（如职责调整、需专业组处理等）" value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)} />
          </div>
        </div>
      </Modal>

      {/* 抄送选择弹窗（人员 + 工单分组混合勾选，已存在的抄送对象自动排除） */}
      <CcSelectModal
        open={ccPickerOpen}
        onClose={() => setCcPickerOpen(false)}
        onConfirm={handleAddCc}
        excludeKeys={ccRows.map(ccKey)}
      />
    </PageContainer>
  )
}
