// 工单安全上下文（自动研判 v2 多 IP）展示与交互组件。
//
// 设计（分层折叠，见 docs/工单多IP安全上下文分层展示与交互设计方案.md）：
// - L1 统计头（默认展开；仍可一键收起）：IP 总数 + 黑名单/资产/情报三维风险
//   标签统计 chips（点击 chip = 展开并按该维度过滤）；
// - L2 工具栏（展开后）：风险筛选 / 排序 / 全选 / 全部展开（≤50）/ 导出；
// - L3 IP 列表（按 源/目的 分组）：
//   · <50：内联展开详情（初始化后默认全部展开，单行可独立折叠）；
//   · ≥50：列表固定高度 + 虚拟滚动（@tanstack/react-virtual，行高 44px），
//     行高统一保证窗口化成立，详情改走右侧抽屉；
// - 批量操作（勾选后底部浮条）：查询封禁（20/批 × 并发 2 自动分批）、
//   重新研判（>20 个转后台轮询）、导出所选（前端 xlsx 组装）；
// - 黑名单为设备实时状态：不落库，进入 Tab 自动分批查询（会话级缓存，
//   切 Tab 不重复请求）；
// - 存量 v1 工单（sources 结构）走旧卡片渲染，零回归。
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ShieldCheck, ShieldBan, Database, AlertTriangle, Bot, Sparkles, Search,
  Download, Copy, Check, RefreshCw, ChevronDown, ChevronRight, X, Loader2, ListCollapse,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from './ConfirmDialog'
import { Drawer } from './Dialog'
import { Button } from './ui'
import { inputCls, hintCls } from './property/FormControls'
import { guardNavPermission } from '../utils/permissions'
import ticketApi from '../api/tickets'
import { exportEnrichmentXlsx } from '../utils/ticketEnrichExport'
import { flatFieldDefs } from '../utils/ticketFlow'
import { useVirtualizer } from '@tanstack/react-virtual'

// ============ 展示映射 ============

const THREAT_SEVERITY_LABELS = { high: '高', medium: '中', low: '低' }
const AGENT_RISK_CLS = {
  严重: 'bg-red-500/10 text-red-500', 高危: 'bg-red-500/10 text-red-500', 高: 'bg-red-500/10 text-red-500',
  中危: 'bg-amber-500/10 text-amber-500', 中: 'bg-amber-500/10 text-amber-500',
  低危: 'bg-sky-500/10 text-sky-500', 低: 'bg-sky-500/10 text-sky-500',
}
const AGENT_ACTION_LABELS = { ban: '建议封禁', monitor: '观察监控', ignore: '忽略（暂不处置）' }

// ============ IP 一键复制 ============

