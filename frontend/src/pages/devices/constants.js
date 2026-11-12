// 常量映射与工具函数（从 DeviceManagement.jsx 拆分出来）
import { Shield, Cpu, Settings, Cloud, LayoutGrid, List, Columns } from 'lucide-react'
import { toast } from '../../store/toastStore'

export const DEVICE_TYPES = [
  { value: 'firewall', label: '防火墙', icon: Shield },
  { value: 'waf', label: 'WAF', icon: Shield },
  { value: 'ips', label: 'IPS', icon: Shield },
  { value: 'ids', label: 'IDS', icon: Shield },
  { value: 'edr', label: 'EDR', icon: Cpu },
  { value: 'soar', label: 'SOAR 平台', icon: Settings },
  { value: 'switch', label: '交换机', icon: Cpu },
  { value: 'cloud', label: '云平台', icon: Cloud },
  { value: 'qingteng', label: '青藤万相', icon: Cpu },
  { value: 'custom', label: '自定义', icon: Settings },
]
export const DEVICE_TYPE_LABELS = Object.fromEntries(
  DEVICE_TYPES.map((t) => [t.value, t.label])
)
export const DEVICE_TYPE_ICON = Object.fromEntries(
  DEVICE_TYPES.map((t) => [t.value, t.icon])
)

// 设备状态元数据
export const STATUS_META = {
  online: { label: '在线', dot: 'bg-success', cls: 'bg-success/15 text-success' },
  offline: { label: '离线', dot: 'bg-destructive', cls: 'bg-destructive/15 text-destructive' },
  abnormal: { label: '异常', dot: 'bg-warning', cls: 'bg-warning/15 text-warning' },
  unconfigured: { label: '未配置', dot: 'bg-muted-foreground', cls: 'bg-secondary text-muted-foreground' },
  disabled: { label: '停用', dot: 'bg-zinc-700', cls: 'bg-zinc-700/20 text-zinc-400' },
}
export const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'abnormal', label: '异常' },
  { value: 'unconfigured', label: '未配置' },
  { value: 'disabled', label: '停用' },
]

// 动作分类
export const ACTION_CATEGORIES = {
  block: { label: '阻断', cls: 'bg-destructive/15 text-destructive' },
  query: { label: '查询', cls: 'bg-primary/15 text-primary' },
  dispose: { label: '处置', cls: 'bg-success/15 text-success' },
  notify: { label: '通知', cls: 'bg-purple-500/15 text-purple-400' },
  other: { label: '其他', cls: 'bg-secondary text-muted-foreground' },
}
export const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'block', label: '阻断' },
  { value: 'query', label: '查询' },
  { value: 'dispose', label: '处置' },
  { value: 'notify', label: '通知' },
  { value: 'other', label: '其他' },
]

// 风险等级
export const RISK_META = {
  readonly: { label: '只读', cls: 'bg-success/15 text-success' },
  high_risk: { label: '高风险', cls: 'bg-destructive/15 text-destructive' },
}
export const RISK_OPTIONS = [
  { value: 'readonly', label: '只读' },
  { value: 'high_risk', label: '高风险' },
]

// HTTP 方法颜色
export const HTTP_METHOD_CLS = {
  GET: 'bg-success/20 text-success',
  POST: 'bg-warning/20 text-warning',
  DELETE: 'bg-destructive/20 text-destructive',
  PUT: 'bg-primary/20 text-primary',
  PATCH: 'bg-purple-500/20 text-purple-400',
}
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

// 动作类型
export const ACTION_TYPES = [
  { value: 'block_ip', label: '封禁 IP' },
  { value: 'unblock_ip', label: '解封 IP' },
  { value: 'quarantine_host', label: '隔离主机' },
  { value: 'isolate_endpoint', label: '隔离终端' },
  { value: 'add_ioc', label: '添加 IOC' },
  { value: 'delete_ioc', label: '删除 IOC' },
  { value: 'custom', label: '自定义' },
]

// 设备认证方式
export const DEVICE_AUTH_TYPES = [
  { value: 'none', label: '无认证' },
  { value: 'api_key', label: 'API Key' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'mtls', label: 'mTLS 双向证书' },
  { value: 'qingteng', label: '青藤签名 (JWT/Sign)' },
  { value: 'sangfor_xdr', label: '深信服 XDR 联动码签名 (AK/SK)' },
]

