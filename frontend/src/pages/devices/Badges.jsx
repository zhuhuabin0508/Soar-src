// 通用小组件：设备类型图标、状态/分类/风险/方法徽章、Switch、Section
import { useState } from 'react'
import { Shield, ChevronDown, ChevronRight } from 'lucide-react'
import {
  DEVICE_TYPE_ICON,
  STATUS_META,
  ACTION_CATEGORIES,
  RISK_META,
  HTTP_METHOD_CLS,
} from './constants'

// ============ 设备类型图标 ============
export function DeviceTypeIcon({ type, className = 'h-5 w-5' }) {
  const Icon = DEVICE_TYPE_ICON[type] || Shield
  return <Icon className={className} />
}

// ============ 状态徽章 ============
export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.unconfigured
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

// ============ 动作分类徽章 ============
export function CategoryBadge({ category }) {
  const meta = ACTION_CATEGORIES[category] || ACTION_CATEGORIES.other
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

// ============ 风险等级徽章 ============
export function RiskBadge({ level }) {
  const meta = RISK_META[level] || RISK_META.readonly
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

// ============ HTTP 方法徽章 ============
export function MethodBadge({ method }) {
  const cls = HTTP_METHOD_CLS[method] || 'bg-secondary text-muted-foreground'
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${cls}`}>
      {method}
    </span>
  )
}

// ============ Switch 开关 ============
export function Switch({ checked, onChange, disabled, size = 'md' }) {
  const w = size === 'sm' ? 'w-8' : 'w-10'
  const h = size === 'sm' ? 'h-4' : 'h-5'
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
  const translate = size === 'sm' ? 'translate-x-4' : 'translate-x-5'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex ${w} ${h} shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-secondary border border-border'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span
        className={`inline-block ${knob} transform rounded-full bg-background shadow transition-transform ${
          checked ? translate : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// ============ Section 表单分组 ============
export function Section({ title, hint, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        </div>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </button>
      {open && <div className="border-t border-border p-3">{children}</div>}
    </div>
  )
}
