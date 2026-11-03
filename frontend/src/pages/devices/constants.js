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
]

// 动作认证方式
export const ACTION_AUTH_TYPES = [
  { value: 'inherit', label: '继承设备' },
  { value: 'none', label: '无认证' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'qingteng', label: '青藤签名 (JWT/Sign)' },
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