// 动作认证方式
export const ACTION_AUTH_TYPES = [
  { value: 'inherit', label: '继承设备' },
  { value: 'none', label: '无认证' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'qingteng', label: '青藤签名 (JWT/Sign)' },
  { value: 'sangfor_xdr', label: '深信服 XDR 联动码签名 (AK/SK)' },
]

// 参数类型支持
export const PARAM_TYPES = ['string', 'number', 'boolean', 'enum', 'ip', 'port', 'domain', 'array', 'object', 'duration']

// 视图模式
export const VIEW_MODES = [
  { value: 'card', icon: LayoutGrid, label: '卡片视图' },
  { value: 'table', icon: List, label: '列表视图' },
  { value: 'split', icon: Columns, label: '分栏视图' },
]

// ============ 工具函数 ============
// 数值格式化：千位分隔符（表格数值列统一使用）
export function fmtNum(v) {
  if (v == null) return null
  const n = Number(v)
  if (Number.isNaN(n)) return null
  return n.toLocaleString('zh-CN')
}
// 表格数值单元格内容：null/undefined → '--'，0 → 灰色 '0'，其余千位分隔
export function numCell(v) {
  if (v == null) return { text: '--', muted: true }
  const text = fmtNum(v)
  if (text == null) return { text: '--', muted: true }
  return { text, muted: Number(v) === 0 }
}
export function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}
export function fmtRelative(t) {
  if (!t) return '-'
  try {
    const diff = Date.now() - new Date(t).getTime()
    if (diff < 0) return fmtTime(t)
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return `${Math.floor(diff / 86400000)} 天前`
  } catch {
    return t
  }
}
export function copyText(text) {
  if (!text) return
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast.success('已复制')).catch(() => {})
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      toast.success('已复制')
    }
  } catch {
    toast.error('复制失败')
  }
}
export function safeParseJson(str, fallback) {
  if (!str) return fallback
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}
export function truncate(s, n = 30) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}...` : s
}
export function parseTags(tags) {
  if (!tags) return []
  if (Array.isArray(tags)) return tags
  const arr = safeParseJson(tags, [])
  return Array.isArray(arr) ? arr : []
}
// 校验 IP 地址：空串或合法的 IPv4 / IPv6 地址（IPv6 采用浏览器自带解析做严格校验）
export function normalizeIpAddress(v) {
  const s = (v || '').trim()
  if (!s) return ''
  // IPv4：四段 0-255
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    return v4.slice(1).every((seg) => Number(seg) >= 0 && Number(seg) <= 255) ? s : null
  }
  // IPv6：交给 URL 解析器（需含冒号）
  if (s.includes(':')) {
    try {
      const probe = new URL(`http://[${s}]/`)
      if (probe.hostname) return s
    } catch {
      return null
    }
  }
  return null
}
export function successRate(action) {
  const total = action.call_count_24h ?? 0
  const ok = action.success_count_24h ?? 0
  if (!total) return null
  return ok / total
}

// ============ 动作测试：模拟数据生成 ============
// 依据 params_schema 的类型/格式/约束与 action.example_payload 生成一组测试参数：
// 必填参数一定覆盖，可选参数优先取示例值/默认值，可直接发起接口可用性验证。
const MOCK_IP = '192.0.2.10' // TEST-NET-1，保留给文档与测试使用
const MOCK_CIDR = '192.0.2.0/24'
const MOCK_DOMAIN = 'example.com'

function mockUuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    // 非安全上下文下降级为手工拼装
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// 起止时间类参数统一用「最近 7 天」，避免示例里的历史时间戳失效
function isStartTimeParam(lname) {
  return /(timestamp|time)$/.test(lname) && /^(start|begin|from)/.test(lname)
}
function isEndTimeParam(lname) {
  return /(timestamp|time)$/.test(lname) && /^(end|to|finish|until)/.test(lname)
}

// 复杂类型在表单里以 JSON 文本展示
function toInputValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function mockJsonValue(lname, kind) {
  if (kind === 'object') return '{}'
  if (/uuid|ids$|^ids$/.test(lname)) return JSON.stringify([mockUuid()])
  if (/ips$|^ips$/.test(lname)) return JSON.stringify([MOCK_IP])
  if (/(tags?|labels?)$/.test(lname)) return JSON.stringify(['test'])
  return '[]'
}

