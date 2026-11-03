// 解析模板编辑页：表单/JSON 双模式（双向同步）+ 内嵌测试面板
// - 规则化：一个模板内包含多条规则（rules[]），每条规则负责一种日志类型
// - 每条规则 = match（识别日志类别）+ extract（提取字段，fields/regex/template 三选）+ map（映射/枚举/默认值/校验）
// - 表单模式：基本信息 / 外层解包 / 规则列表（增删、切换活跃规则）+ 活跃规则编辑区
// - JSON 模式：直接编辑模板 JSON 全文，保存前解析校验，错误提示具体行号
// - 测试面板：粘贴样例原始日志 → 测试解析，展示命中规则 / 提取明细 / 校验警告 / 标准模型 JSON
import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Save, Plus, Trash2, FlaskConical, FileJson,
  Settings2, Table2, Braces, AlertTriangle, CheckCircle2, XCircle, ChevronRight,
  Layers, Crosshair, Scissors, History, Rocket, Eye, Inbox, RotateCcw, GitCompare, GripVertical, Search,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { Modal, Drawer } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import {Button, PageContainer, Card, Badge, EmptyState, CompactSelect, AutoGrowTextarea } from '../components/ui'
import { inputCls, inputBaseCls, labelCls } from '../components/property/FormControls'
import { hasPermission } from '../utils/permissions'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import strategyApi from '../api/strategy'
import { devices as devicesApi } from '../api/client'

// 全部转换类型（与后端 field_mapper 支持一致）
const CONVERT_TYPES = [
  { value: 'string', label: 'string（字符串）' },
  { value: 'int', label: 'int（整数）' },
  { value: 'float', label: 'float（浮点）' },
  { value: 'bool', label: 'bool（布尔）' },
  { value: 'json_array_to_string', label: 'json_array_to_string（数组→JSON串）' },
  { value: 'json_object_to_string', label: 'json_object_to_string（对象→JSON串）' },
  { value: 'timestamp_to_datetime', label: 'timestamp_to_datetime（时间戳→时间）' },
  { value: 'comma_split_to_json', label: 'comma_split_to_json（逗号串→JSON数组）' },
  { value: 'enum_int', label: 'enum_int（int 枚举）' },
  { value: 'qt_datetime', label: 'qt_datetime（快速时间格式）' },
]

const VALIDATION_RULE_TYPES = [
  { value: 'regex', label: 'regex（正则）' },
  { value: 'range', label: 'range（数值范围）' },
  { value: 'ip_list_valid', label: 'ip_list_valid（IP 合法性）' },
  { value: 'positive_int', label: 'positive_int（正整数）' },
]

const MATCH_OPS = [
  { value: 'eq', label: 'eq（等于）' },
  { value: 'not_eq', label: 'not_eq（不等于）' },
  { value: 'in', label: 'in（属于集合）' },
  { value: 'not_in', label: 'not_in（不属于）' },
  { value: 'contains', label: 'contains（包含）' },
  { value: 'regex', label: 'regex（正则）' },
  { value: 'gte', label: 'gte（≥）' },
  { value: 'gt', label: 'gt（＞）' },
  { value: 'lte', label: 'lte（≤）' },
  { value: 'lt', label: 'lt（＜）' },
]

const EXTRACT_TYPES = [
  { value: 'fields', label: 'fields（字段路径取数）' },
  { value: 'regex', label: 'regex（正则命名组）' },
  { value: 'template', label: 'template（分隔符模板）' },
]

// 默认的单条 extract.fields 映射行
const emptyMappingRow = () => ({ source: '', target: '', type: 'string', required: false, default: '', enum_map: '', enum_target: '' })

// 字段提取表增强：超过该行数显示顶部搜索框（按源/目标过滤）
const MAPPING_SEARCH_THRESHOLD = 15

// 按关键字段过滤映射行，返回匹配的原索引列表（保持顺序；编辑/删除时用原索引操作真实数据）
function filterMappingIndices(rows, term, keys) {
  if (!term) return rows.map((_, i) => i)
  const t = String(term).toLowerCase()
  return rows.map((_, i) => i).filter((i) =>
    keys.some((k) => String(rows[i][k] ?? '').toLowerCase().includes(t)))
}

// 拖拽排序：数组元素 from → to 移动
function moveArrayItem(arr, from, to) {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// 行级 LCS diff：返回 [{type: 'same'|'add'|'del', text}]，用于保存前变更预览
function diffLines(oldStr, newStr) {
  const a = (oldStr || '').split('\n')
  const b = (newStr || '').split('\n')
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < m) { out.push({ type: 'del', text: a[i] }); i++ }
  while (j < n) { out.push({ type: 'add', text: b[j] }); j++ }
  return out
}

// 新建规则默认结构
const emptyRule = (idx) => ({
  rule_id: `rule_${idx + 1}`,
  log_type: `日志类型 ${idx + 1}`,
  enabled: true,
  match: { type: 'all', conditions: [{ field: 'type', op: 'eq', value: '' }] },
  extract: { type: 'fields', fields: [emptyMappingRow()] },
  map: { enum_maps: {}, defaults: [], validations: [] },
  extension_fields: [],
})

// 新建模板默认配置（规则化结构）
const EMPTY_CONFIG = {
  strategy_name: '',
  device_type: '',
  status: 'enabled',
  version: '1.0',
  outer_wrapper: { data_path: 'data', header_fields: [], uuid_source: 'data.uuId' },
  rules: [emptyRule(0)],
}

// 从 JSON 解析错误信息提取行号（Chrome: "at position N" / Firefox: "at line L column C"）
function jsonErrorLine(text, err) {
  const msg = String(err?.message || err || '')
  let pos = null
  const m = msg.match(/position (\d+)/i)
  if (m) pos = Number(m[1])
  if (pos == null) {
    const lm = msg.match(/line (\d+)/i)
    if (lm) return Number(lm[1])
    return null
  }
  return text.slice(0, pos).split('\n').length
}

// ===== 版本 diff：轻量递归 JSON diff（展平为路径 → 值，对比增删改） =====
function flattenJson(obj, prefix = '') {
  const out = {}
  if (obj === null || typeof obj !== 'object') {
    if (prefix) out[prefix] = obj
    return out
  }
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj)
  if (entries.length === 0 && prefix) out[prefix] = Array.isArray(obj) ? '[]' : '{}'
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || typeof v !== 'object') out[key] = v
    else Object.assign(out, flattenJson(v, key))
  }
  return out
}

function jsonDiff(a, b) {
  const fa = flattenJson(a || {})
  const fb = flattenJson(b || {})
  const rows = []
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()
  for (const k of keys) {
    const inA = k in fa
    const inB = k in fb
    if (inA && inB) {
      if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) rows.push({ path: k, type: 'modified', a: fa[k], b: fb[k] })
    } else if (inA) rows.push({ path: k, type: 'removed', a: fa[k] })
    else rows.push({ path: k, type: 'added', b: fb[k] })
  }
  return rows
}

const _pv = (v) => {
  if (v === undefined) return '(不存在)'
  if (v === null) return 'null'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

const DIFF_TYPE_META = {
  added: { label: '新增', cls: 'text-success', chip: 'bg-success/15 text-success' },
  removed: { label: '删除', cls: 'text-destructive', chip: 'bg-destructive/15 text-destructive' },
  modified: { label: '修改', cls: 'text-warning', chip: 'bg-warning/15 text-warning' },
}

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '-')