// 复制文本：优先异步剪贴板 API（仅 https / localhost 等安全上下文可用），
// 其余情况（http 内网访问、旧浏览器）回退到隐藏 textarea + execCommand，
// 不引入任何第三方依赖，兼容 Chrome/Edge/Firefox/Safari。
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒 / 非安全上下文：走兼容方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// IP 复制图标：通用剪贴板样式，置于 IP 右侧；复制成功 1.5s 内切换为对勾 +
// 悬浮「已复制」气泡（绝对定位，不撑开布局），hover/active 有明确反馈。
// 行内使用时阻止冒泡，避免触发「展开详情 / 打开抽屉」。
function CopyIpButton({ ip, className = '' }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  useEffect(() => () => clearTimeout(timerRef.current), [])
  const handleCopy = async (ev) => {
    ev.stopPropagation()
    const ok = await copyTextToClipboard(ip)
    if (!ok) {
      toast.error('复制失败，请手动选择 IP 复制')
      return
    }
    setCopied(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span className={`relative inline-flex shrink-0 items-center ${className}`}>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? '已复制' : `复制 IP ${ip}`}
        aria-label={copied ? `已复制 ${ip}` : `复制 IP ${ip}`}
        className={`flex items-center justify-center rounded p-1 transition active:scale-90 ${
          copied
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {copied && (
        <span className="pointer-events-none absolute -top-6 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background shadow-sm">
          已复制
        </span>
      )}
    </span>
  )
}
const ASSET_CRITICALITY_LABELS = { low: '低', medium: '中', high: '高', critical: '严重' }
const ASSET_STATUS_LABELS = { in_use: '在用', idle: '闲置', repair: '维修', retired: '报废', lost: '丢失' }
const ASSET_SOURCE_LABELS = { kb_ingest: '知识库梳理', manual: '手动录入', agent_add: '对话录入' }

const isHighSeverity = (s) => ['high', 'critical'].includes(s)
const isHighCriticality = (e) => isHighSeverity(e?.asset?.inventory?.fields?.criticality)

function EnrichRow({ label, children }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words leading-relaxed">{children}</span>
    </div>
  )
}

function fmtAgentReasonText(reasons) {
  if (Array.isArray(reasons)) return reasons.length ? null : '--'
  if (reasons == null || reasons === '') return '--'
  return String(reasons)
}

function fmtAssetVal(v) {
  if (v == null || v === '') return null
  if (Array.isArray(v)) return v.length ? v.map(String).join('、') : null
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ============ 资产匹配详情子块（从 TicketDetail.jsx 迁移，展示口径不变） ============

function AssetMatchFields({ asset, fallbackIp }) {
  const na = <span className="text-muted-foreground">--</span>
  const f = asset.fields
  const rows = []
  const push = (label, v) => rows.push([label, fmtAssetVal(v)])
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
    const extra = f.extra_fields && typeof f.extra_fields === 'object' && !Array.isArray(f.extra_fields) ? f.extra_fields : {}
    Object.entries(extra).forEach(([k, v]) => push(k, v))
  } else {
    push('IP 地址', asset.asset_ip || fallbackIp)
  }
  const tags = f?.tags || []
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] leading-relaxed sm:grid-cols-2">
      {rows.map(([label, text]) => (
        <div key={label} className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 text-muted-foreground">{label}：</span>
          <span className="min-w-0 break-words">{text != null ? text : na}</span>
        </div>
      ))}
      <div className="col-span-1 flex min-w-0 items-start gap-2 sm:col-span-2">
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

const DISCOVERY_FIELD_LABELS = [
  ['资源类型', 'resource_label'], ['实例名称', 'instance_name'], ['IP 地址', 'ip_address'],
  ['浮动 IP', 'floatip_address'], ['网段', 'cidr'], ['所属部门', 'user_department'],
  ['申请部门', 'applicant_department'], ['操作系统', 'operating_system'],
  ['主机状态', 'host_status'], ['资源区域', 'biz_region_name'], ['带宽(M)', 'bandwidth'],
  ['绑定实例', 'bind_instance'], ['CMDB ID', 'cmdb_id'], ['实例 ID', 'instance_id'], ['唯一标识', 'source_id'],
]

const SOURCE_TONES = {
  discovery: {
    box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
    dot: 'bg-emerald-500', accent: 'border-l-emerald-500/70',
  },
  inventory: {
    box: 'border-primary/30 bg-primary/10 text-primary',
    dot: 'bg-primary', accent: 'border-l-primary/70',
  },
}

function SourceLabel({ tone = 'inventory', sm = false, children }) {
  const c = SOURCE_TONES[tone] || SOURCE_TONES.inventory
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded border font-semibold ${sm ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'} ${c.box}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  )
}

function DiscoveryMatchFields({ asset, fallbackIp }) {
  const na = <span className="text-muted-foreground">--</span>
  const matches = Array.isArray(asset.matches) && asset.matches.length ? asset.matches : [asset]
  const multi = matches.length > 1
  return (
    <div className="space-y-2">
      {matches.map((m, idx) => (
        <div key={m.source_id || m.cmdb_id || idx} className={multi ? 'rounded border border-border/60 bg-background/60 p-2' : ''}>
          {multi ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <SourceLabel tone="discovery" sm>{m.source_label || m.resource_label || '资产发现'}</SourceLabel>
              <span className="text-[11px] text-muted-foreground">#{idx + 1}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] leading-relaxed sm:grid-cols-2">
            {DISCOVERY_FIELD_LABELS.map(([label, key]) => {
              const raw = m[key] ?? (key === 'ip_address' ? (asset.asset_ip || fallbackIp) : null)
              const text = fmtAssetVal(raw)
              return (
                <div key={key} className="flex min-w-0 items-start gap-2">
                  <span className="shrink-0 text-muted-foreground">{label}：</span>
                  <span className="min-w-0 break-words">{text != null ? text : na}</span>
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

// ============ 单 IP 详情块（v1/v2 共用；entry 含 ip/roles/threat/asset/agent） ============

function EnrichEntryDetail({ entry, roleText, onFill, onRequery, liteHint, stacked = false }) {
  // stacked：抽屉等窄容器场景 —— 资产匹配/威胁情报上下堆叠各占全宽，避免并排窄列导致长字段换行拥挤；
  // 默认（行内展开，页面宽区域）保持 xl 双列布局。
  const t = entry.threat && typeof entry.threat === 'object' ? entry.threat : null
  const geo = t?.geo_info || {}
  const geoText = [geo.country, geo.region, geo.city, geo.isp].filter(Boolean).join(' / ')
  const na = <span className="text-muted-foreground">--</span>
  const fmtTime = (v) => (v ? String(v).replace('T', ' ') : na)
  const assetMatch = entry.asset || {}
  const legacyOnly = !assetMatch.discovery && !assetMatch.inventory
  const legacyTone = legacyOnly && assetMatch.source === 'asset_discovery' ? 'discovery' : 'inventory'
  const legacyLabel = legacyTone === 'discovery' ? '资产发现' : '资产清单'
  const inventoryAsset = assetMatch.inventory || (legacyOnly ? assetMatch : null)
  const inventoryLabel = assetMatch.inventory?.source_label || assetMatch.source_label || legacyLabel
  return (
    <div className={`grid grid-cols-1 gap-3 leading-relaxed ${stacked ? '' : 'xl:grid-cols-2'}`}>
      {/* 资产匹配子卡 */}
      <div className="min-w-0 rounded-md border border-border bg-secondary p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
          <Database className="h-3.5 w-3.5 shrink-0 text-primary" />资产匹配
          {assetMatch.matched ? (
            assetMatch.source === 'asset_discovery' ? (
              <Link
                to={`/assets/discovery?keyword=${encodeURIComponent(assetMatch.asset_ip || entry.ip)}${assetMatch.resource_type ? `&table=${encodeURIComponent(assetMatch.resource_type)}` : ''}`}
                onClick={(e) => { if (!guardNavPermission('asset_discovery', 'view', '资产发现')) e.preventDefault() }}
                className="min-w-0 break-words font-normal text-primary hover:underline"
              >
                {assetMatch.asset_name || '--'}
              </Link>
            ) : (
              <Link
                to={`/assets/list?keyword=${encodeURIComponent(assetMatch.asset_ip || entry.ip)}`}
                onClick={(e) => { if (!guardNavPermission('asset_list', 'view', '资产清单')) e.preventDefault() }}
                className="min-w-0 break-words font-normal text-primary hover:underline"
              >
                {assetMatch.asset_name || '--'}
              </Link>
            )
          ) : (
            <span className="font-normal text-muted-foreground">资产库未匹配</span>
          )}
        </div>
        {assetMatch.matched ? (
          <div className="space-y-2.5">
            {assetMatch.discovery ? (
              <div className={`min-w-0 rounded-md border border-border/60 border-l-2 bg-background/50 p-2.5 ${SOURCE_TONES.discovery.accent}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <SourceLabel tone="discovery">{assetMatch.discovery.source_label || '资产发现'}</SourceLabel>
                </div>
                <DiscoveryMatchFields asset={assetMatch.discovery} fallbackIp={entry.ip} />
              </div>
            ) : null}
            {inventoryAsset ? (
              <div className={`min-w-0 rounded-md border border-border/60 border-l-2 bg-background/50 p-2.5 ${SOURCE_TONES[legacyTone].accent}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <SourceLabel tone={legacyTone}>{inventoryLabel}</SourceLabel>
                </div>
                <AssetMatchFields asset={inventoryAsset} fallbackIp={entry.ip} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-[13px] text-muted-foreground">资产发现与资产清单中均未找到与该 IP 匹配的资产</div>
        )}
      </div>
      {/* 威胁情报子卡 */}
      <div className="min-w-0 rounded-md border border-border bg-secondary p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-primary" />威胁情报
          {liteHint && <span className="font-normal text-muted-foreground">（精简结果，点击"重新研判"获取完整情报）</span>}
        </div>
        {t ? (
          <>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] leading-relaxed sm:grid-cols-2">
              <EnrichRow label="研判结论：">
                {t.is_malicious ? <span className="font-medium text-red-500">恶意</span> : <span className="font-medium text-emerald-500">非恶意</span>}
              </EnrichRow>
              <EnrichRow label="置信度：">{t.confidence != null ? `${Math.round(t.confidence * 100)}%` : na}</EnrichRow>
              <EnrichRow label="严重程度：">{t.severity ? (THREAT_SEVERITY_LABELS[t.severity] || t.severity) : na}</EnrichRow>
              <EnrichRow label="威胁标签：">
                {t.tags?.length ? (
                  <span className="flex flex-wrap gap-1">
                    {t.tags.map((tag) => (
                      <span key={tag} className="whitespace-nowrap rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-500">{tag}</span>
                    ))}
                  </span>
                ) : na}
              </EnrichRow>
              <EnrichRow label="威胁类型：">{t.threat_types?.length ? t.threat_types.join('、') : na}</EnrichRow>
              <EnrichRow label="首次发现：">{fmtTime(t.first_seen)}</EnrichRow>
              <EnrichRow label="最近发现：">{fmtTime(t.last_seen)}</EnrichRow>
              <EnrichRow label="地理/归属：">{geoText || na}</EnrichRow>
              <EnrichRow label="关联恶意软件：">{t.related_malware?.length ? t.related_malware.join('、') : na}</EnrichRow>
              <EnrichRow label="情报来源：">{t.source || na}</EnrichRow>
              <EnrichRow label="攻击模式：">{t.attack_patterns?.length ? t.attack_patterns.join('；') : na}</EnrichRow>
            </div>
            <div className="mt-2 flex min-w-0 items-start gap-2 text-[13px]">
              <span className="shrink-0 text-muted-foreground">情报描述：</span>
              {t.description
                ? <span className="min-w-0 break-words rounded-md bg-muted px-3 py-1.5 leading-relaxed text-foreground">{t.description}</span>
                : na}
            </div>
          </>
        ) : entry.threat === null ? (
          <div className="text-[13px] text-muted-foreground">威胁情报查询失败，可"重新研判"重试</div>
        ) : (
          <div className="text-[13px] text-muted-foreground">未开启威胁情报查询</div>
        )}
      </div>
      {/* 智能体研判子卡 */}
      {entry.agent !== undefined && (
        <div className={`min-w-0 rounded-md border border-border bg-secondary p-3 ${stacked ? '' : 'xl:col-span-2'}`}>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Bot className="h-3.5 w-3.5 text-primary" />智能体研判
            <span className="font-normal text-muted-foreground">IP风险智能研判与封禁决策</span>
            {onFill && entry.agent && !entry.agent.pending && (
              <button type="button" onClick={() => onFill({ ...entry, label: roleText })}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 text-[11px] font-normal text-primary transition hover:bg-primary/10"
                title="将智能体研判结果一键填入处理意见，可编辑后提交">
                <Sparkles className="h-3 w-3" />填入处置意见
              </button>
            )}
          </div>
          {entry.agent?.pending ? (
            <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <span className="flex items-end gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
              </span>
              智能体正在思考中，研判结果将自动更新…
            </div>
          ) : entry.agent ? (
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] leading-relaxed xl:grid-cols-2">
              <div className="grid content-start gap-y-1.5">
                <EnrichRow label="风险等级：">
                  <span className={`inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${AGENT_RISK_CLS[entry.agent.risk_level] || 'bg-muted text-muted-foreground'}`}>
                    {entry.agent.risk_level || '未知'}
                  </span>
                </EnrichRow>
                <EnrichRow label="处置建议：">
                  <span>
                    {AGENT_ACTION_LABELS[entry.agent.action] || entry.agent.action || na}
                    {entry.agent.monitoring_advice ? `（${entry.agent.monitoring_advice}）` : ''}
                  </span>
                </EnrichRow>
              </div>
              <EnrichRow label="决策依据：">
                {Array.isArray(entry.agent.reasons) && entry.agent.reasons.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {entry.agent.reasons.map((r, i) => <li key={i} className="break-words">{String(r)}</li>)}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">{fmtAgentReasonText(entry.agent.reasons)}</span>
                )}
              </EnrichRow>
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">智能体研判失败</div>
          )}
        </div>
      )}
      {onRequery && (
        <div className={`flex items-center gap-2 ${stacked ? '' : 'xl:col-span-2'}`}>
          <Button size="sm" variant="outline" className="h-7" onClick={onRequery}>
            <RefreshCw className="mr-1 h-3 w-3" />重新研判该 IP
          </Button>
          <span className="text-xs text-muted-foreground">重跑资产匹配与威胁情报，并升级为完整档</span>
        </div>
      )}
    </div>
  )
}

// ============ 安博通黑名单字段格式化（封禁查询结果展示） ============

function fmtBanRemaining(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d) return `${d}天${h}小时`
  if (h) return `${h}小时${mm}分`
  return `${mm}分钟`
}

const ANBOTONG_ENTRY_LABELS = {
  blist: '黑名单条目', age: '封禁时长', leftTime: '剩余时长', effectTime: '生效时间',
  reason: '封禁原因', policy_group_name: '策略组', state: '状态', enable: '启用',
  hit_num: '命中次数', node_id: '节点 ID',
}

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

// ============ 黑名单实时查询：会话级缓存（页面生命周期，切 Tab 不重复查询） ============

const BAN_CHUNK = 20           // 设备端点单次上限
const BAN_CONCURRENCY = 2       // 批间并发
const _banCache = new Map()     // `${ticketId}::${ip}` → { banned, entry, error, note, raw }

const banCacheKey = (ticketId, ip) => `${ticketId}::${ip}`
const banFromCache = (ticketId, ips) => {
  const m = new Map()
  ips.forEach((ip) => {
    const st = _banCache.get(banCacheKey(ticketId, ip))
    if (st) m.set(ip, st)
  })
  return m
}

// ============ 主组件 ============

const VIRTUAL_THRESHOLD = 50     // 超过后启用虚拟滚动 + 详情抽屉

// 风险排序权重：恶意 > 封禁中 > 高危情报 > 重要资产 > 资产命中 > 其他
const riskRank = (e, banMap) => {
  let r = 100
  if (e.threat?.is_malicious) r -= 64
  if (banMap.get(e.ip)?.banned) r -= 32
  if (isHighSeverity(e.threat?.severity)) r -= 16
  if (isHighCriticality(e)) r -= 8
  if (e.asset?.matched) r -= 4
  if (e.threat === null || e.asset?.error) r -= 2
  return r
}

const ipNum = (ip) => {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return m ? (((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4]) : null
}
const ipCompare = (a, b) => {
  const na = ipNum(a)
  const nb = ipNum(b)
  if (na !== null && nb !== null) return na - nb
  return a.localeCompare(b)
}

const FILTER_DEFS = [
  { key: 'malicious', label: '仅恶意' },
  { key: 'ban', label: '黑名单命中' },
  { key: 'severityHigh', label: '高危情报' },
  { key: 'asset', label: '资产命中' },
  { key: 'assetCritical', label: '重要资产' },
  { key: 'unmatched', label: '未匹配' },
  { key: 'failed', label: '查询失败' },
]

const matchesFilters = (e, banMap, filters) => {
  for (const f of filters) {
    const ban = banMap.get(e.ip)
    if (f === 'malicious' && !e.threat?.is_malicious) return false
    if (f === 'ban' && !ban?.banned) return false
    if (f === 'severityHigh' && !isHighSeverity(e.threat?.severity)) return false
    if (f === 'asset' && !e.asset?.matched) return false
    if (f === 'assetCritical' && !isHighCriticality(e)) return false
    if (f === 'unmatched' && e.asset?.matched) return false
    if (f === 'failed' && !(e.threat === null || e.asset?.error)) return false
  }
  return true
}

const FILTER_CHIP_CLS = {
  red: 'border-red-500/40 bg-red-500/10 text-red-600',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-600',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  muted: 'border-border bg-muted text-muted-foreground',
}
// 查询失败为「情报失败 ∪ 资产失败」并集，统计与筛选复用同一口径
const FAILED_FILTER = new Set(['failed'])

function StatChip({ tone = 'muted', active = false, onClick, children, title }) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium transition hover:border-primary/60 ${active ? FILTER_CHIP_CLS.primary : FILTER_CHIP_CLS[tone]}`}
    >
      {children}
    </button>
  )
}

export default function TicketEnrichment({ ticket, enrichment, onFill, onTicketUpdate }) {
  const isV2 = Array.isArray(enrichment?.ips)
  const roleLabels = useMemo(() => enrichment?.role_labels || { src_ip: '源IP地址', dst_ip: '目的IP地址' }, [enrichment])
  const entries = useMemo(
    () => (isV2 ? (enrichment.ips || []).filter((e) => e && typeof e === 'object') : []),
    [enrichment, isV2],
  )
  // v1 存量工单：研判 IP + IP 类型字段已填值（与旧 BanStatusView 的口径一致）
  const legacyAutoIps = useMemo(() => {
    if (isV2) return []
    const out = []
    const push = (v) => {
      const s = String(v || '').trim()
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) && !out.includes(s)) out.push(s)
    }
    ;(enrichment?.sources || []).forEach((s) => push(s?.ip))
    const ipKeys = new Set()
    ;(ticket?.flow_snapshot?.nodes || []).forEach((n) => {
      flatFieldDefs(n.fields || []).forEach((f) => { if (f.type === 'ip') ipKeys.add(f.key) })
    })
    ;(ticket?.records || []).forEach((r) => {
      Object.entries(r.field_values || {}).forEach(([k, v]) => { if (ipKeys.has(k)) push(v) })
    })
    return out.slice(0, 20)
  }, [isV2, enrichment, ticket])

  // ===== 展开状态（初始化默认展开，可手动收起）=====
  const [expanded, setExpanded] = useState(true)
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), [])
  const expandWithFilters = useCallback((filters) => {
    setFilters(new Set(filters))
    setExpanded(true)
  }, [])

  // ===== 列表状态 =====
  const [filters, setFilters] = useState(new Set())
  const [sort, setSort] = useState('default')
  const [selection, setSelection] = useState(new Set())
  const [openRows, setOpenRows] = useState(new Set())     // <50 内联展开（单开）
  const [drawerIp, setDrawerIp] = useState(null)          // ≥50 详情抽屉
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())

  // ===== 黑名单分批查询 =====
  const [banMap, setBanMap] = useState(() => banFromCache(ticket.id, entries.map((e) => e.ip)))
  const [banProgress, setBanProgress] = useState({ loading: false, done: 0, total: 0, failedChunks: [] })
  const [banDeviceError, setBanDeviceError] = useState(null)
  const autoQueriedRef = useRef(false)

  const [requerying, setRequerying] = useState(false)
  const scrollRef = useRef(null)

  const virtual = entries.length > VIRTUAL_THRESHOLD

  // 统计：优先读后端 stats（发起时算好），缺省兜底前端计算
  const stats = useMemo(() => {
    const s = enrichment?.stats || {}
    const banned = entries.reduce((n, e) => n + (banMap.get(e.ip)?.banned ? 1 : 0), 0)
    return {
      total: s.total ?? entries.length,
      src: s.src ?? entries.filter((e) => (e.roles || []).includes('src_ip')).length,
      dst: s.dst ?? entries.filter((e) => (e.roles || []).includes('dst_ip')).length,
      malicious: s.malicious ?? entries.filter((e) => e.threat?.is_malicious).length,
      severityHigh: s.severity_high ?? entries.filter((e) => isHighSeverity(e.threat?.severity)).length,
      assetMatched: s.asset_matched ?? entries.filter((e) => e.asset?.matched).length,
      assetCritical: s.asset_critical ?? entries.filter((e) => isHighCriticality(e)).length,
      failed: entries.filter((e) => matchesFilters(e, banMap, FAILED_FILTER)).length,
      pending: s.pending ?? entries.some((e) => e.pending),
      totalOriginal: s.total_original,
      banned,
    }
  }, [enrichment, entries, banMap])

  // ===== 黑名单批量查询（20/批 × 并发 2，渐进渲染） =====
  const runBanQuery = useCallback(async (ips, opts = {}) => {
    const list = [...new Set(ips.filter(Boolean))]
    if (!list.length) return
    const chunks = []
    for (let i = 0; i < list.length; i += BAN_CHUNK) chunks.push(list.slice(i, i + BAN_CHUNK))
    const queue = chunks.map((c, i) => [i, c])
    const failedChunks = new Set()
    setBanProgress({ loading: true, done: 0, total: list.length, failedChunks: [] })
    let done = 0
    const worker = async () => {
      while (queue.length) {
        const next = queue.shift()
        if (!next) return
        const [ci, chunkIps] = next
        try {
          const res = await ticketApi.banStatus(chunkIps)
          if (res.device_error) {
            setBanDeviceError(res.device_error)
            failedChunks.add(ci)
          } else {
            setBanDeviceError(null)
            const results = res.results || {}
            chunkIps.forEach((ip) => {
              const st = results[ip]
              if (st && !st.error) {
                _banCache.set(banCacheKey(ticket.id, ip), {
                  banned: !!st.banned, entry: st.entry || null, raw: st.raw || null, note: st.note || null,
                })
              } else {
                failedChunks.add(ci)
              }
            })
          }
        } catch {
          failedChunks.add(ci)
        }
        done += chunkIps.length
        setBanProgress({ loading: true, done, total: list.length, failedChunks: [...failedChunks] })
        setBanMap(banFromCache(ticket.id, entries.map((e) => e.ip)))
      }
    }
    await Promise.all(Array.from({ length: Math.min(BAN_CONCURRENCY, chunks.length) }, worker))
    setBanProgress({ loading: false, done, total: list.length, failedChunks: [...failedChunks] })
    if (failedChunks.size && !opts.silent) {
      toast.error(`${failedChunks.size} 批黑名单查询失败，可点击"重试失败批次"`)
    }
  }, [ticket.id, entries])

  // 进入 Tab 自动查询全部研判 IP（缓存跳过已查过的）
  useEffect(() => {
    if (!isV2 || autoQueriedRef.current) return
    autoQueriedRef.current = true
    const missing = entries.map((e) => e.ip).filter((ip) => !_banCache.has(banCacheKey(ticket.id, ip)))
    if (missing.length) runBanQuery(missing, { silent: true })
  }, [isV2, entries, ticket.id, runBanQuery])

  // ===== 筛选 / 排序 / 分组视图 =====
  const filtered = useMemo(() => {
    const list = entries.filter((e) => matchesFilters(e, banMap, filters))
    if (sort === 'risk') list.sort((a, b) => riskRank(a, banMap) - riskRank(b, banMap) || ipCompare(a.ip, b.ip))
    else if (sort === 'ip') list.sort((a, b) => ipCompare(a.ip, b.ip))
    return list
  }, [entries, filters, sort, banMap])

  const roleGroups = useMemo(() => {
    // 同一 IP 跨源/目的双角色时只在首个所属分组展示一行（行内"双"标记 + 详情标注完整角色），
    // 避免同一 IP 在多个分组重复出现导致勾选联动与列表膨胀。
    const groups = []
    const order = ['src_ip', 'dst_ip']
    const present = new Set(entries.flatMap((e) => e.roles || []))
    const shownAll = new Set()     // 未筛选口径：统计双角色被折叠数
    const shown = new Set()        // 筛选后口径：控制行只展示一次
    order.forEach((role) => {
      if (!present.has(role)) return
      const roleEntries = entries.filter((e) => (e.roles || []).includes(role))
      const dropped = roleEntries.filter((e) => shownAll.has(e.ip)).length
      roleEntries.forEach((e) => shownAll.add(e.ip))
      const ips = filtered.filter((e) => (e.roles || []).includes(role) && !shown.has(e.ip))
      ips.forEach((e) => shown.add(e.ip))
      if (!ips.length) return
      groups.push({ role, label: roleLabels[role] || role, ips, dropped })
    })
    return groups
  }, [filtered, entries, roleLabels])

  // 展开时若筛选无结果，清掉筛选（避免"空列表"困惑）——不强制，仅提示

  const toggleFilter = useCallback((key) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // 统计 chip：未激活时替换为该维度筛选（保持原有语义），已激活时取消该筛选
  const applyChipFilter = useCallback((key) => {
    if (filters.has(key)) toggleFilter(key)
    else expandWithFilters([key])
  }, [filters, toggleFilter, expandWithFilters])

  const toggleSelect = useCallback((ip) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(ip)) next.delete(ip)
      else next.add(ip)
      return next
    })
  }, [])

  const selectIps = useCallback((ips, value) => {
    setSelection((prev) => {
      const next = new Set(prev)
      ips.forEach((ip) => (value ? next.add(ip) : next.delete(ip)))
      return next
    })
  }, [])

  const toggleRow = useCallback((ip) => {
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(ip)) next.delete(ip)
      else next.add(ip)
      return next
    })
  }, [])

  // 初始化加载完成后自动展开全部可折叠模块：列表本身默认展开（expanded），
  // 分组默认展开（collapsedGroups 初始为空）；≤50 时行内详情一次性全展开。
  // 仅执行一次：用户后续手动折叠/展开不会被数据轮询刷新覆盖。
  const autoExpandedRef = useRef(false)
  useEffect(() => {
    if (autoExpandedRef.current || !expanded || !entries.length) return
    autoExpandedRef.current = true
    // ≥50 走虚拟滚动 + 右侧抽屉，行内无折叠态，无需展开行
    if (entries.length > VIRTUAL_THRESHOLD) return
    setOpenRows(new Set(entries.map((e) => e.ip)))
  }, [expanded, entries])

  // ===== 批量操作 =====
  const requeryIps = useCallback(async (ips) => {
    if (!ips.length) return toast.error('请先勾选 IP')
    if (ticket.status !== 'processing') return toast.error('工单已完结，不能再重新研判')
    setRequerying(true)
    try {
      const res = await ticketApi.requeryEnrichment(ticket.id, ips)
      if (res.pending) {
        toast.success(`已提交 ${ips.length} 个 IP 的重新研判，后台执行中，稍后自动更新`)
      } else {
        toast.success(`已重新研判 ${res.updated} 个 IP`)
        if (res.unknown?.length) toast.error(`${res.unknown.length} 个 IP 不在研判列表中，已忽略`)
      }
      if (res.ticket) onTicketUpdate?.(res.ticket)
      else onTicketUpdate?.()
    } catch (e) {
      toast.error(e.message || '重新研判失败')
    } finally {
      setRequerying(false)
    }
  }, [ticket.id, ticket.status, onTicketUpdate])

  const doExport = useCallback(async (list, label) => {
    if (!list.length) return toast.error('没有可导出的 IP')
    const unqueried = list.filter((e) => !banMap.has(e.ip)).length
    if (unqueried) {
      const ok = await confirm({
        title: '导出安全上下文',
        message: `${unqueried} 个 IP 尚未查询黑名单状态，导出中该列将显示 --。是否继续？`,
        confirmText: '继续导出',
      })
      if (!ok) return
    }
    try {
      exportEnrichmentXlsx(list, banMap, roleLabels, { ticketNo: ticket.ticket_no, title: ticket.title })
      toast.success(`已导出 ${label}（${list.length} 个 IP）`)
    } catch (e) {
      toast.error(e.message || '导出失败')
    }
  }, [banMap, roleLabels, ticket])

  const banMapForEntry = useCallback((entry) => banMap.get(entry.ip), [banMap])

  const ipBadges = useCallback((e) => {
    const ban = banMap.get(e.ip)
    return (
      <>
        {e.pending || e.requery_pending ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600">
            <Loader2 className="h-3 w-3 animate-spin" />研判中
          </span>
        ) : (
          <>
            {e.threat?.is_malicious && (
              <span className="whitespace-nowrap rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500">恶意</span>
            )}
            {!e.threat?.is_malicious && isHighSeverity(e.threat?.severity) && (
              <span className="whitespace-nowrap rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">高危</span>
            )}
            {e.threat === null && (
              <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">情报失败</span>
            )}
            {ban?.banned && (
              <span className="whitespace-nowrap rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500">封禁中</span>
            )}
            {e.asset?.matched ? (
              <span className={`inline-flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium ${isHighCriticality(e) ? 'bg-amber-500/10 text-amber-600' : 'bg-primary/10 text-primary'}`}>
                {e.asset.asset_name || '资产'}{e.asset.source_label ? `·${e.asset.source_label}` : ''}
              </span>
            ) : e.asset && !e.asset.error ? (
              <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">未匹配</span>
            ) : null}
            {e.asset?.error && (
              <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">资产失败</span>
            )}
          </>
        )}
      </>
    )
  }, [banMap])

  // ===== IP 行（44px 定高；复选框仅点击本身选中，行点击看详情） =====
  const IpRow = useCallback(({ e, onOpenDetail }) => {
    const roleText = (e.roles || []).map((r) => roleLabels[r] || r).join('、')
    const checked = selection.has(e.ip)
    return (
      <div
        className="flex h-11 items-center gap-2 border-b border-border/50 px-2 transition hover:bg-secondary/50"
        onClick={() => onOpenDetail(e)}
      >
        <input
          type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
          checked={checked}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => toggleSelect(e.ip)}
        />
        <span className="w-4 shrink-0 text-muted-foreground" title={roleText}>
          {(e.roles || []).includes('src_ip') && e.roles.length === 1 ? '源' : (e.roles || []).includes('dst_ip') && e.roles.length === 1 ? '目' : '双'}
        </span>
        <span className="min-w-0 shrink-0 font-mono text-[13px] font-medium text-foreground">{e.ip}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden">{ipBadges(e)}</span>
        <CopyIpButton ip={e.ip} />
      </div>
    )
  }, [selection, roleLabels, toggleSelect, ipBadges])

  // ===== 虚拟滚动（≥50）：分组头 + 行 摊平成定高条目 =====
  const virtualItems = useMemo(() => {
    const items = []
    roleGroups.forEach((g) => {
      items.push({ type: 'group', role: g.role, label: g.label, count: g.ips.length, ips: g.ips, dropped: g.dropped })
      if (!collapsedGroups.has(g.role)) g.ips.forEach((e) => items.push({ type: 'row', e }))
    })
    return items
  }, [roleGroups, collapsedGroups])

  const virtualizer = useVirtualizer({
    count: virtual ? virtualItems.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 8,
  })

  // ============ 渲染 ============

  // 存量 v1 工单：旧卡片渲染（零回归）
  if (!isV2) {
    return (
      <div className="space-y-4">
        <BanQueryBox autoIps={legacyAutoIps} autoQuery />
        <LegacyEnrichmentView enrichment={enrichment} onFill={onFill} />
      </div>
    )
  }

  const drawerEntry = drawerIp ? entries.find((e) => e.ip === drawerIp) : null

  return (
    <div className="rounded-md border border-border bg-card">
      {/* L1 统计头（默认折叠态唯一可见层，展开后 sticky 置顶） */}
      <div className="sticky top-0 z-10 rounded-t-md border-b border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-semibold text-foreground">安全上下文（自动研判）</span>
          {stats.pending && (
            <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-600">
              <Loader2 className="h-3 w-3 animate-spin" />自动研判进行中…
            </span>
          )}
          <span className="text-sm text-muted-foreground">
            IP 共 <span className="font-medium text-foreground">{stats.total}</span> 个
            （{roleLabels.src_ip ? `${roleLabels.src_ip.replace('IP地址', 'IP')} ${stats.src}` : ''} · {roleLabels.dst_ip ? `${roleLabels.dst_ip.replace('IP地址', 'IP')} ${stats.dst}` : ''}）
          </span>
          {stats.totalOriginal > stats.total && (
            <span className="text-xs text-amber-600" title={`IP 共 ${stats.totalOriginal} 个，超过自动研判上限，仅研判前 ${stats.total} 个`}>
              ⚠ 共 {stats.totalOriginal} 个，仅研判前 {stats.total} 个
            </span>
          )}
          <button
            type="button" onClick={toggleExpanded}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary/50"
          >
            {expanded ? <><ListCollapse className="h-3.5 w-3.5" />一键收起</> : <><ChevronDown className="h-3.5 w-3.5" />展开列表</>}
          </button>
        </div>
        {/* 三维风险标签统计 chips：点击 = 展开并按该维度过滤 */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">威胁情报：</span>
          <StatChip tone="red" active={filters.has('malicious')} onClick={() => applyChipFilter('malicious')}>恶意 {stats.malicious}</StatChip>
          <StatChip tone="amber" active={filters.has('severityHigh')} onClick={() => applyChipFilter('severityHigh')}>高危 {stats.severityHigh}</StatChip>
          <StatChip tone="muted" active={filters.has('failed')} onClick={() => applyChipFilter('failed')}>失败 {stats.failed}</StatChip>
          <span className="ml-2 shrink-0 text-muted-foreground">资产匹配：</span>
          <StatChip tone="primary" active={filters.has('asset')} onClick={() => applyChipFilter('asset')}>命中 {stats.assetMatched}</StatChip>
          <StatChip tone="amber" active={filters.has('assetCritical')} onClick={() => applyChipFilter('assetCritical')}>重要资产 {stats.assetCritical}</StatChip>
          <StatChip tone="muted" active={filters.has('unmatched')} onClick={() => applyChipFilter('unmatched')}>未匹配 {stats.total - stats.assetMatched}</StatChip>
          <span className="ml-2 shrink-0 text-muted-foreground">黑名单（实时）：</span>
          <StatChip tone="red" active={filters.has('ban')} onClick={() => applyChipFilter('ban')}>封禁中 {stats.banned}</StatChip>
          {banProgress.loading && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />查询中 {banProgress.done}/{banProgress.total}
            </span>
          )}
          {!!banProgress.failedChunks.length && !banProgress.loading && (
            <button type="button" onClick={() => runBanQuery(entries.map((e) => e.ip))}
              className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-600 transition hover:bg-amber-500/20">
              <RefreshCw className="h-3 w-3" />重试失败批次
            </button>
          )}
          {banDeviceError && !banProgress.loading && (
            <span className="text-amber-600" title={banDeviceError}>安博通阻断器不可用</span>
          )}
        </div>
      </div>

      {/* 封禁状态查询（置顶，进入即自动查询全部 IP；手动查询保留） */}
      <div className="px-4 pt-3">
        <BanQueryBox
          ticketIps={entries.map((e) => e.ip)}
          banMap={banMap}
          progress={banProgress}
          deviceError={banDeviceError}
          onRetry={() => runBanQuery(entries.map((e) => e.ip))}
        />
      </div>

      {/* L2 工具栏 + L3 列表（展开后） */}
      {expanded && (
        <div className="p-4">
          {/* 工具栏 */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            {FILTER_DEFS.map((f) => (
              <button key={f.key} type="button" onClick={() => toggleFilter(f.key)}
                className={`inline-flex items-center rounded border px-2 py-0.5 font-medium transition ${filters.has(f.key) ? FILTER_CHIP_CLS.primary : 'border-border bg-secondary text-muted-foreground hover:text-foreground'}`}>
                {f.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" />
            {[
              ['default', '默认排序'], ['risk', '风险优先'], ['ip', 'IP 排序'],
            ].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setSort(k)}
                className={`inline-flex items-center rounded border px-2 py-0.5 font-medium transition ${sort === k ? FILTER_CHIP_CLS.primary : 'border-border bg-secondary text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" />
            <button type="button" className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 font-medium text-muted-foreground transition hover:text-foreground"
              onClick={() => selectIps(filtered.map((e) => e.ip), true)}>
              全选结果
            </button>
            <button type="button" className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 font-medium text-muted-foreground transition hover:text-foreground"
              onClick={() => setSelection(new Set())}>
              清除选择
            </button>
            {!virtual && (
              <>
                <button type="button" className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 font-medium text-muted-foreground transition hover:text-foreground"
                  onClick={() => setOpenRows(new Set(filtered.map((e) => e.ip)))}>
                  全部展开
                </button>
                <button type="button" className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 font-medium text-muted-foreground transition hover:text-foreground"
                  onClick={() => setOpenRows(new Set())}>
                  行内收起
                </button>
              </>
            )}
            {virtual && (
              <span className="text-muted-foreground" title="IP 较多，点击单行在抽屉中查看详情">
                IP &gt; {VIRTUAL_THRESHOLD} 个：已启用虚拟滚动，点击行查看详情
              </span>
            )}
            <button type="button" onClick={() => doExport(filtered, '当前筛选结果')}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 font-medium text-primary transition hover:bg-primary/20">
              <Download className="h-3.5 w-3.5" />导出详情
            </button>
          </div>

          {/* IP 列表 */}
          {!filtered.length ? (
            <p className={hintCls}>当前筛选无匹配 IP{filters.size ? '，可清除筛选' : ''}</p>
          ) : virtual ? (
            <div ref={scrollRef} className="max-h-[480px] overflow-y-auto rounded-md border border-border">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const item = virtualItems[vi.index]
                  return (
                    <div key={vi.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)`, height: 44 }}>
                      {item.type === 'group' ? (
                        <div className="flex h-11 items-center gap-2 border-b border-border bg-secondary/60 px-3">
                          <button type="button" className="inline-flex items-center gap-1.5 font-medium text-foreground"
                            onClick={() => setCollapsedGroups((prev) => {
                              const next = new Set(prev)
                              if (next.has(item.role)) next.delete(item.role)
                              else next.add(item.role)
                              return next
                            })}>
                            {collapsedGroups.has(item.role) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            {item.label}（{item.count}）
                            {!filters.size && !!item.dropped && (
                              <span className="text-[11px] font-normal text-muted-foreground" title={`另有 ${item.dropped} 个双角色 IP 已在源IP分组展示`}>· 另有 {item.dropped} 个双角色 IP 已在源分组</span>
                            )}
                          </button>
                          <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary" title="组内全选"
                            checked={item.ips.every((e) => selection.has(e.ip))}
                            onChange={(ev) => selectIps(item.ips.map((e) => e.ip), ev.target.checked)} />
                        </div>
                      ) : (
                        <IpRow e={item.e} onOpenDetail={(e2) => setDrawerIp(e2.ip)} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {roleGroups.map((g) => (
                <div key={g.role}>
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5 text-primary" />{g.label}（{g.ips.length}）
                      {!filters.size && !!g.dropped && (
                        <span className="text-[11px] font-normal text-muted-foreground" title={`另有 ${g.dropped} 个双角色 IP 已在源IP分组展示`}>· 另有 {g.dropped} 个双角色 IP 已在源分组</span>
                      )}
                    </span>
                    <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary" title="组内全选"
                      checked={g.ips.length > 0 && g.ips.every((e) => selection.has(e.ip))}
                      onChange={(ev) => selectIps(g.ips.map((e) => e.ip), ev.target.checked)} />
                  </div>
                  <div className="rounded-md border border-border">
                    {g.ips.map((e) => {
                      const roleText = (e.roles || []).map((r) => roleLabels[r] || r).join('、')
                      const open = openRows.has(e.ip)
                      return (
                        <div key={e.ip} className="border-b border-border/50 last:border-b-0">
                          <div className="flex h-11 items-center gap-2 px-2 transition hover:bg-secondary/50">
                            <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                              checked={selection.has(e.ip)} onChange={() => toggleSelect(e.ip)} />
                            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              onClick={() => toggleRow(e.ip)}>
                              <span className="w-4 shrink-0 text-center text-xs text-muted-foreground" title={roleText}>
                                {(e.roles || []).includes('src_ip') && e.roles.length === 1 ? '源' : (e.roles || []).includes('dst_ip') && e.roles.length === 1 ? '目' : '双'}
                              </span>
                              <span className="min-w-0 shrink-0 font-mono text-[13px] font-medium text-foreground">{e.ip}</span>
                              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden">{ipBadges(e)}</span>
                              {open
                                ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                            </button>
                            <button type="button" title="复制 IP"
                              className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                              onClick={() => navigator.clipboard?.writeText(e.ip).then(() => toast.success(`已复制 ${e.ip}`))}>
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {open && (
                            <div className="border-t border-border bg-secondary/30 p-3">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">{roleText}</span>
                                <span className="font-mono text-sm font-medium text-foreground">{e.ip}</span>
                                {e.detail === 'lite' && (
                                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">精简档</span>
                                )}
                              </div>
                              <EnrichEntryDetail entry={e} roleText={roleText} onFill={onFill}
                                liteHint={e.detail === 'lite'}
                                onRequery={() => requeryIps([e.ip])} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 研判错误汇总 */}
          {!!enrichment.errors?.length && (
            <div className="mt-3 break-all text-xs text-amber-500">部分研判失败：{enrichment.errors.join('；')}</div>
          )}
          {enrichment.enriched_at && (
            <div className="mt-1 text-xs text-muted-foreground">
              研判时间：{new Date(enrichment.enriched_at).toLocaleString('zh-CN', { hour12: false })}
            </div>
          )}
        </div>
      )}

      {/* 详情抽屉（虚拟滚动模式）：行内不嵌详情，保证 44px 定高 */}
      <Drawer open={!!drawerEntry} onClose={() => setDrawerIp(null)} width="w-[720px]"
        title={drawerEntry ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words font-mono">{drawerEntry.ip}</span>
            <CopyIpButton ip={drawerEntry.ip} />
            {(drawerEntry.roles || []).map((r) => roleLabels[r] || r).join('、')}
            {drawerEntry.detail === 'lite' && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">精简档</span>}
          </span>
        ) : ''}
      >
        {drawerEntry && (
          <div className="space-y-3">
            {drawerEntry.pending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />该 IP 自动研判进行中，结果稍后自动更新…
              </div>
            ) : (
              <>
                <EnrichEntryDetail entry={drawerEntry} stacked
                  roleText={(drawerEntry.roles || []).map((r) => roleLabels[r] || r).join('、')}
                  onFill={onFill} liteHint={drawerEntry.detail === 'lite'}
                  onRequery={() => requeryIps([drawerEntry.ip])} />
                {banMapForEntry(drawerEntry) && (
                  <BanStatusDetail ip={drawerEntry.ip} st={banMapForEntry(drawerEntry)} />
                )}
              </>
            )}
          </div>
        )}
      </Drawer>

      {/* 批量操作浮动条（底部居中，避免贴右下遮挡内容） */}
      {selection.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex max-w-[92vw] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium text-foreground">已选 {selection.size} 项</span>
          <span className="h-4 w-px bg-border" />
          <Button size="sm" variant="outline" className="h-7"
            onClick={() => runBanQuery([...selection], { silent: false })}>
            <ShieldBan className="mr-1 h-3 w-3" />查询封禁
          </Button>
          <Button size="sm" variant="outline" className="h-7" loading={requerying}
            onClick={() => requeryIps([...selection])}>
            <RefreshCw className="mr-1 h-3 w-3" />重新研判
          </Button>
          <Button size="sm" variant="outline" className="h-7"
            onClick={() => doExport(entries.filter((e) => selection.has(e.ip)), '所选 IP')}>
            <Download className="mr-1 h-3 w-3" />导出所选
          </Button>
          <button type="button" onClick={() => setSelection(new Set())}
            className="rounded p-1 text-muted-foreground transition hover:text-foreground" title="取消选择">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}

// ============ 黑名单单 IP 详情（抽屉内展示设备原始条目） ============

function BanStatusDetail({ ip, st }) {
  if (!st) return null
  return (
    <div className="rounded-md border border-border bg-secondary p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
        <ShieldBan className="h-3.5 w-3.5 text-primary" />黑名单状态
        {st.banned ? (
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500">封禁中</span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">未封禁</span>
        )}
      </div>
      {st.entry ? (
        <div className="rounded-md bg-muted p-2.5 text-[13px] leading-relaxed">
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {Object.entries(st.entry).map(([k, v]) => (
              <div key={k} className="flex min-w-0 items-start gap-2">
                <span className="shrink-0 text-muted-foreground">{ANBOTONG_ENTRY_LABELS[k] || k}：</span>
                <span className="min-w-0 break-words text-foreground">{fmtBanEntryVal(k, v)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">设备上未找到该 IP 的黑名单条目</p>
      )}
    </div>
  )
}

// ============ 封禁状态查询（置顶）：工单全部 IP 自动查询展示 + 手动查询兜底 ============

function BanQueryBox({
  autoIps = [], autoQuery = false,
  ticketIps = [], banMap = null, progress = null, deviceError = null, onRetry,
}) {
  const [query, setQuery] = useState(autoIps.join('，'))
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const reqSeq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const doQuery = useCallback((ipsStr) => {
    const ips = [...new Set(String(ipsStr).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean))]
    if (!ips.length) return
    if (ips.length > BAN_CHUNK) return toast.error(`单次最多查询 ${BAN_CHUNK} 个 IP`)
    const seq = ++reqSeq.current
    const ok = () => mounted.current && reqSeq.current === seq
    setLoading(true)
    ticketApi.banStatus(ips)
      .then((res) => { if (ok()) setResult(res) })
      .catch((e) => { if (ok()) toast.error(e.message || '查询封禁状态失败') })
      .finally(() => { if (ok()) setLoading(false) })
  }, [])
  // 存量 v1 工单：进入 Tab 即自动查询工单涉及的 IP（与旧 BanStatusView 行为一致）
  useEffect(() => {
    if (autoQuery && autoIps.length) doQuery(autoIps.join(','))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const results = result && result.results ? Object.entries(result.results) : []

  // v2：工单全部 IP 的封禁状态由父组件统一自动查询（20/批，会话缓存去重），此处只做展示
  const autoTotal = ticketIps.length
  const autoDone = ticketIps.filter((ip) => banMap?.has(ip)).length
  const autoBanned = ticketIps.filter((ip) => banMap?.get(ip)?.banned).length
  const autoLoading = !!progress?.loading
  const failedChunks = progress?.failedChunks?.length || 0

  return (
    <div className="rounded-md border border-border bg-secondary/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ShieldBan className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium text-foreground">封禁状态查询（安博通阻断器）</span>
        {autoTotal ? (
          <span>已自动查询本工单全部 {autoTotal} 个 IP，也可手动查询列表之外的 IP（逗号分隔，单次最多 {BAN_CHUNK} 个）</span>
        ) : (
          <span>如需查询研判列表之外的 IP，可在此手动输入（逗号分隔，单次最多 {BAN_CHUNK} 个）</span>
        )}
      </div>

      {autoTotal > 0 && (
        <div className="mb-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 text-muted-foreground">
              已查询 <span className="font-medium text-foreground">{autoDone}/{autoTotal}</span>
            </span>
            <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${autoBanned ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-border bg-card text-muted-foreground'}`}>
              封禁中 <span className="font-medium">{autoBanned}</span>
            </span>
            {autoLoading && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />查询中…
              </span>
            )}
            {!autoLoading && !!failedChunks && onRetry && (
              <button type="button" onClick={onRetry}
                className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-600 transition hover:bg-amber-500/20">
                <RefreshCw className="h-3 w-3" />重试失败批次（{failedChunks}）
              </button>
            )}
            {deviceError && !autoLoading && (
              <span className="break-all text-amber-600" title={deviceError}>安博通阻断器不可用</span>
            )}
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded border border-border/60 bg-background/40">
            {ticketIps.map((ip) => {
              const st = banMap?.get(ip)
              return (
                <div key={ip} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 px-2 py-1.5 text-[13px] last:border-b-0">
                  <span className="min-w-0 break-all font-mono font-medium text-foreground">{ip}</span>
                  {st ? (
                    st.banned ? (
                      <span className="whitespace-nowrap rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-500">封禁中</span>
                    ) : (
                      <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">未封禁</span>
                    )
                  ) : autoLoading ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />查询中
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">--</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <input className={inputCls} placeholder="输入 IP 地址，多个 IP 用逗号分隔"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) doQuery(query) }} />
        <Button size="sm" className="shrink-0" loading={loading} disabled={!query.trim()} onClick={() => doQuery(query)}>
          <Search className="mr-1 h-3.5 w-3.5" />查询
        </Button>
      </div>
      {result?.device_error && (
        <div className="mt-2 break-all text-xs text-amber-600">安博通阻断器不可用：{result.device_error}</div>
      )}
      {!!results.length && (
        <div className="mt-2 space-y-1.5">
          {results.map(([ip, st]) => (
            <div key={ip} className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-[13px]">
              <span className="font-mono font-medium text-foreground">{ip}</span>
              {st.banned ? (
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-500">封禁中</span>
              ) : (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">未封禁</span>
              )}
              {st.error && <span className="text-xs text-red-500">查询失败：{st.error}</span>}
              {!st.error && st.note && <span className="text-xs text-amber-600">{st.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============ 存量 v1 渲染（旧卡片结构，零回归） ============

function LegacyEnrichmentView({ enrichment, onFill }) {
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
        {enrichment.sources.map((s) => (
          <div key={`${s.role}-${s.ip}`} className="rounded-md border border-border p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{s.label || s.role}</span>
              <span className="font-mono text-sm font-medium text-foreground">{s.ip}</span>
              <CopyIpButton ip={s.ip} />
              {s.threat?.is_malicious ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
                  <AlertTriangle className="h-3 w-3" />恶意
                </span>
              ) : s.threat ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
                  <ShieldCheck className="h-3 w-3" />非恶意
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">威胁情报查询失败</span>
              )}
            </div>
            <EnrichEntryDetail entry={s} roleText={s.label || s.role} onFill={onFill} />
          </div>
        ))}
      </div>
      {!!enrichment.errors?.length && (
        <div className="mt-2 break-all text-xs text-amber-500">部分研判失败：{enrichment.errors.join('；')}</div>
      )}
    </div>
  )
}