function mockValue(spec, lname, type, nowSec) {
  if (spec.default !== undefined && spec.default !== null && spec.default !== '') {
    return toInputValue(spec.default)
  }
  if (type === 'boolean') return true
  if (type === 'enum') {
    return Array.isArray(spec.options) && spec.options.length ? spec.options[0] : ''
  }
  if (type === 'ip') return MOCK_IP
  if (type === 'cidr') return MOCK_CIDR
  if (type === 'port') return 443
  if (type === 'domain') return MOCK_DOMAIN
  if (type === 'duration') return '1小时'
  if (type === 'array') return mockJsonValue(lname, 'array')
  if (type === 'object' || type === 'json') return mockJsonValue(lname, 'object')
  if (['integer', 'int', 'number'].includes(type)) {
    if (lname === 'page') return 1
    if (/(pagesize|size|limit|top|count)$/.test(lname)) return 5
    if (/(timestamp|time)$/.test(lname)) return nowSec
    const min = spec.min ?? spec.minimum
    const num = Number(min)
    return min !== undefined && min !== null && Number.isFinite(num) ? num : 1
  }
  // 字符串：按常见字段名给出符合格式约束的样例
  if (lname === 'timefield') return 'lastTime'
  if (/uuid/.test(lname)) return mockUuid()
  if (/(^ip$|ip$|ips$|srcip|dstip|hostip)/.test(lname)) return MOCK_IP
  if (/(domain|hostname)/.test(lname)) return MOCK_DOMAIN
  if (/(comment|remark|note|reason)/.test(lname)) return '自动化测试'
  if (/name$/.test(lname)) return 'auto-test'
  return 'test'
}

/**
 * 生成动作测试参数（用于「智能填充」）。
 * @param {object} action 设备动作（含 params_schema / example_payload）
 * @param {number} now 当前毫秒时间戳（便于测试注入）
 */
export function buildMockTestParams(action, now = Date.now()) {
  const schema = safeParseJson(action?.params_schema, [])
  const example = safeParseJson(action?.example_payload, null)
  const exampleObj =
    example && typeof example === 'object' && !Array.isArray(example) ? example : null
  const nowSec = Math.floor(now / 1000)
  const out = {}
  ;(Array.isArray(schema) ? schema : []).forEach((spec) => {
    const name = spec?.name
    if (!name) return
    const lname = String(name).toLowerCase()
    const type = String(spec.type || 'string').toLowerCase()
    if (isStartTimeParam(lname)) {
      out[name] = nowSec - 7 * 86400
      return
    }
    if (isEndTimeParam(lname)) {
      out[name] = nowSec
      return
    }
    const exVal = exampleObj?.[name]
    if (exVal !== undefined && exVal !== null && exVal !== '') {
      out[name] = toInputValue(exVal)
      return
    }
    if (!spec.required) {
      // 可选参数不塞无关条件，仅在声明了默认值时填充
      if (spec.default !== undefined && spec.default !== null && spec.default !== '') {
        out[name] = toInputValue(spec.default)
      }
      return
    }
    out[name] = mockValue(spec, lname, type, nowSec)
  })
  return out
}

/**
 * 提交前按 schema 归一化参数类型：
 * 表单输入都是字符串，这里把 integer/number/boolean/array/object 转成后端期望的类型，
 * 并丢弃空值（后端按「未填写」处理）。
 */
export function normalizeTestParams(schema, params) {
  const out = {}
  ;(Array.isArray(schema) ? schema : []).forEach((spec) => {
    const name = spec?.name
    if (!name) return
    const raw = params?.[name]
    if (raw === undefined || raw === null || raw === '') return
    const type = String(spec.type || '').toLowerCase()
    if (['integer', 'int'].includes(type)) {
      const num = Number(raw)
      out[name] = Number.isFinite(num) ? Math.trunc(num) : raw
    } else if (type === 'number') {
      const num = Number(raw)
      out[name] = Number.isFinite(num) ? num : raw
    } else if (type === 'boolean') {
      out[name] = typeof raw === 'boolean' ? raw : String(raw).toLowerCase() === 'true'
    } else if (['array', 'object', 'json'].includes(type) && typeof raw === 'string') {
      try {
        out[name] = JSON.parse(raw)
      } catch {
        out[name] = raw
      }
    } else {
      out[name] = raw
    }
  })
  return out
}