// ===== 测试解析结果卡片（test-parse 逐条结果） =====
function ParseResultCard({ r }) {
  const stBadge = r.status === 'success' ? 'success' : r.status === 'partial' ? 'warning' : 'danger'
  const stLabel = r.status === 'success' ? '成功' : r.status === 'partial' ? '部分成功' : '失败'
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">#{r.index}</span>
        <Badge variant={stBadge}>{stLabel}</Badge>
        {r.rule ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            命中 <code className="rounded bg-muted px-1.5 py-0.5">{r.rule.rule_id}</code>
            {' · '}{r.rule.log_type || '未命名类型'}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">未命中任何规则</span>
        )}
        <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">{r.parse_ms}ms</span>
      </div>
      {r.error_type && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-all"><code className="font-mono">{r.error_type}</code>{r.error_msg ? `：${r.error_msg}` : ''}</span>
        </div>
      )}

      {/* 逐规则逐条件评估详情 */}
      {r.rules_detail?.length > 0 && (
        <details className="mb-2 rounded-md border border-border p-2">
          <summary className="cursor-pointer select-none text-xs font-semibold text-muted-foreground">
            规则匹配过程（{r.rules_detail.length} 条规则逐条件评估）
          </summary>
          <div className="mt-2 space-y-2">
            {r.rules_detail.map((rd, i) => (
              <div key={i} className="rounded border border-border p-2">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{rd.rule_id}</code>
                  <span className="text-muted-foreground">{rd.log_type || '未命名'}</span>
                  {rd.enabled ? null : <Badge variant="neutral">已停用</Badge>}
                  <span className="text-muted-foreground">combine={rd.combine}</span>
                  {rd.hit ? <Badge variant="success">命中</Badge> : <Badge variant="neutral">未命中</Badge>}
                </div>
                {rd.conditions?.length > 0 && (
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-1.5 py-1 font-semibold">字段</th>
                        <th className="px-1.5 py-1 font-semibold">算子</th>
                        <th className="px-1.5 py-1 font-semibold">期望值</th>
                        <th className="px-1.5 py-1 font-semibold">实际值</th>
                        <th className="px-1.5 py-1 font-semibold">结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rd.conditions.map((c, ci) => (
                        <tr key={ci} className="border-b border-border last:border-0">
                          <td className="px-1.5 py-1 font-mono">{c.field || '-'}</td>
                          <td className="px-1.5 py-1 font-mono text-muted-foreground">{c.op}</td>
                          <td className="max-w-[140px] truncate px-1.5 py-1 font-mono" title={_pv(c.expected)}>{_pv(c.expected)}</td>
                          <td className="max-w-[140px] truncate px-1.5 py-1 font-mono" title={_pv(c.actual)}>{_pv(c.actual)}</td>
                          <td className="px-1.5 py-1">{c.hit ? <span className="text-success">✓</span> : <span className="text-destructive">✗</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* 命中：解包 + 提取明细 + 校验 + 标准模型 */}
      {r.rule && r.unwrap && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-muted-foreground">外层解包：</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{r.unwrap.data_path || '(根对象)'}</code>
            {r.unwrap.found ? <Badge variant="success">成功</Badge> : <Badge variant="danger">data 路径不存在</Badge>}
          </div>
          {r.mappings?.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-semibold">源字段</th>
                    <th className="px-2 py-1.5 font-semibold">目标字段</th>
                    <th className="px-2 py-1.5 font-semibold">类型</th>
                    <th className="px-2 py-1.5 font-semibold">源值</th>
                    <th className="px-2 py-1.5 font-semibold">转换后</th>
                    <th className="px-2 py-1.5 font-semibold">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {r.mappings.map((m, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5 font-mono">{m.source || '-'}</td>
                      <td className="px-2 py-1.5 font-mono">{m.target || '-'}</td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">{m.type}</td>
                      <td className="max-w-[150px] truncate px-2 py-1.5" title={_pv(m.raw_value)}>
                        {m.missing ? <span className="text-muted-foreground">(缺失)</span> : _pv(m.raw_value)}
                      </td>
                      <td className="max-w-[150px] truncate px-2 py-1.5" title={_pv(m.converted)}>{_pv(m.converted)}</td>
                      <td className="px-2 py-1.5">
                        {m.warning ? <span className="text-warning" title={m.warning}>⚠</span> : <span className="text-success">✓</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.validations && (
            <div className="flex flex-wrap items-start gap-2 text-xs">
              <span className="font-semibold text-muted-foreground">校验结果：</span>
              <Badge variant={r.validations.failed?.length ? 'warning' : 'success'}>
                {r.validations.defined} 项 · 通过 {r.validations.passed} · 失败 {r.validations.failed?.length || 0}
              </Badge>
              {r.validations.failed?.map((f, i) => (
                <span key={i} className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                  <code className="font-mono">{f.field}</code>：{f.message}
                </span>
              ))}
            </div>
          )}
          <details className="rounded-md border border-border p-2">
            <summary className="cursor-pointer select-none text-xs font-semibold text-muted-foreground">标准模型 JSON（入库字段）</summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              {JSON.stringify(r.fields, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* 未命中：自动路由回退路径 */}
      {r.fallback_path && <FallbackTraceView fp={r.fallback_path} />}
    </div>
  )
}

// 自动路由回退路径视图（元数据 → 特征匹配 → 候选尝试 → route_rules 兜底）
function FallbackTraceView({ fp }) {
  return (
    <details className="rounded-md border border-border p-2" open>
      <summary className="cursor-pointer select-none text-xs font-semibold text-muted-foreground">
        自动路由回退路径（该日志实际会走的匹配链）
      </summary>
      <div className="mt-2 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-muted-foreground">特征分类：</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{fp.classification?.method}</code>
          <span className="text-muted-foreground">{fp.classification?.reason}</span>
          <span className="text-muted-foreground">候选：{fp.classification?.candidates?.join('、') || '无'}</span>
        </div>
        {fp.metadata_checks?.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-muted-foreground">元数据直路由：</span>
            {fp.metadata_checks.map((m, i) => (
              <span key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {m.field}={_pv(m.value)} {m.hit ? `→ ${m.hit}` : '（未命中）'}
              </span>
            ))}
          </div>
        )}
        {fp.attempts?.length > 0 && (
          <div className="space-y-1">
            <span className="font-semibold text-muted-foreground">候选模板尝试：</span>
            {fp.attempts.map((a, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1">
                <span className="max-w-[180px] truncate">{a.strategy_name || `模板 #${a.strategy_id}`}</span>
                <span className="text-muted-foreground">device_type={a.device_type}</span>
                {a.accepted
                  ? <Badge variant="success">可接手</Badge>
                  : <Badge variant="danger">{a.status} · {a.reason || '被校验门控拒绝'}</Badge>}
              </div>
            ))}
          </div>
        )}
        {fp.legacy_route_rules && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-muted-foreground">旧路由规则兜底：</span>
            <span>{fp.legacy_route_rules.strategy_name || `模板 #${fp.legacy_route_rules.strategy_id}`}</span>
            {fp.legacy_route_rules.accepted ? <Badge variant="success">命中并接受</Badge> : <Badge variant="warning">命中但被拒绝</Badge>}
          </div>
        )}
        <div className="rounded bg-warning/10 px-2 py-1 text-warning">结论：{fp.conclusion}</div>
      </div>
    </details>
  )
}

// ===== 小组件 =====
function SectionTitle({ icon: Icon, children, desc }) {
  return (
    <div className="mb-4 flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <h3 className="text-sm font-semibold text-foreground">{children}</h3>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
    </div>
  )
}

function ModeTab({ active, icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${
        active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  )
}

export default function StrategyEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isNew = !id
  const canEdit = hasPermission('strategy', 'edit')

  const [config, setConfig] = useState(EMPTY_CONFIG)
  const [mode, setMode] = useState('form') // form | json
  const [jsonText, setJsonText] = useState('')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  // 草稿 / 发布 / 版本
  const [meta, setMeta] = useState(null) // detail：has_draft / published_version_no / version_count
  const [editingDraft, setEditingDraft] = useState(false) // 编辑区当前承载的是草稿副本
  const [onlineConfig, setOnlineConfig] = useState(null) // 线上版本快照（查看线上版本用）
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishRemark, setPublishRemark] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [onlineOpen, setOnlineOpen] = useState(false)

  // 保存前变更预览（diff 弹窗）
  const [saveDiffOpen, setSaveDiffOpen] = useState(false)
  const [saveDiffRows, setSaveDiffRows] = useState([])
  const [saveDiffStats, setSaveDiffStats] = useState({ add: 0, del: 0 })

  // 版本历史抽屉
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [diffA, setDiffA] = useState('') // 版本号 A
  const [diffB, setDiffB] = useState('') // 版本号 B
  const [diffRows, setDiffRows] = useState(null) // null=未对比 []=无差异
  const [diffLoading, setDiffLoading] = useState(false)
  const [rollbackNo, setRollbackNo] = useState(null)

  // 未保存修改检测：最近一次保存/加载的配置快照（序列化串），与当前配置对比
  const [savedSnapshot, setSavedSnapshot] = useState('')

  // 规则列表：当前激活编辑的规则索引
  const [activeRuleIdx, setActiveRuleIdx] = useState(0)
  // 规则列表搜索：按规则标识 / 日志类型过滤（左侧竖排列表用）
  const [ruleSearch, setRuleSearch] = useState('')

  // 字段提取表增强：搜索过滤（>15 行显示搜索框）+ 拖拽排序 + 删除二次确认
  const [mappingSearch, setMappingSearch] = useState('')
  const [dragIdx, setDragIdx] = useState(null) // 拖拽起始行原索引

  // 下拉数据源
  const [targetFields, setTargetFields] = useState([])
  const [deviceTypes, setDeviceTypes] = useState([])

  // 测试面板（新建：单条 JSON 样例旧接口；已有模板：多行原始日志走完整管道）
  const testRef = useRef(null)
  const [sampleText, setSampleText] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [parseResults, setParseResults] = useState(null) // test-parse 响应 {strategy, context, summary, results}
  const [useDraft, setUseDraft] = useState(true)
  const [ctxReceiverId, setCtxReceiverId] = useState('')
  const [ctxEntryId, setCtxEntryId] = useState('')
  const [receivers, setReceivers] = useState([])
  const [entries, setEntries] = useState([])

  // 失败样本载入（重测）
  const [samplesOpen, setSamplesOpen] = useState(false)
  const [samplesData, setSamplesData] = useState(null)
  const [samplesLoading, setSamplesLoading] = useState(false)
  const [samplesReason, setSamplesReason] = useState('')
  const [samplesPage, setSamplesPage] = useState(1)

  // ===== 数据加载 =====
  useEffect(() => {
    strategyApi.fields().then(setTargetFields).catch(() => {})
    strategyApi.list().then((items) => {
      setDeviceTypes([...new Set((items || []).map((i) => i.device_type).filter(Boolean))])
    }).catch(() => {})
    // 测试上下文选择器数据（接收器 + 全局条目）
    devicesApi.logReceivers.list()
      .then((res) => setReceivers(Array.isArray(res) ? res : res?.items || []))
      .catch(() => {})
    devicesApi.logReceivers.entriesGlobal({ page: 1, page_size: 200 })
      .then((res) => setEntries(res?.items || []))
      .catch(() => {})
    if (!isNew) {
      setLoading(true)
      strategyApi.detail(id)
        .then((row) => {
          if (!row || !row.id) { toast.error('模板不存在'); navigate('/strategies'); return }
          setMeta(row)
          setOnlineConfig(row.config || null)
          setEditingDraft(!!(row.has_draft && row.draft_config))
          const src = row.has_draft && row.draft_config ? row.draft_config : row.config
          const merged = { ...EMPTY_CONFIG, ...(src || {}) }
          // 旧结构模板（无 rules）在表单中展示为单规则
          if (!Array.isArray(merged.rules) || merged.rules.length === 0) {
            merged.rules = [emptyRule(0)]
          }
          setConfig(merged)
          setActiveRuleIdx(0)
          setJsonText(JSON.stringify(merged, null, 2))
          setSavedSnapshot(JSON.stringify(merged))
        })
        .catch((e) => { toast.error(e.message || '加载失败'); navigate('/strategies') })
        .finally(() => setLoading(false))
    }
  }, [id, isNew, navigate])

  // 发布 / 回滚 / 丢弃草稿后重载详情（编辑区切回线上或最新草稿）
  const reloadDetail = () =>
    strategyApi.detail(id)
      .then((row) => {
        setMeta(row)
        setOnlineConfig(row.config || null)
        setEditingDraft(!!(row.has_draft && row.draft_config))
        const src = row.has_draft && row.draft_config ? row.draft_config : row.config
        const merged = { ...EMPTY_CONFIG, ...(src || {}) }
        if (!Array.isArray(merged.rules) || merged.rules.length === 0) merged.rules = [emptyRule(0)]
        setConfig(merged)
        setActiveRuleIdx(0)
        setJsonText(JSON.stringify(merged, null, 2))
        setSavedSnapshot(JSON.stringify(merged))
      })

  // ?tab=test 时滚动到测试面板
  useEffect(() => {
    if (searchParams.get('tab') === 'test' && testRef.current) {
      testRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [searchParams])

  // ===== 模式切换（双向同步） =====
  const switchToForm = () => {
    // JSON → 表单：先校验
    let parsed
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      const line = jsonErrorLine(jsonText, e)
      toast.error(`JSON 格式错误${line ? `（约第 ${line} 行）` : ''}：${e.message}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      toast.error('模板配置必须是 JSON 对象')
      return
    }
    if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
      parsed = { ...parsed, rules: [emptyRule(0)] }
    }
    setConfig({ ...EMPTY_CONFIG, ...parsed })
    setActiveRuleIdx(0)
    setMode('form')
  }

  const switchToJson = () => {
    // 表单 → JSON：序列化
    setJsonText(JSON.stringify(config, null, 2))
    setMode('json')
  }

  // 当前生效的配置（JSON 模式下从文本解析；解析失败返回 null）
  const effectiveConfig = useMemo(() => {
    if (mode === 'form') return config
    try {
      const parsed = JSON.parse(jsonText)
      return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }, [mode, config, jsonText])

  // ===== 表单更新辅助 =====
  const setCfg = (patch) => setConfig((c) => ({ ...c, ...patch }))
  const setWrapper = (patch) => setConfig((c) => ({ ...c, outer_wrapper: { ...c.outer_wrapper, ...patch } }))

  // ===== 规则列表操作 =====
  const rules = config.rules || []
  const activeRule = rules[activeRuleIdx] || rules[0] || emptyRule(0)
  const activeIdx = Math.min(activeRuleIdx, Math.max(0, rules.length - 1))

  const updateRule = (idx, patch) => {
    setConfig((c) => {
      const list = [...(c.rules || [])]
      list[idx] = { ...(list[idx] || emptyRule(idx)), ...patch }
      return { ...c, rules: list }
    })
  }
  const addRule = () => {
    setConfig((c) => {
      const list = [...(c.rules || []), emptyRule((c.rules || []).length)]
      return { ...c, rules: list }
    })
    setActiveRuleIdx(rules.length)
  }
  const removeRule = (idx) => {
    setConfig((c) => {
      const list = (c.rules || []).filter((_, i) => i !== idx)
      return { ...c, rules: list.length ? list : [emptyRule(0)] }
    })
    // 移除的是激活规则 → 回退到第一条
    setActiveRuleIdx((cur) => (cur === idx ? 0 : Math.max(0, cur - 1)))
  }

  // 更新活跃规则深层结构
  const updateActiveRule = (patch) => updateRule(activeIdx, patch)
  const setActiveMatch = (patch) => updateActiveRule({ match: { ...(activeRule.match || {}), ...patch } })
  const setActiveExtract = (patch) => updateActiveRule({ extract: { ...(activeRule.extract || {}), ...patch } })
  const setActiveMap = (patch) => updateActiveRule({ map: { ...(activeRule.map || {}), ...patch } })

  // match 条件操作
  const defaultCond = () => ({ field: 'type', op: 'eq', value: '' })
  const activeConditions = (activeRule.match || {}).conditions || []
  const updateCondition = (ci, patch) => {
    const list = [...activeConditions]
    list[ci] = { ...list[ci], ...patch }
    setActiveMatch({ conditions: list })
  }
  const addCondition = () => setActiveMatch({ conditions: [...activeConditions, defaultCond()] })
  const removeCondition = (ci) => setActiveMatch({ conditions: activeConditions.filter((_, i) => i !== ci) })

  // extract.fields 映射行操作（活跃规则）
  const extractFields = ((activeRule.extract || {}).type === 'fields') ? ((activeRule.extract || {}).fields || []) : []
  const updateExtractField = (fi, patch) => {
    const list = [...extractFields]
    list[fi] = { ...list[fi], ...patch }
    setActiveExtract({ type: 'fields', fields: list })
  }
  const addExtractField = () => setActiveExtract({ type: 'fields', fields: [...extractFields, emptyMappingRow()] })
  const removeExtractField = (fi) => setActiveExtract({ type: 'fields', fields: extractFields.filter((_, i) => i !== fi) })

  // regex / template 的 mappings 操作（用 index/group 定位，命名为 rowKey）
  const regexMappings = ((activeRule.extract || {}).mappings) || []
  const updateRegexMapping = (ri, patch) => {
    const list = [...regexMappings]
    list[ri] = { ...(list[ri] || {}), ...patch }
    setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: (activeRule.extract || {}).source || '', mappings: list })
  }
  const addRegexMapping = () => setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: (activeRule.extract || {}).source || '', mappings: [...regexMappings, { group: '', target: '', type: 'string', default: '' }] })
  const removeRegexMapping = (ri) => setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: (activeRule.extract || {}).source || '', mappings: regexMappings.filter((_, i) => i !== ri) })

  const templateMappings = ((activeRule.extract || {}).mappings) || []
  const updateTemplateMapping = (ri, patch) => {
    const list = [...templateMappings]
    list[ri] = { ...(list[ri] || {}), ...patch }
    setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: list })
  }
  const addTemplateMapping = () => setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: [...templateMappings, { index: (activeRule.extract || {}).columns?.length || 0, target: '', type: 'string' }] })
  const removeTemplateMapping = (ri) => setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: templateMappings.filter((_, i) => i !== ri) })

  // map.enum_maps 操作（活跃规则）
  const ruleEnumMaps = ((activeRule.map || {}).enum_maps) || {}
  const ruleEnumNames = Object.keys(ruleEnumMaps)
  const addRuleEnumGroup = () => {
    const name = `ENUM_${ruleEnumNames.length + 1}`
    setActiveMap({ enum_maps: { ...ruleEnumMaps, [name]: { '0': '' } } })
  }
  const removeRuleEnumGroup = (name) => {
    const maps = { ...ruleEnumMaps }
    delete maps[name]
    // 同步 extract.fields / map.defaults 引用（字段映射里 enum_map 引用）
    setActiveMap({ enum_maps: maps })
    const fields = extractFields.map((m) => (m.enum_map === name ? { ...m, enum_map: '', enum_target: '' } : m))
    if (activeRule.extract?.type === 'fields') setActiveExtract({ type: 'fields', fields })
  }
  const addRuleEnumPair = (group) => setActiveMap({ enum_maps: { ...ruleEnumMaps, [group]: { ...ruleEnumMaps[group], '': '' } } })
  const updateRuleEnumPair = (group, oldKey, patch) => {
    const table = { ...ruleEnumMaps[group] }
    const nextKey = patch.key !== undefined ? patch.key : oldKey
    const rebuilt = {}
    Object.entries(table).forEach(([k, v]) => {
      if (k === oldKey) rebuilt[nextKey] = patch.value !== undefined ? patch.value : v
      else rebuilt[k] = v
    })
    setActiveMap({ enum_maps: { ...ruleEnumMaps, [group]: rebuilt } })
  }
  const removeRuleEnumPair = (group, key) => {
    const table = { ...ruleEnumMaps[group] }
    delete table[key]
    setActiveMap({ enum_maps: { ...ruleEnumMaps, [group]: table } })
  }

  // map.defaults 操作（活跃规则）
  const ruleDefaults = ((activeRule.map || {}).defaults) || []
  const updateRuleDefault = (di, patch) => {
    const list = [...ruleDefaults]
    list[di] = { ...list[di], ...patch }
    setActiveMap({ defaults: list })
  }
  const addRuleDefault = () => setActiveMap({ defaults: [...ruleDefaults, { target: '', value: '' }] })
  const removeRuleDefault = (di) => setActiveMap({ defaults: ruleDefaults.filter((_, i) => i !== di) })

  // map.validations 操作（活跃规则）
  const ruleValidations = ((activeRule.map || {}).validations) || []
  const updateRuleValidation = (vi, patch) => {
    const list = [...ruleValidations]
    list[vi] = { ...list[vi], ...patch }
    setActiveMap({ validations: list })
  }
  const addRuleValidation = () => setActiveMap({ validations: [...ruleValidations, { field: '', rule: 'regex', pattern: '', severity: 'warning' }] })
  const removeRuleValidation = (vi) => setActiveMap({ validations: ruleValidations.filter((_, i) => i !== vi) })

  // extension_fields（活跃规则）
  const ruleExtFields = (activeRule.extension_fields) || []
  const setRuleExtFields = (val) => updateActiveRule({ extension_fields: val })

  // ===== 保存（新建即发布 v1；编辑已有模板 = 保存草稿，线上版本继续生效） =====
  // 保存前先弹 diff 预览（线上 vs 待保存），用户确认后才提交
  const handleSave = () => {
    const cfg = effectiveConfig
    if (!cfg) {
      const err = 'JSON 格式错误，请先修正后再保存'
      toast.error(mode === 'json' ? err : '模板配置无效')
      return
    }
    if (!cfg.strategy_name?.trim()) return toast.error('模板名称不能为空')
    if (!cfg.device_type?.trim()) return toast.error('设备类型不能为空')
    if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) return toast.error('至少需要一条解析规则')

    // 构造 diff：编辑模式对比线上版本，新建模式对比空
    const oldStr = isNew ? '' : JSON.stringify(onlineConfig || {}, null, 2)
    const newStr = JSON.stringify(cfg, null, 2)
    const rows = diffLines(oldStr, newStr)
    const stats = {
      add: rows.filter((r) => r.type === 'add').length,
      del: rows.filter((r) => r.type === 'del').length,
    }
    setSaveDiffRows(rows)
    setSaveDiffStats(stats)
    setSaveDiffOpen(true)
  }

  // 真正执行保存（diff 预览确认后调用）
  const doSave = () => {
    const cfg = effectiveConfig
    setSaveDiffOpen(false)
    setSaving(true)
    const req = isNew ? strategyApi.create(cfg) : strategyApi.update(id, cfg)
    req
      .then((res) => {
        if (isNew) {
          toast.success('模板已创建并发布 v1')
          bypassGuard() // 保存成功放行导航，避免跳转编辑页时被未保存拦截
          navigate(`/strategies/${res.id}/edit`)
        } else {
          setEditingDraft(true)
          setMeta((m) => ({ ...(m || {}), has_draft: true }))
          toast.success('草稿已保存（线上版本不受影响，测试通过后点「发布」生效）')
          setConfig({ ...EMPTY_CONFIG, ...cfg })
          setJsonText(JSON.stringify(cfg, null, 2))
          setSavedSnapshot(JSON.stringify({ ...EMPTY_CONFIG, ...cfg }))
        }
      })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  // 未保存修改检测：当前配置与快照对比（JSON 模式解析失败时以原文对比，同样视为已修改）
  const dirty = useMemo(() => {
    if (!savedSnapshot) return false
    const cur = effectiveConfig ? JSON.stringify(effectiveConfig) : jsonText
    return cur !== savedSnapshot
  }, [effectiveConfig, jsonText, savedSnapshot])
  // 离开页面拦截 + 关闭浏览器提醒 + Ctrl+S 触发保存
  const bypassGuard = useUnsavedChanges(dirty, { onSave: handleSave })

  // ===== 发布草稿 =====
  const handlePublish = () => {
    setPublishing(true)
    strategyApi.publish(id, publishRemark.trim())
      .then((res) => {
        toast.success(`已发布 v${res.published_version_no}，线上立即生效`)
        setPublishOpen(false)
        setPublishRemark('')
        return reloadDetail()
      })
      .catch((e) => toast.error(e.message || '发布失败'))
      .finally(() => setPublishing(false))
  }

  // ===== 丢弃草稿 =====
  const handleDiscardDraft = () => {
    confirm({
      title: '丢弃草稿',
      message: '确认丢弃当前草稿？未发布的修改将丢失，编辑区恢复为线上版本内容。',
      variant: 'danger',
      confirmText: '丢弃草稿',
    }).then((ok) => {
      if (!ok) return
      strategyApi.discardDraft(id)
        .then(() => { toast.success('草稿已丢弃，恢复以线上版本为准'); return reloadDetail() })
        .catch((e) => toast.error(e.message || '操作失败'))
    })
  }

  // ===== 版本历史 =====
  const openVersions = () => {
    setVersionsOpen(true)
    setDiffRows(null)
    setVersionsLoading(true)
    strategyApi.versions(id)
      .then((rows) => {
        setVersions(rows || [])
        // 默认对比最近两个版本
        setDiffA(rows?.[1] ? String(rows[1].version_no) : '')
        setDiffB(rows?.[0] ? String(rows[0].version_no) : '')
      })
      .catch((e) => toast.error(e.message || '版本历史加载失败'))
      .finally(() => setVersionsLoading(false))
  }

  const handleDiff = () => {
    if (!diffA || !diffB || diffA === diffB) return toast.error('请选择两个不同版本')
    setDiffLoading(true)
    Promise.all([strategyApi.versionDetail(id, diffA), strategyApi.versionDetail(id, diffB)])
      .then(([va, vb]) => setDiffRows(jsonDiff(va.config, vb.config)))
      .catch((e) => toast.error(e.message || '版本对比失败'))
      .finally(() => setDiffLoading(false))
  }

  const handleRollback = (v) => {
    confirm({
      title: `回滚到 v${v.version_no}`,
      message: `将以 v${v.version_no} 的配置内容发布为新版本并立即生效；当前线上版本会保留在历史中，可再次回滚。`,
      variant: 'danger',
      confirmText: '回滚',
    }).then((ok) => {
      if (!ok) return
      setRollbackNo(v.version_no)
      strategyApi.rollback(id, v.version_no)
        .then((res) => {
          toast.success(`已回滚：v${v.version_no} 内容发布为 v${res.published_version_no}`)
          openVersions()
          return reloadDetail()
        })
        .catch((e) => toast.error(e.message || '回滚失败'))
        .finally(() => setRollbackNo(null))
    })
  }

  // ===== 测试解析（已有模板：多行原始日志走完整管道，不落库） =====
  const handleTestParse = () => {
    const lines = sampleText.split('\n').map((s) => s.trim()).filter(Boolean)
    if (lines.length === 0) return toast.error('请粘贴至少一条原始日志（每行一条）')
    const context = {}
    if (ctxEntryId) context.entry_id = Number(ctxEntryId)
    else if (ctxReceiverId) context.receiver_id = Number(ctxReceiverId)
    setTesting(true)
    setParseResults(null)
    strategyApi.testParse(id, lines, useDraft, context)
      .then((res) => {
        setParseResults(res)
        const s = res.summary
        toast[s.fail > 0 ? 'warning' : 'success'](`共 ${s.total} 条：成功 ${s.success} / 部分 ${s.partial} / 失败 ${s.fail}`)
      })
      .catch((e) => toast.error(e.message || '测试失败'))
      .finally(() => setTesting(false))
  }

  // ===== 测试解析（新建模板：单条 JSON 样例，纯内存执行） =====
  const handleTest = () => {
    const cfg = effectiveConfig
    if (!cfg) return toast.error('模板配置 JSON 格式错误，请先修正')
    let sample
    try {
      sample = JSON.parse(sampleText)
    } catch (e) {
      const line = jsonErrorLine(sampleText, e)
      return toast.error(`样例数据不是合法 JSON${line ? `（约第 ${line} 行）` : ''}：${e.message}`)
    }
    if (typeof sample !== 'object' || Array.isArray(sample)) return toast.error('样例数据必须是 JSON 对象')
    setTesting(true)
    strategyApi.test(cfg, sample)
      .then((res) => { setTestResult(res); toast.success(`解析完成（${res.parse_ms}ms）`) })
      .catch((e) => toast.error(e.message || '测试失败'))
      .finally(() => setTesting(false))
  }

  // ===== 失败样本载入重测 =====
  const openSamples = (reason = '') => {
    setSamplesOpen(true)
    setSamplesReason(reason)
    setSamplesPage(1)
    loadSamples(reason, 1)
  }

  const loadSamples = (reason = samplesReason, page = 1) => {
    setSamplesLoading(true)
    strategyApi.failureSamples(id, { reason, page, page_size: 10 })
      .then((res) => setSamplesData(res))
      .catch((e) => toast.error(e.message || '失败样本加载失败'))
      .finally(() => setSamplesLoading(false))
  }

  const loadSampleInto = (raw) => {
    setSampleText(raw || '')
    setParseResults(null)
    setSamplesOpen(false)
    toast.success('已载入失败样本，可直接执行测试')
    testRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 切换规则 / 提取类型时清空映射搜索与拖拽状态，避免残留过滤条件
  // 注意：必须在 if (loading) 提前返回之前调用，否则违反 hooks 规则
  // （loading true→false 切换时 hooks 数量变化会报 "Rendered more hooks"）
  const activeExtractType = (activeRule.extract || {}).type || 'fields'
  useEffect(() => { setMappingSearch(''); setDragIdx(null) }, [activeRuleIdx, activeExtractType])

  // ===== 渲染 =====
  if (loading) {
    return <PageContainer><div className="py-20 text-center text-sm text-muted-foreground">加载中…</div></PageContainer>
  }

  const headerFieldsText = (config.outer_wrapper?.header_fields || []).join(', ')

  return (
    <PageContainer>
      {/* 顶部操作栏 */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/strategies')}>
            <ArrowLeft className="h-4 w-4" /> 返回
          </Button>
          <h1 className="text-lg font-semibold text-foreground">{isNew ? '新建解析模板' : '编辑解析模板'}</h1>
          {!isNew && <Badge variant="neutral">ID {id}</Badge>}
          {!isNew && meta?.published_version_no != null && (
            <Badge variant="neutral" title="当前线上生效的发布版本号">线上 v{meta.published_version_no}</Badge>
          )}
          {!isNew && meta?.has_draft && (
            <Badge variant="warning" title="存在未发布的草稿副本，线上版本不受影响">草稿</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="mr-2 flex items-center gap-1 rounded-lg border border-border bg-muted p-1">
            <ModeTab active={mode === 'form'} icon={Table2} label="表单模式" onClick={switchToForm} />
            <ModeTab active={mode === 'json'} icon={Braces} label="JSON 模式" onClick={switchToJson} />
          </div>
          {!isNew && (
            <Button variant="ghost" size="sm" onClick={openVersions}>
              <History className="h-4 w-4" /> 版本历史
            </Button>
          )}
          {canEdit && !isNew && editingDraft && (
            <Button variant="ghost" size="sm" onClick={() => setOnlineOpen(true)} title="查看线上正在生效的版本（只读）">
              <Eye className="h-4 w-4" /> 线上版本
            </Button>
          )}
          {canEdit && !isNew && meta?.has_draft && (
            <Button variant="secondary" size="sm" onClick={handleDiscardDraft}>
              丢弃草稿
            </Button>
          )}
          {canEdit && !isNew && meta?.has_draft && (
            <Button variant="primary" size="sm" onClick={() => setPublishOpen(true)}>
              <Rocket className="h-4 w-4" /> 发布
            </Button>
          )}
          {canEdit && dirty && (
            <Badge variant="warning" title="当前配置有未保存的修改（Ctrl+S 保存）">未保存</Badge>
          )}
          {canEdit && (
            <Button variant={isNew ? 'primary' : 'secondary'} loading={saving} onClick={handleSave}>
              <Save className="h-4 w-4" /> {isNew ? '保存并发布' : '保存草稿'}
            </Button>
          )}
        </div>
      </div>

      {mode === 'form' ? (
        <div className="space-y-4">
          {/* 基本信息 */}
          <Card>
            <SectionTitle icon={Settings2} desc="模板标识，被数据源条目 / 接收器引用后对日志解析生效">基本信息</SectionTitle>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
              <div>
                <label className={labelCls}>模板名称 *</label>
                <input className={inputCls} value={config.strategy_name || ''} placeholder="如：青藤万相全日志 v3.4"
                  onChange={(e) => setCfg({ strategy_name: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>设备类型 *（可自定义）</label>
                <input className={inputCls} value={config.device_type || ''} list="device-type-options" placeholder="如：qingteng_wanxiang"
                  onChange={(e) => setCfg({ device_type: e.target.value })} />
                <datalist id="device-type-options">
                  {deviceTypes.map((t) => <option key={t} value={t} />)}
                </datalist>
              </div>
              <div>
                <label className={labelCls}>版本号</label>
                <input className={inputCls} value={config.version || ''} placeholder="1.0"
                  onChange={(e) => setCfg({ version: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>状态</label>
                <CompactSelect size="lg" block value={config.status || 'enabled'}
                  onChange={(e) => setCfg({ status: e.target.value })}>
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </CompactSelect>
              </div>
            </div>
          </Card>

          {/* 外层解包 */}
          <Card>
            <SectionTitle icon={FileJson} desc="业务数据在原始日志中的位置；header 字段与规则扩展字段一起归档到 extensions">外层解包</SectionTitle>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-3">
              <div>
                <label className={labelCls}>data 路径</label>
                <input className={inputCls} value={config.outer_wrapper?.data_path || ''} placeholder="如：data"
                  onChange={(e) => setWrapper({ data_path: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>uuid 来源路径</label>
                <input className={inputCls} value={config.outer_wrapper?.uuid_source || ''} placeholder="如：data.uuId"
                  onChange={(e) => setWrapper({ uuid_source: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>header 字段（逗号分隔）</label>
                <input className={inputCls} value={headerFieldsText} placeholder="如：sendTime, tenant, type"
                  onChange={(e) => setWrapper({ header_fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
              </div>
            </div>
          </Card>

          {/* 规则列表 + 活跃规则编辑 */}
          <Card>
            <SectionTitle icon={Layers} desc="一个模板可含多条规则，每条负责一种日志类型；先按 match 识别类别，再按 extract 提取字段">解析规则（rules）</SectionTitle>

            {/* 规则列表（左侧可搜索竖排）+ 活跃规则编辑区（右侧） */}
            <div className="flex items-stretch gap-4">
              {/* 左侧：搜索框 + 规则竖排列表 + 添加按钮 */}
              <div className="flex w-60 shrink-0 flex-col">
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={`${inputCls} pl-8`}
                    placeholder="搜索规则 / 日志类型"
                    value={ruleSearch}
                    onChange={(e) => setRuleSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-[520px] flex-1 space-y-1 overflow-y-auto pr-0.5">
                  {(() => {
                    const kw = ruleSearch.trim().toLowerCase()
                    const visible = rules
                      .map((r, i) => ({ r, i }))
                      .filter(({ r }) => !kw
                        || String(r.rule_id || '').toLowerCase().includes(kw)
                        || String(r.log_type || '').toLowerCase().includes(kw))
                    if (!visible.length) {
                      return (
                        <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                          {kw ? '无匹配规则' : '暂无规则'}
                        </div>
                      )
                    }
                    return visible.map(({ r, i }) => (
                      <div
                        key={i}
                        className={`group flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition ${
                          activeIdx === i
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-transparent bg-muted text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        <button
                          onClick={() => setActiveRuleIdx(i)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          title={r.enabled === false ? `${r.log_type || r.rule_id || `规则 ${i + 1}`}（已停用）` : `规则：${r.rule_id || i + 1}`}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled === false ? 'bg-muted-foreground' : 'bg-success'}`} />
                          <span className="truncate">{r.log_type || r.rule_id || `规则 ${i + 1}`}</span>
                          {r.enabled === false && <span className="shrink-0 text-[10px] text-muted-foreground">停用</span>}
                        </button>
                        <button
                          title="删除该规则"
                          onClick={() => removeRule(i)}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  })()}
                </div>
                <Button size="sm" className="mt-2" onClick={addRule}><Plus className="h-3.5 w-3.5" /> 添加规则</Button>
              </div>

              {/* 右侧：活跃规则编辑区 */}
              <div className="min-w-0 flex-1 space-y-4 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className={labelCls}>规则标识（rule_id）</label>
                <input className={`${inputBaseCls} w-40 font-mono`} value={activeRule.rule_id || ''} placeholder="如：alert"
                  onChange={(e) => updateActiveRule({ rule_id: e.target.value })} />
                <label className={labelCls}>日志类型名</label>
                <input className={`${inputBaseCls} w-48`} value={activeRule.log_type || ''} placeholder="如：安全告警"
                  onChange={(e) => updateActiveRule({ log_type: e.target.value })} />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={activeRule.enabled !== false}
                    onChange={(e) => updateActiveRule({ enabled: e.target.checked })} />
                  启用该规则
                </label>
                <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  当前规则 #{activeIdx + 1} / {rules.length}
                </div>
              </div>

              {/* 1. 匹配条件（识别） */}
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Crosshair className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">匹配条件（识别日志类别）</span>
                  <CompactSelect size="md" className="ml-2 w-24" value={(activeRule.match || {}).type || 'all'}
                    onChange={(e) => setActiveMatch({ type: e.target.value })}>
                    <option value="all">all（全部满足）</option>
                    <option value="any">any（任一满足）</option>
                  </CompactSelect>
                </div>
                {activeConditions.length === 0 ? (
                  <EmptyState icon={Crosshair} title="无条件（恒命中）" description="添加条件后按原始日志字段识别本次日志类别" />
                ) : (
                  <div className="space-y-2">
                    {activeConditions.map((cond, ci) => (
                      <div key={ci} className="flex items-center gap-2">
                        <input className={`${inputBaseCls} w-44 font-mono`} value={cond.field || ''} placeholder="字段路径（如 type）"
                          onChange={(e) => updateCondition(ci, { field: e.target.value })} />
                        <CompactSelect size="md" className="w-36" value={cond.op || 'eq'}
                          onChange={(e) => updateCondition(ci, { op: e.target.value })}>
                          {MATCH_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CompactSelect>
                        <input className={`${inputBaseCls} flex-1 font-mono`} value={cond.value ?? ''}
                          placeholder={cond.op === 'in' || cond.op === 'not_in' ? 'JSON 数组，如 ["a","b"]' : '匹配值'}
                          onChange={(e) => updateCondition(ci, { value: e.target.value })} />
                        <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                          title="删除条件" onClick={() => removeCondition(ci)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2">
                  <Button size="sm" onClick={addCondition}><Plus className="h-3.5 w-3.5" /> 添加条件</Button>
                </div>
              </div>

              {/* 2. 字段提取（extract） */}
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Scissors className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">字段提取（extract）</span>
                  <CompactSelect size="md" className="ml-2 w-56" value={activeExtractType}
                    onChange={(e) => {
                      const t = e.target.value
                      if (t === 'fields') setActiveExtract({ type: 'fields', fields: extractFields.length ? extractFields : [emptyMappingRow()] })
                      else if (t === 'regex') setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: (activeRule.extract || {}).source || '', mappings: (activeRule.extract || {}).mappings || [] })
                      else setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: (activeRule.extract || {}).mappings || [] })
                    }}>
                    {EXTRACT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </CompactSelect>
                </div>

                {activeExtractType === 'regex' && (() => {
                  const vis = filterMappingIndices(regexMappings, mappingSearch, ['group', 'target'])
                  return (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div>
                        <label className={labelCls}>提取源路径（可选，从原始日志取文本）</label>
                        <input className={inputCls} value={(activeRule.extract || {}).source || ''} placeholder="如：data.message（留空用解包后业务数据）"
                          onChange={(e) => setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: e.target.value, mappings: (activeRule.extract || {}).mappings || [] })} />
                      </div>
                      <div>
                        <label className={labelCls}>正则表达式（命名组或编号组）</label>
                        <input className={`${inputCls} font-mono`} value={(activeRule.extract || {}).regex || ''} placeholder='如：user=(\w+)\s+ip=(\d+\.\d+\.\d+\.\d+)'
                          onChange={(e) => setActiveExtract({ type: 'regex', regex: e.target.value, source: (activeRule.extract || {}).source || '', mappings: (activeRule.extract || {}).mappings || [] })} />
                      </div>
                    </div>
                    {(regexMappings.length > MAPPING_SEARCH_THRESHOLD || mappingSearch) && (
                      <div className="flex items-center gap-2">
                        <input className={`${inputBaseCls} w-64`} placeholder="搜索捕获组 / 目标字段过滤映射行"
                          value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} />
                        {mappingSearch && <span className="text-xs text-muted-foreground">匹配 {vis.length}/{regexMappings.length} 行</span>}
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="w-8 px-1 py-2" title="拖拽调整行顺序" />
                            <th className="px-2 py-2 font-semibold">捕获组（编号或命名）</th>
                            <th className="px-2 py-2 font-semibold">目标字段</th>
                            <th className="px-2 py-2 font-semibold">转换类型</th>
                            <th className="px-2 py-2 font-semibold">默认值</th>
                            <th className="w-10 px-2 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {vis.map((ri) => {
                            const m = regexMappings[ri]
                            return (
                            <tr key={ri} draggable={!mappingSearch}
                              onDragStart={() => setDragIdx(ri)}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={() => {
                                if (dragIdx != null && dragIdx !== ri) {
                                  setActiveExtract({ type: 'regex', regex: (activeRule.extract || {}).regex || '', source: (activeRule.extract || {}).source || '', mappings: moveArrayItem(regexMappings, dragIdx, ri) })
                                }
                                setDragIdx(null)
                              }}
                              onDragEnd={() => setDragIdx(null)}
                              className={`border-b border-border ${dragIdx === ri ? 'opacity-40' : ''} ${!mappingSearch ? 'cursor-grab' : ''}`}>
                              <td className="w-8 select-none px-1 py-1.5 text-center text-muted-foreground">
                                {!mappingSearch && <GripVertical className="mx-auto h-4 w-4 cursor-grab" />}
                              </td>
                              <td className="px-2 py-1.5">
                                <input className={`${inputBaseCls} w-40 font-mono`} value={m.group ?? ''} placeholder="如 1 或 username"
                                  onChange={(e) => updateRegexMapping(ri, { group: e.target.value })} />
                              </td>
                              <td className="px-2 py-1.5">
                                <input className={`${inputBaseCls} w-40`} value={m.target || ''} list="target-field-options" placeholder="目标字段"
                                  onChange={(e) => updateRegexMapping(ri, { target: e.target.value })} />
                              </td>
                              <td className="px-2 py-1.5">
                                <CompactSelect size="md" className="w-48" value={m.type || 'string'}
                                  onChange={(e) => updateRegexMapping(ri, { type: e.target.value })}>
                                  {CONVERT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </CompactSelect>
                              </td>
                              <td className="px-2 py-1.5">
                                <input className={`${inputBaseCls} w-24`} value={m.default ?? ''} placeholder="默认值"
                                  onChange={(e) => updateRegexMapping(ri, { default: e.target.value })} />
                              </td>
                              <td className="px-2 py-1.5">
                                <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                  title="删除该映射（需确认）"
                                  onClick={() => confirm({
                                    title: '删除捕获映射',
                                    message: `确认删除映射行「${m.group || '（空）'} → ${m.target || '（空）'}」？删除后该捕获组将不再提取。`,
                                    variant: 'danger',
                                    confirmText: '删除',
                                  }).then((ok) => { if (ok) removeRegexMapping(ri) })}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          )})}
                        </tbody>
                      </table>
                    </div>
                    <Button size="sm" onClick={addRegexMapping}><Plus className="h-3.5 w-3.5" /> 添加捕获映射</Button>
                  </div>
                  )
                })()}

                {activeExtractType === 'template' && (() => {
                  const vis = filterMappingIndices(templateMappings, mappingSearch, ['target'])
                  return (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                      <div>
                        <label className={labelCls}>提取源路径（可选）</label>
                        <input className={`${inputCls} font-mono`} value={(activeRule.extract || {}).source || ''} placeholder="如：data.message"
                          onChange={(e) => setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: e.target.value, mappings: (activeRule.extract || {}).mappings || [] })} />
                      </div>
                      <div>
                        <label className={labelCls}>分隔符（正则）</label>
                        <input className={`${inputCls} font-mono`} value={(activeRule.extract || {}).sep || '\\s+'} placeholder={'如 \\s+ 或 |'}
                          onChange={(e) => setActiveExtract({ type: 'template', sep: e.target.value, columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: (activeRule.extract || {}).mappings || [] })} />
                      </div>
                      <div>
                        <label className={labelCls}>列名（逗号分隔，按顺序对应分割结果）</label>
                        <input className={inputCls} value={((activeRule.extract || {}).columns || []).join(', ')} placeholder="如：time, level, event_type"
                          onChange={(e) => setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean), source: (activeRule.extract || {}).source || '', mappings: (activeRule.extract || {}).mappings || [] })} />
                      </div>
                    </div>
                    {(templateMappings.length > MAPPING_SEARCH_THRESHOLD || mappingSearch) && (
                      <div className="flex items-center gap-2">
                        <input className={`${inputBaseCls} w-64`} placeholder="搜索目标字段过滤映射行"
                          value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} />
                        {mappingSearch && <span className="text-xs text-muted-foreground">匹配 {vis.length}/{templateMappings.length} 行</span>}
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="w-8 px-1 py-2" title="拖拽调整行顺序" />
                            <th className="px-2 py-2 font-semibold">列索引</th>
                            <th className="px-2 py-2 font-semibold">目标字段</th>
                            <th className="px-2 py-2 font-semibold">转换类型</th>
                            <th className="w-10 px-2 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {vis.map((ri) => {
                            const m = templateMappings[ri]
                            return (
                            <tr key={ri} draggable={!mappingSearch}
                              onDragStart={() => setDragIdx(ri)}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={() => {
                                if (dragIdx != null && dragIdx !== ri) {
                                  setActiveExtract({ type: 'template', sep: (activeRule.extract || {}).sep || '\\s+', columns: (activeRule.extract || {}).columns || [], source: (activeRule.extract || {}).source || '', mappings: moveArrayItem(templateMappings, dragIdx, ri) })
                                }
                                setDragIdx(null)
                              }}
                              onDragEnd={() => setDragIdx(null)}
                              className={`border-b border-border ${dragIdx === ri ? 'opacity-40' : ''} ${!mappingSearch ? 'cursor-grab' : ''}`}>
                              <td className="w-8 select-none px-1 py-1.5 text-center text-muted-foreground">
                                {!mappingSearch && <GripVertical className="mx-auto h-4 w-4 cursor-grab" />}
                              </td>
                              <td className="px-2 py-1.5">
                                <input className={`${inputBaseCls} w-24 font-mono`} type="number" value={m.index ?? ''} placeholder="列号"
                                  onChange={(e) => updateTemplateMapping(ri, { index: e.target.value === '' ? null : Number(e.target.value) })} />
                              </td>
                              <td className="px-2 py-1.5">
                                <input className={`${inputBaseCls} w-40`} value={m.target || ''} list="target-field-options" placeholder="目标字段"
                                  onChange={(e) => updateTemplateMapping(ri, { target: e.target.value })} />
                              </td>
                              <td className="px-2 py-1.5">
                                <CompactSelect size="md" className="w-48" value={m.type || 'string'}
                                  onChange={(e) => updateTemplateMapping(ri, { type: e.target.value })}>
                                  {CONVERT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </CompactSelect>
                              </td>
                              <td className="px-2 py-1.5">
                                <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                  title="删除该映射（需确认）"
                                  onClick={() => confirm({
                                    title: '删除列映射',
                                    message: `确认删除映射行「第 ${m.index ?? '?'} 列 → ${m.target || '（空）'}」？删除后该列将不再提取。`,
                                    variant: 'danger',
                                    confirmText: '删除',
                                  }).then((ok) => { if (ok) removeTemplateMapping(ri) })}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          )})}
                        </tbody>
                      </table>
                    </div>
                    <Button size="sm" onClick={addTemplateMapping}><Plus className="h-3.5 w-3.5" /> 添加列映射</Button>
                  </div>
                  )
                })()}

                {activeExtractType === 'fields' && (() => {
                  // 搜索过滤（显示用原索引回写）；拖拽排序仅在无搜索时启用
                  const vis = filterMappingIndices(extractFields, mappingSearch, ['source', 'target'])
                  return (
                  <div>
                    {(extractFields.length > MAPPING_SEARCH_THRESHOLD || mappingSearch) && (
                      <div className="mb-2 flex items-center gap-2">
                        <input className={`${inputBaseCls} w-64`} placeholder="搜索源字段 / 目标字段过滤映射行"
                          value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} />
                        {mappingSearch && (
                          <span className="text-xs text-muted-foreground">匹配 {vis.length}/{extractFields.length} 行</span>
                        )}
                      </div>
                    )}
                    <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="w-8 px-1 py-2" title="拖拽调整行顺序" />
                          <th className="px-2 py-2 font-semibold">源字段路径</th>
                          <th className="px-2 py-2 font-semibold">目标字段</th>
                          <th className="px-2 py-2 font-semibold">转换类型</th>
                          <th className="w-14 px-2 py-2 font-semibold">必填</th>
                          <th className="px-2 py-2 font-semibold">默认值</th>
                          <th className="px-2 py-2 font-semibold">枚举映射名</th>
                          <th className="px-2 py-2 font-semibold">枚举目标字段</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {vis.map((fi) => {
                          const m = extractFields[fi]
                          return (
                          <tr key={fi} draggable={!mappingSearch}
                            onDragStart={() => setDragIdx(fi)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              if (dragIdx != null && dragIdx !== fi) {
                                setActiveExtract({ type: 'fields', fields: moveArrayItem(extractFields, dragIdx, fi) })
                              }
                              setDragIdx(null)
                            }}
                            onDragEnd={() => setDragIdx(null)}
                            className={`border-b border-border ${dragIdx === fi ? 'opacity-40' : ''} ${!mappingSearch ? 'cursor-grab' : ''}`}>
                            <td className="w-8 select-none px-1 py-1.5 text-center text-muted-foreground">
                              {!mappingSearch && <GripVertical className="mx-auto h-4 w-4 cursor-grab" />}
                            </td>
                            <td className="px-2 py-1.5">
                              <input className={`${inputBaseCls} w-36 font-mono`} value={m.source || ''} placeholder="源字段名"
                                onChange={(e) => updateExtractField(fi, { source: e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <input className={`${inputBaseCls} w-40`} value={m.target || ''} list="target-field-options" placeholder="目标字段"
                                onChange={(e) => updateExtractField(fi, { target: e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <CompactSelect size="md" className="w-52" value={m.type || 'string'}
                                onChange={(e) => updateExtractField(fi, { type: e.target.value })}>
                                {CONVERT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                              </CompactSelect>
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary" checked={!!m.required}
                                onChange={(e) => updateExtractField(fi, { required: e.target.checked })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <input className={`${inputBaseCls} w-24`} value={m.default ?? ''} placeholder="默认值"
                                onChange={(e) => updateExtractField(fi, { default: e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <CompactSelect size="md" className="w-32" value={m.enum_map || ''}
                                onChange={(e) => {
                                  const enumMap = e.target.value
                                  updateExtractField(fi, { enum_map: enumMap, enum_target: enumMap && !m.enum_target ? `${m.target || ''}_name` : m.enum_target || '' })
                                }}>
                                <option value="">（无）</option>
                                {ruleEnumNames.map((n) => <option key={n} value={n}>{n}</option>)}
                              </CompactSelect>
                            </td>
                            <td className="px-2 py-1.5">
                              <input className={`${inputBaseCls} w-36`} value={m.enum_target || ''} placeholder="枚举翻译写入字段"
                                onChange={(e) => updateExtractField(fi, { enum_target: e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                title="删除该行（需确认）"
                                onClick={() => confirm({
                                  title: '删除字段映射',
                                  message: `确认删除映射行「${m.source || '（空）'} → ${m.target || '（空）'}」？删除后该字段将不再提取。`,
                                  variant: 'danger',
                                  confirmText: '删除',
                                }).then((ok) => { if (ok) removeExtractField(fi) })}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        )})}
                      </tbody>
                    </table>
                    </div>
                    <div className="mt-3">
                      <Button size="sm" onClick={addExtractField}><Plus className="h-3.5 w-3.5" /> 添加字段映射</Button>
                    </div>
                  </div>
                  )
                })()}
              </div>

              {/* 3. 映射补充（map）：枚举 / 默认值 / 校验 */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* 枚举映射 */}
                <div className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Braces className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">枚举映射（map.enum_maps）</span>
                  </div>
                  {ruleEnumNames.length === 0 ? (
                    <EmptyState icon={Braces} title="暂无枚举映射" description="添加枚举组后可在字段提取中选择枚举，把 int 值翻译为中文" />
                  ) : (
                    <div className="space-y-3">
                      {ruleEnumNames.map((name) => {
                        const table = ruleEnumMaps[name] || {}
                        return (
                          <div key={name} className="rounded-md border border-border p-2">
                            <div className="mb-1.5 flex items-center gap-2">
                              <input className={`${inputBaseCls} w-40 font-mono`} value={name} placeholder="枚举名"
                                onChange={(e) => {
                                  const newName = e.target.value
                                  if (!newName || newName === name) return
                                  const maps = {}
                                  Object.entries(ruleEnumMaps).forEach(([k, v]) => { maps[k === name ? newName : k] = v })
                                  // 同步字段映射引用
                                  const fields = extractFields.map((m) => (m.enum_map === name ? { ...m, enum_map: newName } : m))
                                  const next = { enum_maps: maps }
                                  if (activeRule.extract?.type === 'fields') setActiveExtract({ type: 'fields', fields })
                                  setActiveMap(next)
                                }} />
                              <div className="ml-auto flex items-center gap-1">
                                <Button size="sm" onClick={() => addRuleEnumPair(name)}><Plus className="h-3 w-3" /> 添加</Button>
                                <button className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                  title="删除枚举组" onClick={() => removeRuleEnumGroup(name)}>
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            {Object.entries(table).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-1.5 py-0.5">
                                <input className={`${inputBaseCls} w-28`} value={k} placeholder="原值"
                                  onChange={(e) => updateRuleEnumPair(name, k, { key: e.target.value })} />
                                <span className="text-muted-foreground">→</span>
                                <input className={`${inputBaseCls} w-32`} value={v} placeholder="翻译值"
                                  onChange={(e) => updateRuleEnumPair(name, k, { value: e.target.value })} />
                                <button className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                  onClick={() => removeRuleEnumPair(name, k)}>
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="mt-2">
                    <Button size="sm" onClick={addRuleEnumGroup}><Plus className="h-3.5 w-3.5" /> 添加枚举组</Button>
                  </div>
                </div>

                {/* 默认值补充 */}
                <div className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Settings2 className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">默认值补充（map.defaults）</span>
                  </div>
                  {ruleDefaults.length === 0 ? (
                    <EmptyState icon={Settings2} title="暂无默认值" description="目标字段若在提取阶段未赋值，则补充固定值（如 source_type、async_source）" />
                  ) : (
                    <div className="space-y-2">
                      {ruleDefaults.map((d, di) => (
                        <div key={di} className="flex items-center gap-2">
                          <input className={`${inputBaseCls} w-40`} value={d.target || ''} list="target-field-options" placeholder="目标字段"
                            onChange={(e) => updateRuleDefault(di, { target: e.target.value })} />
                          <span className="text-muted-foreground">=</span>
                          <input className={`${inputBaseCls} flex-1`} value={d.value ?? ''} placeholder="固定值"
                            onChange={(e) => updateRuleDefault(di, { value: e.target.value })} />
                          <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                            onClick={() => removeRuleDefault(di)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-2">
                    <Button size="sm" onClick={addRuleDefault}><Plus className="h-3.5 w-3.5" /> 添加默认值</Button>
                  </div>
                </div>
              </div>

              {/* 校验规则 */}
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">校验规则（map.validations）</span>
                </div>
                {ruleValidations.length === 0 ? (
                  <EmptyState icon={AlertTriangle} title="暂无校验规则" description="可对提取后的标准字段做正则 / 范围 / IP 合法性校验，失败记入 warnings" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="px-2 py-2 font-semibold">校验字段</th>
                          <th className="px-2 py-2 font-semibold">规则类型</th>
                          <th className="px-2 py-2 font-semibold">参数</th>
                          <th className="px-2 py-2 font-semibold">严重级别</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {ruleValidations.map((v, vi) => (
                          <tr key={vi} className="border-b border-border">
                            <td className="px-2 py-1.5">
                              <input className={`${inputBaseCls} w-44`} value={v.field || ''} list="target-field-options" placeholder="标准字段"
                                onChange={(e) => updateRuleValidation(vi, { field: e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5">
                              <CompactSelect size="md" className="w-44" value={v.rule || 'regex'}
                                onChange={(e) => updateRuleValidation(vi, { rule: e.target.value })}>
                                {VALIDATION_RULE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                              </CompactSelect>
                            </td>
                            <td className="px-2 py-1.5">
                              {v.rule === 'regex' && (
                                <input className={`${inputBaseCls} w-52 font-mono`} value={v.pattern || ''} placeholder="正则表达式"
                                  onChange={(e) => updateRuleValidation(vi, { pattern: e.target.value })} />
                              )}
                              {v.rule === 'range' && (
                                <div className="flex items-center gap-1.5">
                                  <input className={`${inputBaseCls} w-16`} type="number" value={v.min ?? ''} placeholder="最小"
                                    onChange={(e) => updateRuleValidation(vi, { min: e.target.value === '' ? null : Number(e.target.value) })} />
                                  <span className="text-muted-foreground">~</span>
                                  <input className={`${inputBaseCls} w-16`} type="number" value={v.max ?? ''} placeholder="最大"
                                    onChange={(e) => updateRuleValidation(vi, { max: e.target.value === '' ? null : Number(e.target.value) })} />
                                </div>
                              )}
                              {(v.rule === 'ip_list_valid' || v.rule === 'positive_int') && (
                                <span className="text-xs text-muted-foreground">（无需参数）</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <CompactSelect size="md" className="w-28" value={v.severity || 'warning'}
                                onChange={(e) => updateRuleValidation(vi, { severity: e.target.value })}>
                                <option value="warning">warning</option>
                                <option value="error">error</option>
                              </CompactSelect>
                            </td>
                            <td className="px-2 py-1.5">
                              <button className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-destructive"
                                title="删除该规则" onClick={() => removeRuleValidation(vi)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-2">
                  <Button size="sm" onClick={addRuleValidation}><Plus className="h-3.5 w-3.5" /> 添加校验规则</Button>
                </div>
              </div>

              {/* 扩展字段 */}
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">扩展字段归档（该规则）</span>
                </div>
                <AutoGrowTextarea
                  className={`${inputCls} min-h-[72px] font-mono`}
                  value={ruleExtFields.join('\n')}
                  placeholder={'containerName\ncontainerId'}
                  onChange={(e) => setRuleExtFields(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                />
              </div>
              </div>
            </div>
          </Card>

          {/* 标准字段 datalist（目标字段下拉建议，来自后端） */}
          <datalist id="target-field-options">
            {targetFields.map((f) => (
              <option key={f.name} value={f.name}>{f.comment || f.name}（{f.type}）</option>
            ))}
          </datalist>
        </div>
      ) : (
        // JSON 模式
        <Card>
          <SectionTitle icon={Braces} desc="直接编辑模板 JSON 全文；保存前会做结构与正则校验">模板 JSON</SectionTitle>
          <AutoGrowTextarea
            className="w-full rounded-md border border-input bg-background p-4 font-mono text-[13px] leading-relaxed text-foreground outline-none transition hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary"
            style={{ minHeight: 520 }}
            spellCheck={false}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {effectiveConfig == null && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" /> JSON 格式错误：切换到表单模式或保存时可查看具体错误位置
            </div>
          )}
        </Card>
      )}

      {/* 测试面板 */}
      <div ref={testRef} className="mt-4 scroll-mt-4">
        <Card>
          <SectionTitle
            icon={FlaskConical}
            desc={isNew
              ? '纯内存执行不写库；验证规则命中 → 解包 → 提取 → 枚举翻译 → 校验全链路'
              : '多条原始日志（每行一条）走与接收管道一致的预处理与解析链，不落库；未命中时展示自动路由回退路径'}
          >测试解析</SectionTitle>
          {isNew ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              {/* 新建：单条 JSON 样例 */}
              <div className="lg:col-span-2">
                <label className={labelCls}>样例原始日志 JSON</label>
                <AutoGrowTextarea
                  className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none transition hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary"
                  style={{ minHeight: 240 }}
                  spellCheck={false}
                  placeholder='粘贴设备推送的原始告警 JSON，如：
{
  "type": "security_alert",
  "data": { ... }
}'
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                />
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" size="sm" loading={testing} onClick={handleTest}>
                    <FlaskConical className="h-4 w-4" /> 测试解析
                  </Button>
                  {testResult && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      解析用时 {testResult.parse_ms}ms
                    </span>
                  )}
                </div>
              </div>
              <div className="lg:col-span-3">
                {!testResult ? (
                  <EmptyState icon={FlaskConical} title="尚未执行测试" description="粘贴样例数据后点击「测试解析」查看规则命中与提取明细" className="h-full" />
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-border p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-xs font-semibold text-muted-foreground">规则匹配</span>
                        {testResult.rule?.matched
                          ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />命中该模板</Badge>
                          : <Badge variant="danger"><XCircle className="mr-1 h-3 w-3" />未命中任何规则</Badge>}
                        {testResult.rule?.matched && (
                          <span className="text-xs text-muted-foreground">
                            <code className="rounded bg-muted px-1.5 py-0.5">{testResult.rule.rule_id}</code>
                            {' · '}{testResult.rule.log_type || '未命名类型'}
                          </span>
                        )}
                      </div>
                      {(testResult.db_hits || []).length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[11px] text-muted-foreground">已启用模板匹配过程：</div>
                          {testResult.db_hits.map((h) => (
                            <div key={h.id} className="flex items-center gap-2 text-xs">
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                              <span className="max-w-[220px] truncate">{h.strategy_name}</span>
                              {h.hit ? <Badge variant="success">命中</Badge> : <Badge variant="neutral">未命中</Badge>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-muted-foreground">外层解包：</span>
                      <code className="rounded bg-muted px-1.5 py-0.5">{testResult.unwrap.data_path || '(根对象)'}</code>
                      {testResult.unwrap.found ? <Badge variant="success">成功</Badge> : <Badge variant="danger">data 路径不存在</Badge>}
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-border bg-muted text-left text-muted-foreground">
                            <th className="px-2 py-1.5 font-semibold">源字段</th>
                            <th className="px-2 py-1.5 font-semibold">目标字段</th>
                            <th className="px-2 py-1.5 font-semibold">类型</th>
                            <th className="px-2 py-1.5 font-semibold">源值</th>
                            <th className="px-2 py-1.5 font-semibold">转换后</th>
                            <th className="px-2 py-1.5 font-semibold">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {testResult.mappings.map((m, i) => (
                            <tr key={i} className="border-b border-border last:border-0">
                              <td className="px-2 py-1.5 font-mono">{m.source || '-'}</td>
                              <td className="px-2 py-1.5 font-mono">{m.target || '-'}</td>
                              <td className="px-2 py-1.5 font-mono text-muted-foreground">{m.type}</td>
                              <td className="max-w-[160px] truncate px-2 py-1.5" title={String(m.raw_value ?? '')}>
                                {m.missing ? <span className="text-muted-foreground">(缺失)</span> : String(m.raw_value ?? 'null')}
                              </td>
                              <td className="max-w-[160px] truncate px-2 py-1.5" title={String(m.converted ?? '')}>{String(m.converted ?? 'null')}</td>
                              <td className="px-2 py-1.5">
                                {m.warning
                                  ? <span className="text-warning" title={m.warning}>⚠ 警告</span>
                                  : <span className="text-success">✓</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div className="mb-1.5 flex items-center gap-2 text-xs">
                        <span className="font-semibold text-muted-foreground">校验与警告</span>
                        <Badge variant={testResult.warnings.length ? 'warning' : 'success'}>
                          {testResult.warnings.length ? `${testResult.warnings.length} 条警告 · 状态 partial` : '无警告 · 状态 success'}
                        </Badge>
                      </div>
                      {testResult.warnings.length > 0 && (
                        <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/5 p-2">
                          {testResult.warnings.map((w, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-warning">
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                              <span><code className="font-mono">{w.field || w.source}</code>：{w.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">标准模型 JSON 预览（入库 alert_events 字段）</div>
                      <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
                        {JSON.stringify(testResult.fields, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* 已有模板：多行原始日志 + 模拟上下文 + 草稿切换 + 失败样本载入 */
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <label className={labelCls}>原始日志（每行一条）</label>
                <AutoGrowTextarea
                  className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none transition hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary"
                  style={{ minHeight: 220 }}
                  spellCheck={false}
                  placeholder={'粘贴设备推送的原始报文（自动识别 JSON / 青藤 syslog / 纯文本），如：\n<182>Oct  8 10:21:07 host qtAlert[4154710] datatype="account_change" datatime="1791426061" ...'}
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                />
                {/* 模拟上下文：条目 → 接收器 → 自动匹配优先级链 */}
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <CompactSelect
                      size="lg"
                      block
                      value={ctxEntryId}
                      onChange={(e) => { setCtxEntryId(e.target.value); if (e.target.value) setCtxReceiverId('') }}
                    >
                      <option value="">模拟数据源条目（可选）</option>
                      {entries.map((e) => (
                        <option key={e.id} value={e.id}>{e.name !== e.source_ip ? `${e.name}（${e.source_ip}）` : e.source_ip}</option>
                      ))}
                    </CompactSelect>
                    <CompactSelect
                      size="lg"
                      block
                      value={ctxReceiverId}
                      disabled={!!ctxEntryId}
                      onChange={(e) => setCtxReceiverId(e.target.value)}
                      title={ctxEntryId ? '已选择条目，接收器取条目所属' : '未选条目时可单独选择接收器'}
                    >
                      <option value="">模拟接收器（可选）</option>
                      {receivers.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </CompactSelect>
                  </div>
                  <label
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                    title={meta?.has_draft ? '勾选测试草稿副本内容；取消则测试线上正在生效的版本' : '当前无草稿，测试线上版本；保存草稿后可切换'}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={useDraft && !!meta?.has_draft}
                      disabled={!meta?.has_draft}
                      onChange={(e) => setUseDraft(e.target.checked)}
                    />
                    {meta?.has_draft ? '使用草稿副本测试（取消则测试线上版本）' : '测试线上版本（保存草稿后可测草稿）'}
                  </label>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" size="sm" loading={testing} onClick={handleTestParse}>
                    <FlaskConical className="h-4 w-4" /> 执行测试
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => openSamples()}>
                    <Inbox className="h-4 w-4" /> 载入失败样本重测
                  </Button>
                </div>
              </div>

              {/* 右侧：逐条结果 */}
              <div className="lg:col-span-3">
                {!parseResults ? (
                  <EmptyState icon={FlaskConical} title="尚未执行测试" description="粘贴原始日志后点击「执行测试」：逐条查看命中规则、条件评估、字段提取与校验；未命中时展示回退路径" className="h-full" />
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-xs">
                      <Badge variant={parseResults.strategy?.using === 'draft' ? 'warning' : 'neutral'}>
                        {parseResults.strategy?.using === 'draft' ? '测试对象：草稿副本' : '测试对象：线上版本'}
                      </Badge>
                      <span className="tabular-nums text-muted-foreground">
                        共 {parseResults.summary.total} · 成功 {parseResults.summary.success} · 部分 {parseResults.summary.partial} · 失败 {parseResults.summary.fail}
                      </span>
                      {parseResults.context?.note && (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={parseResults.context.note}>
                          {parseResults.context.note}
                        </span>
                      )}
                    </div>
                    <div className="max-h-[580px] space-y-3 overflow-y-auto pr-1">
                      {parseResults.results.map((r) => (
                        <ParseResultCard key={r.index} r={r} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* 发布确认弹窗 */}
      <Modal
        open={publishOpen}
        title="发布草稿"
        onClose={() => setPublishOpen(false)}
        size="md"
        footer={(
          <>
            <Button variant="secondary" size="sm" onClick={() => setPublishOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={publishing} onClick={handlePublish}>
              <Rocket className="h-4 w-4" /> 确认发布
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            发布后草稿内容将替换线上版本并立即生效（当前线上 v{meta?.published_version_no ?? '-'} 会保留在版本历史中，可随时回滚）。
          </p>
          <div>
            <label className={labelCls}>发布备注（写入版本历史与审计日志）</label>
            <AutoGrowTextarea
              className={`${inputCls} min-h-[72px]`}
              placeholder="如：新增 login_logout 规则、修复 severity 映射"
              value={publishRemark}
              onChange={(e) => setPublishRemark(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {/* 保存前变更预览（diff） */}
      <Modal
        open={saveDiffOpen}
        title="保存前变更预览"
        onClose={() => setSaveDiffOpen(false)}
        size="lg"
        footer={(
          <>
            <Button variant="secondary" size="sm" onClick={() => setSaveDiffOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={doSave}>
              <Save className="h-4 w-4" /> 确认保存
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-4 text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">+ 新增 {saveDiffStats.add} 行</span>
            <span className="text-red-600 dark:text-red-400">- 删除 {saveDiffStats.del} 行</span>
            <span className="text-muted-foreground">
              {isNew ? '（新建模板，全部为新增）' : `（对比当前线上版本 v${meta?.published_version_no ?? '-'}）`}
            </span>
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted font-mono text-[12px] leading-relaxed">
            {saveDiffRows.map((r, i) => (
              <div
                key={i}
                className={`whitespace-pre px-2 py-0.5 ${
                  r.type === 'add'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : r.type === 'del'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                    : 'text-muted-foreground'
                }`}
              >
                <span className="mr-2 select-none">
                  {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
                </span>
                {r.text || ' '}
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* 线上版本查看（只读） */}
      <Modal
        open={onlineOpen}
        title="线上生效版本（只读）"
        onClose={() => setOnlineOpen(false)}
        size="lg"
      >
        <pre className="max-h-[520px] overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
          {JSON.stringify(onlineConfig, null, 2)}
        </pre>
      </Modal>

      {/* 版本历史抽屉：列表 + 两版本 diff + 一键回滚 */}
      <Drawer
        open={versionsOpen}
        title="版本历史"
        onClose={() => setVersionsOpen(false)}
        width="w-[720px]"
      >
        {versionsLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        ) : versions.length === 0 ? (
          <EmptyState icon={History} title="暂无版本记录" description="发布或回滚后自动生成版本快照" />
        ) : (
          <div className="space-y-4">
            {/* 版本列表 */}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted text-left text-muted-foreground">
                    <th className="px-2 py-2 font-semibold">版本</th>
                    <th className="px-2 py-2 font-semibold">发布人</th>
                    <th className="px-2 py-2 font-semibold">发布时间</th>
                    <th className="px-2 py-2 font-semibold">备注</th>
                    <th className="px-2 py-2 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version_no} className="border-b border-border last:border-0">
                      <td className="px-2 py-2">
                        <span className="tabular-nums font-semibold">v{v.version_no}</span>
                        {v.is_current && <Badge variant="success" className="ml-1.5">当前</Badge>}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{v.published_by || '-'}</td>
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{fmtTime(v.published_at)}</td>
                      <td className="max-w-[180px] truncate px-2 py-2 text-muted-foreground" title={v.remark}>{v.remark || '-'}</td>
                      <td className="px-2 py-2">
                        {v.is_current ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={rollbackNo === v.version_no}
                            onClick={() => handleRollback(v)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> 回滚
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 两版本 diff */}
            <div className="rounded-lg border border-border p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <GitCompare className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">版本对比</span>
                <CompactSelect size="md" className="w-28" value={diffA} onChange={(e) => setDiffA(e.target.value)}>
                  <option value="">版本 A</option>
                  {versions.map((v) => <option key={v.version_no} value={v.version_no}>v{v.version_no}</option>)}
                </CompactSelect>
                <span className="text-muted-foreground">→</span>
                <CompactSelect size="md" className="w-28" value={diffB} onChange={(e) => setDiffB(e.target.value)}>
                  <option value="">版本 B</option>
                  {versions.map((v) => <option key={v.version_no} value={v.version_no}>v{v.version_no}</option>)}
                </CompactSelect>
                <Button size="sm" variant="secondary" loading={diffLoading} onClick={handleDiff}>对比</Button>
              </div>
              {diffRows === null ? (
                <div className="text-xs text-muted-foreground">选择两个版本后点击「对比」，查看字段级差异（新增 / 删除 / 修改）</div>
              ) : diffRows.length === 0 ? (
                <div className="text-xs text-success">两版本配置完全一致</div>
              ) : (
                <div className="max-h-80 overflow-auto rounded-md border border-border">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted text-left text-muted-foreground">
                        <th className="px-2 py-1.5 font-semibold">字段路径</th>
                        <th className="px-2 py-1.5 font-semibold">变更</th>
                        <th className="px-2 py-1.5 font-semibold">版本 A 值</th>
                        <th className="px-2 py-1.5 font-semibold">版本 B 值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffRows.map((d, i) => {
                        const meta = DIFF_TYPE_META[d.type]
                        return (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="max-w-[220px] truncate px-2 py-1.5 font-mono" title={d.path}>{d.path}</td>
                            <td className="px-2 py-1.5">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.chip}`}>{meta.label}</span>
                            </td>
                            <td className={`max-w-[160px] truncate px-2 py-1.5 font-mono ${d.type === 'removed' ? 'text-destructive' : 'text-muted-foreground'}`} title={_pv(d.a)}>{_pv(d.a)}</td>
                            <td className={`max-w-[160px] truncate px-2 py-1.5 font-mono ${d.type === 'added' ? 'text-success' : ''}`} title={_pv(d.b)}>{_pv(d.b)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* 失败样本载入重测 */}
      <Modal
        open={samplesOpen}
        title="载入失败样本重测"
        onClose={() => setSamplesOpen(false)}
        size="lg"
      >
        {samplesLoading && !samplesData ? (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        ) : !samplesData || (samplesData.items || []).length === 0 ? (
          <EmptyState icon={Inbox} title="暂无失败样本" description="该模板当前没有解析失败的原始日志留存" />
        ) : (
          <div>
            {/* 原因分类统计（点击筛选） */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {Object.entries(samplesData.stats || {}).map(([k, n]) => {
                const active = samplesReason === k
                return (
                  <button
                    key={k}
                    type="button"
                    className={`rounded-full border px-2.5 py-1 text-xs transition ${
                      active ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}
                    title="点击按此原因筛选"
                    onClick={() => { const next = active ? '' : k; setSamplesReason(next); setSamplesPage(1); loadSamples(next, 1) }}
                  >
                    {samplesData.reason_labels?.[k] || k}
                    <span className="ml-1 tabular-nums">{n}</span>
                  </button>
                )
              })}
            </div>
            <div className="max-h-[440px] space-y-2 overflow-y-auto pr-1">
              {(samplesData.items || []).map((it) => (
                <div key={it.id} className="rounded-lg border border-border p-2.5">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="danger">{it.reason_label}</Badge>
                    <code className="font-mono text-muted-foreground">{it.error_type}</code>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={it.error_msg}>{it.error_msg}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(it.created_at)}</span>
                  </div>
                  <pre className="max-h-16 overflow-hidden rounded bg-muted p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap opacity-80">
                    {it.raw_data}
                  </pre>
                  <div className="mt-1.5 text-right">
                    <Button size="sm" variant="secondary" onClick={() => loadSampleInto(it.raw_data)}>
                      <FlaskConical className="h-3.5 w-3.5" /> 载入重测
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">共 {samplesData.total} 条 · 点击原因标签可筛选</span>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={samplesPage <= 1 || samplesLoading} onClick={() => { const p = samplesPage - 1; setSamplesPage(p); loadSamples(samplesReason, p) }}>上一页</Button>
                <Button size="sm" disabled={samplesPage * 10 >= samplesData.total || samplesLoading} onClick={() => { const p = samplesPage + 1; setSamplesPage(p); loadSamples(samplesReason, p) }}>下一页</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
