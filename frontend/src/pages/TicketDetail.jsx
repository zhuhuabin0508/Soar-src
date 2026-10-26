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
  Download, CornerUpLeft, Bot, Zap, ArrowRightLeft, UserCheck, MessageSquare, Sparkles, Search, Loader2,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputCls, labelCls, hintCls } from '../components/property/FormControls'
import { Button, PageContainer, CompactSelect, DatePicker } from '../components/ui'
import { hasPermission, guardNavPermission } from '../utils/permissions'
import ticketApi, { attachmentUrl } from '../api/tickets'
import { evalRoutes, fieldDefMap, fieldValueText, FIELD_TYPE_LABELS, flatFieldDefs, matchedRuleFields, collectRefOptions, durationToParts, durationFromParts, DURATION_UNITS } from '../utils/ticketFlow'
import { RichEditable, RichTextView, ATTACHMENT_ACCEPT, ATTACHMENT_EXTS, attachmentFileError } from '../components/TicketRichText'
import { CcChips, CcSelectModal, ccKey } from '../components/CcPicker'

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

function EnrichSourceView({ s, onFill }) {
  const t = s.threat
  const geo = t?.geo_info || {}
  const geoText = [geo.country, geo.region, geo.city, geo.isp].filter(Boolean).join(' / ')
  const na = <span className="text-muted-foreground">--</span>
  const fmtTime = (v) => (v ? String(v).replace('T', ' ') : na)
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
        {/* 资产匹配子卡：命中时展示资产全部字段 */}
        <div className="min-w-0 rounded-md border border-border bg-secondary p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
            <Database className="h-3.5 w-3.5 shrink-0 text-primary" />资产匹配
            {s.asset?.matched ? (
              <Link
                to={`/assets/list?keyword=${encodeURIComponent(s.asset.asset_ip || s.ip)}`}
                onClick={(e) => { if (!guardNavPermission('asset_list', 'view', '资产清单')) e.preventDefault() }}
                className="min-w-0 break-all font-normal text-primary hover:underline"
                title={`在资产清单中查看：${s.asset.asset_name || '--'}（${s.asset.asset_ip || s.ip}）`}
              >
                {s.asset.asset_name || '--'}
              </Link>
            ) : (
              <span className="font-normal text-muted-foreground">资产库未匹配</span>
            )}
          </div>
          {s.asset?.matched ? (
            <AssetMatchFields asset={s.asset} fallbackIp={s.ip} />
          ) : (
            <div className="text-[13px] text-muted-foreground">资产库中未找到与该 IP 匹配的资产</div>
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

// 自动研判卡片：发起时对 src_ip/dst_ip 按字段开关执行资产匹配 + 威胁情报查询
//（auto_enrich）与智能体研判（auto_agent），随工单流转只读展示
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

// 安全上下文 · 封禁查询：进入 Tab 自动查询工单涉及的 IP，支持手动输入任意 IP 查询
function BanStatusView({ autoIps }) {
  const navigate = useNavigate()
  const { id: currentTicketId } = useParams()
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
  const entries = result ? Object.entries(result) : []
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldBan className="h-4 w-4 text-primary" />
        <span className="font-semibold text-foreground">已封禁 IP 查询</span>
        <span className="text-xs text-muted-foreground">查询 IP 地址是否正处于封禁期间（工作台封禁记录 / 工单同步 / 旧版封禁列表）</span>
      </div>
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
      {!!entries.length && (
        <div className="space-y-2">
          {entries.map(([ip, st]) => (
            <div key={ip} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">{ip}</span>
                {st.banned ? (
                  <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-500">封禁中</span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">未封禁</span>
                )}
              </div>
              {st.banned ? (
                <div className="mt-2 space-y-2">
                  {st.items.map((it, i) => (
                    <div key={i} className="rounded-md bg-muted p-2.5 text-[13px]">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium text-foreground">{it.source_label}</span>
                        <span className="text-muted-foreground">等级：{it.ban_level_label}</span>
                        <span className="text-muted-foreground">
                          {it.is_permanent ? '永久封禁' : `解封时间：${it.expire_time ? new Date(it.expire_time).toLocaleString('zh-CN', { hour12: false }) : '--'}`}
                        </span>
                        {!it.is_permanent && it.remaining_ms != null && (
                          <span className="text-muted-foreground">剩余：{fmtBanRemaining(it.remaining_ms)}</span>
                        )}
                      </div>
                      <div className="mt-1 text-muted-foreground">开始封禁时间：{it.started_at ? new Date(it.started_at).toLocaleString('zh-CN', { hour12: false }) : '--'}</div>
                      {it.ban_device && <div className="mt-1 text-muted-foreground">封禁设备：{it.ban_device}</div>}
                      {it.reason && <div className="mt-1 break-all text-muted-foreground">原因：{it.reason}</div>}
                      {it.ticket_id && (
                        // 来源即当前工单时 navigate 同路由无任何变化，改为静态标识避免“点击无响应”
                        Number(it.ticket_id) === Number(currentTicketId) ? (
                          <span className="mt-1.5 inline-flex items-center gap-1 text-[13px] text-muted-foreground">
                            <Link2 className="h-3.5 w-3.5" />封禁来源：当前工单 {it.ticket_no}
                          </span>
                        ) : (
                          <button onClick={() => navigate(`/tickets/${it.ticket_id}`)}
                            className="mt-1.5 inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
                            <Link2 className="h-3.5 w-3.5" />查看来源工单 {it.ticket_no}
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[13px] text-muted-foreground">该 IP 暂未封禁</p>
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
        }
      })
      .catch((e) => toast.error(e.message || '加载工单失败'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  // 智能体研判后台进行中（agent.pending）：静默轮询刷新研判结果
  //（只更新 ticket，不重置当前节点表单/意见，完成后停止轮询）
  const hasPendingAgent = useMemo(
    () => (ticket?.enrichment_data?.sources || []).some((s) => s?.agent?.pending),
    [ticket],
  )
  useEffect(() => {
    if (!hasPendingAgent) return undefined
    const timer = setInterval(() => {
      ticketApi.getTicket(id)
        .then((res) => setTicket(res))
        .catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [hasPendingAgent, id])

  const snapshot = ticket?.flow_snapshot || {}
  const nodes = snapshot.nodes || []
  const currentNode = ticket?.current_node
  const { options: routeOptions, suggested: routeSuggested } = useMemo(
    () => evalRoutes(currentNode?.routes, values),
    [currentNode, values],
  )
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
  const setFieldValue = (key, v) => {
    setValues((s) => ({ ...s, [key]: v }))
    if (missingKeys.includes(key)) setMissingKeys((ks) => ks.filter((k) => k !== key))
  }
  // inputCls 自带 border-input，红框需 !important 覆盖（Tailwind 同特异性按生成顺序，destructive 会被 input 吃掉）
  const fieldCls = (f) => (missingKeys.includes(f.key) ? `${inputCls} !border-destructive ring-1 !ring-destructive` : inputCls)

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
    // 未命中规则的扩展字段的值不提交
    const submitValues = Object.fromEntries(renderFields.map(({ field: f }) => [f.key, values[f.key]]))
    if (routeOptions.length > 1 && !routeTo) return toast.error('请选择流转去向')
    const targetKey = routeTo || routeSuggested || ''
    const target = nodes.find((n) => n.key === targetKey)
    // 会签感知的确认文案：当前并行节点中间提交 / 目标并行节点 / 目标结束 / 普通流转
    const sp = ticket?.sign_progress
    let message
    if (currentNode?.type === 'parallel' && (sp?.pending?.length || 0) > 1) {
      message = `本节点为并行会签节点（待签 ${sp.pending.length} 组），本次提交代表本分组完成会签，其余分组全部会签完成后工单才继续流转。确认提交？`
    } else if (target?.type === 'end') {
      message = '提交后工单将流转至结束节点并标记为已完成，确认提交？'
    } else if (target?.type === 'parallel') {
      const names = (target.sign_groups || []).map((g) => ticket.group_names?.[String(g)]).filter(Boolean).join('、')
      message = `提交后工单将流转至「${target.name || targetKey}」，由${names || '多分组'}并行会签（${target.finish_policy === 'any' ? '任一分组提交即流转' : '全部完成后才继续流转'}）。确认提交？`
    } else {
      message = `提交后工单将流转至「${target?.name || targetKey}」（由${ticket.group_names?.[String(target?.group_id)] || '对应分组'}处理），组内任一成员提交即代表全组。确认提交？`
    }
    confirm({ title: '确认提交流转', message, confirmText: '提交流转' }).then((ok) => {
      if (!ok) return
      setSubmitting(true)
      ticketApi.advanceTicket(id, {
        field_values: submitValues,
        route_to: targetKey,
        comment: comment.trim() || null,
      })
        .then((res) => {
          toast.success(target?.type === 'end' ? '工单已完成' : `已流转至「${target?.name}」`)
          setTicket(res)
          setValues({})
          setComment('')
          setMissingKeys([])
        })
        .catch((e) => toast.error(e.message || '流转失败'))
        .finally(() => setSubmitting(false))
    })
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

  // 打开转办弹窗：加载启用用户 + 启用分组（复用抄送候选数据源）
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
                      <input className={fieldCls(f)} placeholder={f.placeholder || (f.type === 'ip' ? '如：192.168.1.10' : '')} value={values[f.key] ?? ''}
                        onChange={(e) => setFieldValue(f.key, e.target.value)} />
                    )}
                    {f.type === 'reference' && (() => {
                      const opts = refOpts[f.key] || []
                      if (f.allow_custom) {
                        return (
                          <>
                            <input className={fieldCls(f)} list={`ref-opts-${f.key}`}
                              placeholder={f.placeholder || '可输入，或从已填过的值中选择'}
                              value={values[f.key] ?? ''} onChange={(e) => setFieldValue(f.key, e.target.value)} />
                            <datalist id={`ref-opts-${f.key}`}>
                              {opts.map((o) => <option key={o} value={o} />)}
                            </datalist>
                          </>
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
                              <input type="number" min="0" className={fieldCls(f)} placeholder="如：30"
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
                    <label className={labelCls}>流转去向<span className="text-red-500">*</span></label>
                    <div className="flex flex-wrap gap-2">
                      {routeOptions.map((r) => {
                        const isSug = routeSuggested === r.to
                        const target = nodes.find((n) => n.key === r.to)
                        return (
                          <button key={r.to} type="button" onClick={() => setRouteTo(r.to)}
                            className={`rounded-md border px-3 py-1.5 text-[13px] font-medium transition ${routeTo === r.to ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:border-primary/50'}`}>
                            {r.label || target?.name || r.to}
                            {isSug && <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-500">条件建议</span>}
                          </button>
                        )
                      })}
                    </div>
                    <p className={hintCls}>按已填内容自动建议流向（绿色标记），可点击调整</p>
                  </div>
                )}
                {routeOptions.length === 1 && routeOptions[0].to && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <SendHorizonal className="h-3.5 w-3.5" />
                    提交后流转至「{nodes.find((n) => n.key === routeOptions[0].to)?.name || routeOptions[0].to}」
                  </div>
                )}

                <div>
                  <label className={labelCls}>处理意见（选填）</label>
                  <RichEditable className={inputCls} minHeight={64} placeholder="填写本节点的处理说明，可直接粘贴截图" value={comment}
                    onChange={setComment} />
                </div>
                <Button variant="primary" className="w-full" loading={submitting} onClick={handleSubmit}>
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
            <textarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明取消该工单的原因" value={cancelReason}
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
            <textarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明退回该工单的原因" value={rollbackReason}
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
            <textarea className={`${inputCls} resize-y`} rows={3} placeholder="请说明转办原因（如职责调整、需专业组处理等）" value={transferReason}
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
