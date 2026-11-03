// 通用 UI 组件库（令牌化版本）
// 统一按钮 / 卡片 / 页面容器 / 页面标题 / 徽章 / 数据表格 / 状态组件
// 所有组件遵循语义令牌（bg-background / text-foreground / border-border 等），
// 明暗主题切换零改动。提炼自 soar-ui-design skill。
import { isValidElement, createElement, Fragment, useState, useRef, useEffect, useMemo, Children } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Calendar, Clock } from 'lucide-react'
import { useDensityStore, DENSITY_CLASS } from '../store/densityStore'
import DensitySwitcher from './DensitySwitcher'

// ===== Button =====
// variant: primary | secondary | danger | ghost
// size: sm | md
// loading: 显示加载旋转图标并禁用
const BTN_VARIANT = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  className = '',
  ...props
}) {
  const variantCls = BTN_VARIANT[variant] || BTN_VARIANT.secondary
  const sizeCls = size === 'sm' ? 'btn-sm' : ''
  return (
    <button
      className={`${variantCls} ${sizeCls} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
}

// ===== Card =====
// 统一卡片容器：圆角令牌 + 语义边框/背景 + hover 微抬
// 可选 title / description / actions（头部区域）
// hover: 启用 card-hover 微交互（桌面端上抬 + 阴影）
export function Card({ title, description, actions, children, className = '', bodyClassName = '', hover = false }) {
  return (
    <div className={`card ${hover ? 'card-hover' : ''} ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="truncate text-sm font-semibold text-card-foreground">{title}</h3>}
            {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName || 'p-4'}>{children}</div>
    </div>
  )
}

// ===== PageContainer =====
// 统一页面外层容器：语义背景 + padding + 最小高度
export function PageContainer({ children, className = '' }) {
  return <div className={`page-container ${className}`}>{children}</div>
}

// ===== PageHeader =====
// 统一页面标题栏：标题 + 描述 + 右侧操作区
export function PageHeader({ title, description, actions, className = '' }) {
  return (
    <div className={`mb-6 flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ===== Badge =====
// variant: primary | success | warning | danger | info | neutral
const BADGE_VARIANT = {
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
  neutral: 'bg-muted text-muted-foreground',
}

export function Badge({ children, variant = 'neutral', className = '' }) {
  return (
    <span className={`badge ${BADGE_VARIANT[variant] || BADGE_VARIANT.neutral} ${className}`}>
      {children}
    </span>
  )
}

// ===== StatusBadge =====
// 状态徽章：圆点 + 文字，语义色映射
// status: { color: 'success|warning|danger|info|neutral', label } 或直接传 statusKey
const STATUS_COLOR_BG = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  neutral: 'bg-muted-foreground',
}

// 业务状态 → 语义色 + 中文标签 的统一映射
// 覆盖执行状态 / 资产状态 / 用户状态 / 工作流状态等所有列表页
// 用法:
//   import { statusMeta, StatusBadge } from '../components/ui'
//   const m = statusMeta(row.status)  // { color, label }
//   <StatusBadge color={m.color} label={m.label} />
export function statusMeta(status) {
  const s = String(status || '').toLowerCase()
  switch (s) {
    // 成功
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'active':
    case 'enabled':
    case 'approved':
    case 'online':
      return { color: 'success', label: labelFromStatus(status) }
    // 失败/危险
    case 'failed':
    case 'error':
    case 'rejected':
    case 'banned':
    case 'offline':
    case 'expired':
      return { color: 'danger', label: labelFromStatus(status) }
    // 进行中
    case 'running':
    case 'pending':
    case 'processing':
    case 'in_progress':
      return { color: 'info', label: labelFromStatus(status) }
    // 待审批/警告/未配置
    case 'waiting_for_approval':
    case 'waiting':
    case 'paused':
    case 'warning':
    case 'draft':
    case 'unconfigured':
    case 'pending_config':
      return { color: 'warning', label: labelFromStatus(status) }
    // 停用=灰（规范：在线/成功=绿、未配置/待配置=橙、离线/失败=红、停用=灰）
    case 'disabled':
    case 'inactive':
      return { color: 'neutral', label: labelFromStatus(status) }
    // 中性(默认)
    default:
      return { color: 'neutral', label: labelFromStatus(status) }
  }
}

// 业务状态 → 中文标签(不区分大小写)
// 未识别的状态原样返回(便于发现遗漏)
function labelFromStatus(status) {
  if (!status) return '-'
  const s = String(status)
  const map = {
    success: '成功',
    succeeded: '成功',
    completed: '已完成',
    failed: '失败',
    error: '错误',
    rejected: '已拒绝',
    approved: '已批准',
    running: '运行中',
    pending: '处理中',
    processing: '处理中',
    in_progress: '进行中',
    waiting_for_approval: '待审批',
    waiting: '等待中',
    paused: '已暂停',
    active: '活跃',
    enabled: '已启用',
    disabled: '已禁用',
    banned: '已封禁',
    online: '在线',
    offline: '离线',
    expired: '已过期',
    draft: '草稿',
    inactive: '未激活',
  }
  return map[s.toLowerCase()] || s
}

export function StatusBadge({ color = 'neutral', label, status, className = '' }) {
  // 支持 status prop:直接传业务状态字符串,自动解析为 color + label
  if (status && !color) {
    const m = statusMeta(status)
    color = m.color
  }
  if (status && !label) {
    label = labelFromStatus(status)
  }
  const dotCls = STATUS_COLOR_BG[color] || STATUS_COLOR_BG.neutral
  // 进行中类状态（info）圆点带呼吸动画，直观传达“活跃”
  const pulse = color === 'info'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${className}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls} ${pulse ? 'dot-pulse' : ''}`} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

// ===== Sparkline =====
// 24h 迷你趋势线（轻量 SVG，零依赖）：面积 + 折线 + 峰值点
// data: [{ hour: 'YYYY-MM-DDTHH', total: number }, ...]（升序 24 个整点）
// 悬停显示峰值时间（SVG 原生 title）；颜色跟随 currentColor，由外层文字色控制
export function Sparkline({ data = [], width = 92, height = 28, className = '' }) {
  const rows = Array.isArray(data) ? data : []
  const pts = rows.map((d) => Number(d?.total) || 0)
  const n = pts.length
  if (!n) return null
  const max = Math.max(...pts)
  const min = Math.min(...pts)
  const range = max - min || 1
  const step = n > 1 ? width / (n - 1) : 0
  const y = (v) => (height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v)}`).join(' ')
  const area = `${path} L${width},${height} L0,${height} Z`
  // 峰值悬停提示：取首个峰值小时（MM-DD HH:00）
  const peakIdx = pts.indexOf(max)
  const peakHour = String(rows[peakIdx]?.hour || '')
  const peakLabel = peakHour ? `${peakHour.slice(5, 7)}-${peakHour.slice(8, 10)} ${peakHour.slice(11, 13)}:00` : ''
  const tip = max > 0 && peakLabel ? `近24小时峰值 ${max.toLocaleString()} · 出现于 ${peakLabel}` : '近24小时暂无数据'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`shrink-0 ${className}`} role="img" aria-label={tip}>
      <title>{tip}</title>
      <path d={area} fill="currentColor" opacity="0.12" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {max > 0 && (
        <circle cx={(peakIdx * step).toFixed(1)} cy={y(max)} r="2" fill="currentColor" />
      )}
    </svg>
  )
}

// ===== Skeleton =====
// 骨架屏占位：流光动画（见 index.css .skeleton-shimmer）
// 用法：<Skeleton className="h-4 w-24" /> 或 <Skeleton lines={3} />
export function Skeleton({ className = '', lines, ...props }) {
  if (lines && lines > 0) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer h-3 rounded"
            style={{ width: i === lines - 1 ? '70%' : '100%' }}
          />
        ))}
      </div>
    )
  }
  return <div className={`skeleton-shimmer rounded ${className}`} {...props} />
}

// ===== LoadingState =====
// 加载态：骨架屏模拟表格/卡片布局，替代居中 spinner
export function LoadingState({ rows = 5, cols = 4, className = '' }) {
  return (
    <div className={`flex flex-col gap-3 p-4 ${className}`}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

// ===== EmptyState =====
// 空态：图标 + 标题 + 描述 + 可选操作引导
// icon: ReactNode 或 lucide 图标组件（自动创建元素）
export function EmptyState({ icon, title = '暂无数据', description, action, bordered = false, className = '' }) {
  // 兼容两种传入方式：JSX 元素（isValidElement）或组件类型（函数/forwardRef）
  const iconNode = icon
    ? (isValidElement(icon) ? icon : createElement(icon))
    : (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="6" rx="9" ry="3" />
        <path d="M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6" />
        <path d="M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6" />
      </svg>
    )
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${
        bordered ? 'rounded-lg border border-border' : ''
      } ${className}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {iconNode}
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

// ===== ErrorState =====
// 错误态：图标 + 错误信息 + 重试按钮
export function ErrorState({ title = '加载失败', description, onRetry, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}

// ===== DataTable =====
// 统一数据表格：语义令牌 + 骨架加载 + 空态 + 粘性表头 + 批量选择
// columns: [{ key, header, render?, className?, width?, numeric?, sticky?, stickyOffset? }]
// sticky: 'left' | 'right' 冻结列；stickyOffset 仅用于左侧冻结列，表示前序冻结列累计宽度（px）
// data: 行数据数组
// loading / emptyText / emptyDescription / emptyIcon / emptyAction（带图标+引导按钮的空态）
// onRowClick / rowClickHint（行点击的 hover 提示文案，默认「点击查看详情」）/ stickyHeader
// selectable: 开启行选择列；selectedKeys: 当前选中 rowKey 集合；onSelectChange: (keys)=>void
// 复选框点击区域：整列单元格可点击（用 label 包装），点整行不触发选择
export function DataTable({
  columns = [],
  data = [],
  loading = false,
  emptyText = '暂无数据',
  emptyDescription,
  emptyIcon,
  emptyAction,
  onRowClick,
  rowClickHint = '点击查看详情',
  rowKey = 'id',
  stickyHeader = false,
  selectable = false,
  selectedKeys = [],
  onSelectChange,
  rowClassName,
  draggable = false,
  onReorder,
  maxHeight,
  className = '',
}) {
  // 数据密度:全局 store,所有 DataTable 共享
  const density = useDensityStore((s) => s.density)
  const dCls = DENSITY_CLASS[density] || DENSITY_CLASS.standard
  // 拖拽排序状态：dragIndex=被拖起的行下标，dragOverIndex=悬停目标行下标
  const [dragIndex, setDragIndex] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  // 选择状态计算
  const selectedSet = new Set(selectedKeys)
  const pageKeys = data.map((row) => row[rowKey])
  const allSelected = selectable && data.length > 0 && pageKeys.every((k) => selectedSet.has(k))
  const someSelected = selectable && !allSelected && pageKeys.some((k) => selectedSet.has(k))

  const toggleAll = (checked) => {
    if (!onSelectChange) return
    if (checked) {
      // 合并：保留已选 + 当前页全部
      onSelectChange([...new Set([...selectedKeys, ...pageKeys])])
    } else {
      // 取消当前页全部
      const pageSet = new Set(pageKeys)
      onSelectChange(selectedKeys.filter((k) => !pageSet.has(k)))
    }
  }

  const toggleRow = (key, checked) => {
    if (!onSelectChange) return
    onSelectChange(checked ? [...selectedKeys, key] : selectedKeys.filter((k) => k !== key))
  }

  // 行点击：仅触发 onRowClick 回调；选中只能通过勾选框操作
  const handleRowClick = (row) => {
    if (onRowClick) {
      onRowClick(row)
    }
  }

  const colSpan = columns.length + (selectable ? 1 : 0)

  // 冻结列（sticky）：'left' | 'right'。单元格必须自带不透明底色，
  // 否则横向滚动时下层行内容会透出（背景与分割线样式见 index.css .table-sticky-*）
  const stickyCellCls = (col, isHeader) => {
    if (col.sticky === 'left') {
      return isHeader
        ? 'sticky left-0 z-sticky table-sticky-head table-sticky-left'
        : 'sticky z-dropdown table-sticky-cell table-sticky-left'
    }
    if (col.sticky === 'right') {
      return isHeader
        ? 'sticky right-0 z-sticky table-sticky-head table-sticky-right'
        : 'sticky z-dropdown table-sticky-cell table-sticky-right'
    }
    return ''
  }

  return (
    <div
      className={`table-wrap overflow-x-auto ${maxHeight ? 'overflow-y-auto' : ''} ${className}`}
      style={maxHeight ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight } : undefined}
    >
      {/* table-fixed：列宽按 width 分配，超长内容配合单元格 overflow 截断，
          避免长描述把表格撑出横向滚动条 */}
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr
            className={`border-b border-border text-left ${dCls.header} text-muted-foreground ${
              stickyHeader ? 'sticky top-0 z-base' : ''
            }`}
            style={{ background: 'var(--table-header)' }}
          >
            {selectable && (
              <th key="__select" className={`px-3 ${dCls.header}`} style={{ width: '44px' }}>
                <label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded hover:bg-accent">
                  <input
                    type="checkbox"
                    className="h-[18px] w-[18px] cursor-pointer rounded border-border accent-primary"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected
                    }}
                    onChange={(e) => toggleAll(e.target.checked)}
                    aria-label="全选当前页"
                  />
                </label>
              </th>
            )}
            {columns.map((col) => (
              // 表头默认单行省略（避免全局换行把其它表格表头挤高）；
              // 长字段名场景可由列配置 wrapHeader: true 显式开启换行
              <th
                key={col.key}
                className={`px-4 align-middle leading-snug ${dCls.header} font-semibold ${col.numeric ? 'text-right tabular-nums' : ''} ${col.wrapHeader ? 'break-words whitespace-normal' : 'truncate whitespace-nowrap'} ${col.className || ''} ${stickyCellCls(col, true)}`}
                style={col.sticky || col.width ? {
                  ...(col.width ? { width: col.width } : {}),
                  ...(col.sticky === 'left' ? { left: `${col.stickyOffset || 0}px` } : {}),
                  ...(col.sticky === 'right' ? { right: 0 } : {}),
                } : undefined}
                title={typeof col.header === 'string' ? col.header : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={colSpan} className="px-4 py-0">
                <LoadingState rows={6} cols={columns.length} />
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="px-4 py-0">
                <EmptyState
                  icon={emptyIcon}
                  title={emptyText}
                  description={emptyDescription}
                  action={emptyAction}
                />
              </td>
            </tr>
          ) : (
            data.map((row, i) => {
              const key = row[rowKey] ?? i
              const checked = selectable && selectedSet.has(row[rowKey])
              const clickable = !!onRowClick
              const extraRowCls = rowClassName ? rowClassName(row) : ''
              const isDragging = draggable && dragIndex === i
              const isDragOver = draggable && dragOverIndex === i && dragIndex !== null && dragIndex !== i
              return (
                <tr
                  key={key}
                  draggable={draggable}
                  onDragStart={(e) => {
                    if (!draggable) return
                    setDragIndex(i)
                    e.dataTransfer.effectAllowed = 'move'
                    try { e.dataTransfer.setData('text/plain', String(i)) } catch (_) {}
                  }}
                  onDragOver={(e) => {
                    if (!draggable || dragIndex === null) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverIndex !== i) setDragOverIndex(i)
                  }}
                  onDragLeave={() => draggable && dragOverIndex === i && setDragOverIndex(null)}
                  onDrop={(e) => {
                    if (!draggable || dragIndex === null) return
                    e.preventDefault()
                    if (dragIndex !== i && onReorder) onReorder(dragIndex, i)
                    setDragIndex(null)
                    setDragOverIndex(null)
                  }}
                  onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
                  onClick={() => handleRowClick(row)}
                  title={clickable ? rowClickHint : undefined}
                  className={`table-row-hover border-b border-border ${clickable ? 'cursor-pointer' : ''} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${checked ? 'table-row-selected bg-primary/5' : ''} ${isDragging ? 'opacity-40' : ''} ${isDragOver ? 'ring-2 ring-inset ring-primary/50 bg-primary/5' : ''} ${extraRowCls}`}
                >
                  {selectable && (
                    <td key="__select" className={`px-3 ${dCls.cell}`} style={{ width: '44px' }} onClick={(e) => e.stopPropagation()}>
                      <label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded hover:bg-accent">
                        <input
                          type="checkbox"
                          className="h-[18px] w-[18px] cursor-pointer rounded border-border accent-primary"
                          checked={checked}
                          onChange={(e) => toggleRow(row[rowKey], e.target.checked)}
                          aria-label="选择该行"
                        />
                      </label>
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`overflow-hidden text-ellipsis whitespace-nowrap px-4 ${dCls.cell} text-foreground ${col.numeric ? 'text-right tabular-nums' : ''} ${col.className || ''} ${stickyCellCls(col, false)}`}
                      style={
                        col.sticky === 'left' ? { left: `${col.stickyOffset || 0}px` }
                          : col.sticky === 'right' ? { right: 0 }
                            : undefined
                      }
                    >
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

// ===== Pagination =====
// 统一分页控件：条数区间 + 每页大小选择 + 跳页 + 上下页
// onPageChange(page) / onPageSizeChange(size)（可选）
// showPageSize：是否显示每页大小选择器；showJumper：是否显示跳页输入框
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
  showPageSize = true,
  showJumper = true,
  showDensity = true,
  className = '',
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize + 1
  const end = Math.min(safePage * pageSize, total)
  // 密度切换器:全局共享,影响所有 DataTable 行高
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-xs text-muted-foreground ${className}`}>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          共 {total} 条，第 {start}-{end} 条
        </span>
        {showPageSize && onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span>每页</span>
            <CompactSelect
              size="sm"
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={String(opt)}>
                  {opt} 条
                </option>
              ))}
            </CompactSelect>
          </label>
        )}
        {showDensity && <DensitySwitcher />}
      </div>
      <div className="flex items-center gap-2">
        {showJumper && totalPages > 1 && (
          <label className="flex items-center gap-1.5">
            <span>跳至</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none tabular-nums focus:border-primary"
              defaultValue={safePage}
              key={safePage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const p = Number(e.target.value)
                  if (Number.isFinite(p) && p >= 1 && p <= totalPages && p !== safePage) {
                    onPageChange(p)
                  }
                }
              }}
            />
            <span>页</span>
          </label>
        )}
        <Button size="sm" variant="ghost" disabled={safePage <= 1} onClick={() => onPageChange(safePage - 1)}>
          上一页
        </Button>
        <span className="tabular-nums">{safePage} / {totalPages}</span>
        <Button size="sm" variant="ghost" disabled={safePage >= totalPages} onClick={() => onPageChange(safePage + 1)}>
          下一页
        </Button>
      </div>
    </div>
  )
}

// ===== CompactSelect：主题化下拉（Portal 自绘菜单，替代原生 select） =====
// 背景：原生 select 弹层由系统渲染——深色主题下弹浅色列表且错位，Windows Chromium
// 打开首帧还会黑闪（color-scheme 无法修复）。菜单 portal 到 body 并跟随主题令牌渲染。
// children 传 <option>（与原生一致）；size: sm | md | lg；variant: field | ghost。
export function CompactSelect({
  value,
  onChange,
  disabled,
  children,
  size = 'sm',
  variant = 'field',
  block = false,
  className = '',
  title,
  onClick,
  onMouseDown,
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 0 })
  const ghost = variant === 'ghost'
  const empty = value === '' || value == null

  // 解析 <option>（含 <optgroup> 分组：子项带 group 标签，渲染时插入分组标题）
  const options = useMemo(() => {
    const toOpt = (el, group = null) => ({
      value: el.props.value == null ? '' : String(el.props.value),
      label: el.props.children,
      disabled: Boolean(el.props.disabled),
      group,
    })
    return Children.toArray(children).flatMap((child) => {
      if (!child) return []
      if (child.type === 'option') return [toOpt(child)]
      if (child.type === 'optgroup') {
        return Children.toArray(child.props.children)
          .filter((c) => c && c.type === 'option')
          .map((c) => toOpt(c, child.props.label || null))
      }
      return []
    })
  }, [children])

  const selected = options.find((o) => o.value === String(value ?? ''))
  const label = selected?.label ?? '请选择'

  const chrome = ghost
    ? `border-transparent bg-transparent hover:border-border hover:bg-muted focus:border-border focus:bg-muted ${
        empty ? 'text-muted-foreground' : 'text-foreground'
      }`
    : variant === 'input'
      ? 'border-border bg-background text-foreground hover:border-primary/45 focus:border-primary'
      : 'border-border bg-secondary text-secondary-foreground hover:bg-accent focus:border-primary'

  // 尺寸令牌：min-w / max-w 仅在非 block 模式生效——block 时宽度完全由容器决定，
  // 若容器窄于 min-w（如封禁时长单位列 w-24 < lg 的 8rem），按钮会溢出遮挡右侧控件
  const sizeMinW = size === 'xs' ? 'min-w-[3.5rem]'
    : size === 'sm' ? 'min-w-[6.25rem] max-w-[8rem]'
    : size === 'lg' ? 'min-w-[8rem]'
    : 'min-w-[7.5rem]'
  const triggerSizeCls = (size === 'xs'
    ? 'h-7 py-0 pl-2 pr-6 text-xs'
    : size === 'sm'
      ? 'h-7 py-0 pl-2 pr-7 text-xs'
      : size === 'lg'
        ? 'h-9 py-0 pl-2.5 pr-9 text-sm'
        : 'h-8 py-0 pl-2.5 pr-8 text-sm'
  ) + (block ? '' : ` ${sizeMinW}`)
  const chevCls = size === 'xs'
    ? 'right-1 h-3 w-3'
    : size === 'sm'
      ? 'right-1.5 h-3 w-3'
      : size === 'lg'
        ? 'right-2.5 h-3.5 w-3.5'
        : 'right-2 h-3.5 w-3.5'

  const close = () => setOpen(false)

  const toggle = (e) => {
    e.stopPropagation()
    onClick?.(e)
    if (disabled) return
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const menuH = Math.min(options.length * 32 + 8, 280)
      let top = rect.bottom + 4
      if (top + menuH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - menuH - 4)
      }
      let left = rect.left
      const minWidth = Math.max(rect.width, size === 'xs' ? 72 : size === 'sm' ? 112 : size === 'lg' ? 148 : 132)
      if (left + minWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - minWidth - 8)
      }
      setPos({ top, left, minWidth })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-compact-select-menu]')) return
      close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    const onScroll = (e) => {
      // 菜单内部滚动（选项较多时可滚动浏览）不关闭，仅外部滚动时关闭
      if (e.target?.closest?.('[data-compact-select-menu]')) return
      close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const pick = (opt) => {
    if (opt.disabled) return
    close()
    if (String(opt.value) === String(value ?? '')) return
    onChange?.({ target: { value: opt.value }, stopPropagation() {} })
  }

  return (
    <div
      className={`relative inline-flex items-center ${block ? 'w-full' : ''} ${className}`}
      onMouseDown={onMouseDown}
    >
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        onClick={toggle}
        className={`inline-flex flex-1 items-center rounded-md border text-left outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${chrome} ${triggerSizeCls} ${block ? 'w-full' : ''}`}
      >
        <span className="block min-w-0 flex-1 truncate">{label}</span>
      </button>
      <ChevronDown
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 transition ${chevCls} ${open ? 'rotate-180' : ''} text-muted-foreground`}
      />
      {open && createPortal(
        <div
          data-compact-select-menu
          data-allow-scroll
          className="fixed z-[10000] max-h-[280px] overflow-y-auto overscroll-contain rounded-md border border-border bg-card py-1 text-foreground shadow-2xl"
          style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
          role="listbox"
        >
          {options.map((opt, i) => {
            const active = opt.value === String(value ?? '')
            const showGroup = opt.group && opt.group !== options[i - 1]?.group
            return (
            // key 必须唯一：同组内可能同时存在多个空值选项（占位 + 「全部」），
            // 仅用 group+value 会撞 key，导致 React 复用错 DOM 节点、
            // 提交阶段 insertBefore 锚点失效（NotFoundError）
              <Fragment key={`${opt.group || ''}-${opt.value || '__empty'}-${i}`}>
                {showGroup && (
                  <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium tracking-wide text-muted-foreground">{opt.group}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={opt.disabled}
                  onClick={() => pick(opt)}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition disabled:opacity-50 ${
                    opt.group ? 'pl-5' : ''
                  } ${
                    active
                      ? 'bg-primary/20 text-primary'
                      : 'text-foreground hover:bg-accent'
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                </button>
              </Fragment>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ===== ComboInput：可输入下拉（组合框，替代原生 datalist） =====
// 背景：原生 datalist 弹层由系统渲染——深色主题下样式失控且无法定制，与站内
// 主题化下拉（CompactSelect portal 菜单）视觉割裂。用于允许填写选项之外值的场景：
// 直接输入自由文本，或点击右侧箭头展开主题化候选列表快速选择（按输入值过滤）
export function ComboInput({ value, onChange, options = [], placeholder, disabled, error }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 0 })
  const rootRef = useRef(null)

  const kw = String(value ?? '').trim().toLowerCase()
  const filtered = useMemo(
    () => (kw ? options.filter((o) => String(o).toLowerCase().includes(kw)) : options),
    [options, kw],
  )

  const toggle = (e) => {
    e.stopPropagation()
    if (disabled) return
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect()
      const menuH = Math.min(filtered.length * 32 + 8, 280)
      let top = rect.bottom + 4
      if (top + menuH > window.innerHeight - 8) top = Math.max(8, rect.top - menuH - 4)
      let left = rect.left
      const minWidth = Math.max(rect.width, 148)
      if (left + minWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - minWidth - 8)
      setPos({ top, left, minWidth })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-combo-menu]')) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = (e) => {
      if (e.target?.closest?.('[data-combo-menu]')) return
      setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // 与 CompactSelect 的 onChange 事件签名一致（e.target.value），调用方零改动
  const pick = (o) => {
    setOpen(false)
    if (String(o) !== String(value ?? '')) onChange?.({ target: { value: String(o) }, stopPropagation: () => {} })
  }

  return (
    <div className="relative w-full" ref={rootRef}>
      <input
        className={`h-9 w-full rounded-md border border-input bg-background pr-10 pl-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary ${
          error ? '!border-destructive ring-1 !ring-destructive' : ''
        }`}
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange?.(e)}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={toggle}
        aria-label="展开候选选项"
        className="absolute right-0 top-0 flex h-9 w-10 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          data-combo-menu
          data-allow-scroll
          className="fixed z-[10000] max-h-[280px] overflow-y-auto overscroll-contain rounded-md border border-border bg-card py-1 text-foreground shadow-2xl"
          style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
          role="listbox"
        >
          {filtered.map((o) => (
            <button
              key={String(o)}
              type="button"
              role="option"
              aria-selected={String(o) === String(value ?? '')}
              onClick={() => pick(o)}
              className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition ${
                String(o) === String(value ?? '')
                  ? 'bg-primary/20 text-primary'
                  : 'text-foreground hover:bg-accent'
              }`}
            >
              <span className="truncate">{String(o)}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              {options.length === 0 ? '暂无可选项（被引用字段尚未填写）' : '无匹配选项，将保留输入值'}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ===== DatePicker：自绘弹层日期/日期时间/时间选择（替代原生 input） =====
// 背景：Windows Chromium 原生日历/时间弹层打开首帧黑闪，color-scheme 亦无法修复；
// 改为 portal 自绘弹层，跟随主题令牌渲染。onChange 与原生事件签名一致：
// type="date"（默认）value 'YYYY-MM-DD'；type="datetime" value 'YYYY-MM-DDTHH:mm'
//（与 datetime-local 格式一致）；type="time" value 'HH:mm'。清空时 e.target.value 为 ''。
const pad2 = (n) => String(n).padStart(2, '0')
const isoDate = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`
const parseDatePart = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null
}
const parseTimePart = (s) => {
  const m = /(?:^|T)(\d{2}):(\d{2})/.exec(String(s || ''))
  return m ? { h: +m[1], mi: +m[2] } : null
}
const DATE_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const TIME_HOURS = Array.from({ length: 24 }, (_, i) => i)
const TIME_MINUTES = Array.from({ length: 60 }, (_, i) => i)

export function DatePicker({
  value = '',
  onChange,
  type = 'date',
  placeholder,
  disabled = false,
  block = false,
  className = '',
  title,
  onClick,
  onMouseDown,
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const withTime = type === 'datetime'
  const timeOnly = type === 'time'
  const ph = placeholder ?? (timeOnly ? '选择时间' : withTime ? '选择日期时间' : '选择日期')
  const panelW = timeOnly ? 176 : 252
  const panelH = timeOnly ? 132 : withTime ? 396 : 336

  const datePart = timeOnly ? null : parseDatePart(value)
  const timePart = timeOnly || withTime ? parseTimePart(value) : null
  const selDateIso = datePart ? isoDate(datePart.y, datePart.m, datePart.d) : ''

  const [view, setView] = useState(() => {
    const p = parseDatePart(value)
    const n = new Date()
    return p ? { y: p.y, m: p.m } : { y: n.getFullYear(), m: n.getMonth() }
  })

  const close = () => setOpen(false)
  const fire = (v) => {
    if (v === value) return
    onChange?.({ target: { value: v }, stopPropagation() {} })
  }

  const toggle = (e) => {
    e.stopPropagation()
    onClick?.(e)
    if (disabled) return
    if (!open && btnRef.current) {
      // 打开时视图对齐已选日期（无则当前月）
      const p = parseDatePart(value)
      const n = new Date()
      setView(p ? { y: p.y, m: p.m } : { y: n.getFullYear(), m: n.getMonth() })
      const rect = btnRef.current.getBoundingClientRect()
      let top = rect.bottom + 4
      if (top + panelH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - panelH - 4)
      }
      let left = rect.left
      if (left + panelW > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - panelW - 8)
      }
      setPos({ top, left })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      // 面板及面板内嵌套的时间下拉菜单点击不关闭
      if (e.target.closest?.('[data-datepicker-panel]')) return
      if (e.target.closest?.('[data-compact-select-menu]')) return
      close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    const onScroll = (e) => {
      // 面板内部滚动（含嵌套菜单滚动）不关闭
      if (e.target?.closest?.('[data-datepicker-panel]')) return
      if (e.target?.closest?.('[data-compact-select-menu]')) return
      close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const todayIso = useMemo(() => {
    const n = new Date()
    return isoDate(n.getFullYear(), n.getMonth(), n.getDate())
  }, [])

  // 42 格月网格（周一为首，含上下月补位；末整行为下月时裁掉）
  const grid = useMemo(() => {
    const offset = (new Date(view.y, view.m, 1).getDay() + 6) % 7
    const cells = []
    for (let i = 0; i < 42; i++) {
      const dt = new Date(view.y, view.m, i - offset + 1)
      cells.push({
        iso: isoDate(dt.getFullYear(), dt.getMonth(), dt.getDate()),
        day: dt.getDate(),
        inMonth: dt.getMonth() === view.m,
      })
    }
    while (cells.length > 35 && cells.slice(-7).every((c) => !c.inMonth)) cells.length -= 7
    return cells
  }, [view.y, view.m])

  const shiftMonth = (delta) => {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  // 选日期：date 选完即关；datetime 更新日期部分并保持打开（继续选时间）
  const pickDate = (iso) => {
    if (withTime) {
      const t = timePart ? `${pad2(timePart.h)}:${pad2(timePart.mi)}` : '00:00'
      fire(`${iso}T${t}`)
    } else {
      close()
      fire(iso)
    }
  }

  // 设时间：time 直接写；datetime 与日期部分（无则今天）合成
  const setTime = (h, mi) => {
    if (timeOnly) {
      fire(`${pad2(h)}:${pad2(mi)}`)
      return
    }
    const d = datePart ? selDateIso : todayIso
    fire(`${d}T${pad2(h)}:${pad2(mi)}`)
  }

  // 快捷：今天（含当前时间）
  const pickNow = () => {
    const n = new Date()
    const t = `${pad2(n.getHours())}:${pad2(n.getMinutes())}`
    if (timeOnly) {
      fire(t)
      return
    }
    fire(`${todayIso}T${t}`)
    setView({ y: n.getFullYear(), m: n.getMonth() })
  }

  const clear = () => {
    close()
    if (value !== '') fire('')
  }

  const empty = value === '' || value == null
  const display = timeOnly ? value : withTime ? String(value).replace('T', ' ') : value
  const trigW = block ? 'w-full' : timeOnly ? 'w-[104px]' : withTime ? 'w-[176px]' : 'w-[136px]'
  const selHour = timePart ? timePart.h : 0
  const selMinute = timePart ? timePart.mi : 0

  // 时间行：datetime / time 模式下的时分选择（嵌套 CompactSelect，portal 菜单）
  const timeRow = (
    <div className={`flex items-center justify-center gap-1 pt-1.5 ${timeOnly ? '' : 'mt-1 border-t border-border'}`}>
      <CompactSelect
        size="xs"
        value={String(selHour)}
        onChange={(e) => setTime(Number(e.target.value), selMinute)}
      >
        {TIME_HOURS.map((h) => (
          <option key={h} value={String(h)}>{pad2(h)} 时</option>
        ))}
      </CompactSelect>
      <span className="text-xs text-muted-foreground">:</span>
      <CompactSelect
        size="xs"
        value={String(selMinute)}
        onChange={(e) => setTime(selHour, Number(e.target.value))}
      >
        {TIME_MINUTES.map((mi) => (
          <option key={mi} value={String(mi)}>{pad2(mi)} 分</option>
        ))}
      </CompactSelect>
    </div>
  )

  return (
    <div
      className={`relative inline-flex items-center ${block ? 'w-full' : ''} ${className}`}
      onMouseDown={onMouseDown}
    >
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title || ph}
        aria-label={title || ph}
        onClick={toggle}
        className={`inline-flex h-9 items-center justify-between gap-1 rounded-md border border-border bg-background px-2.5 text-left text-sm outline-none transition hover:border-primary/45 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 ${trigW}`}
      >
        <span className={`min-w-0 truncate tabular-nums ${empty ? 'text-muted-foreground' : 'text-foreground'}`}>
          {empty ? ph : display}
        </span>
        {timeOnly ? (
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && createPortal(
        <div
          data-datepicker-panel
          data-allow-scroll
          className="fixed z-[10000] rounded-md border border-border bg-card p-2 text-foreground shadow-2xl"
          style={{ top: pos.top, left: pos.left, width: panelW }}
        >
          {/* 月份导航（time 模式无日历） */}
          {!timeOnly && (
            <>
              <div className="mb-1 flex items-center justify-between">
                <button
                  type="button"
                  aria-label="上个月"
                  onClick={() => shiftMonth(-1)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <div className="text-xs font-medium text-foreground">
                  {view.y} 年 {view.m + 1} 月
                </div>
                <button
                  type="button"
                  aria-label="下个月"
                  onClick={() => shiftMonth(1)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* 星期行（周一为首） */}
              <div className="grid grid-cols-7">
                {DATE_WEEKDAYS.map((w) => (
                  <div key={w} className="flex h-6 items-center justify-center text-[11px] text-muted-foreground">
                    {w}
                  </div>
                ))}
              </div>
              {/* 日期网格 */}
              <div className="grid grid-cols-7">
                {grid.map((c) => {
                  const sel = c.iso === selDateIso
                  const isToday = c.iso === todayIso
                  return (
                    <button
                      key={c.iso}
                      type="button"
                      onClick={() => pickDate(c.iso)}
                      aria-selected={sel}
                      className={`mx-auto flex h-8 w-8 items-center justify-center rounded text-xs transition-colors ${
                        sel
                          ? 'bg-primary font-semibold text-primary-foreground'
                          : isToday
                            ? 'font-semibold text-primary hover:bg-accent'
                            : c.inMonth
                              ? 'text-foreground hover:bg-accent'
                              : 'text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {c.day}
                    </button>
                  )
                })}
              </div>
            </>
          )}
          {/* 时间行（datetime / time 模式） */}
          {(withTime || timeOnly) && timeRow}
          {/* 底部快捷操作 */}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1.5">
            <button
              type="button"
              onClick={() => ((withTime || timeOnly) ? pickNow() : pickDate(todayIso))}
              className="rounded px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
            >
              {timeOnly ? '现在' : '今天'}
            </button>
            <button
              type="button"
              onClick={clear}
              className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
            >
              清空
            </button>
            {(withTime || timeOnly) && (
              <button
                type="button"
                onClick={close}
                className="rounded px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
              >
                确定
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// ===== AutoGrowTextarea：自适应高度 + 自动换行的多行输入框（原生 textarea 的直接替代品） =====
// 内容增多时框体自动撑高、文本自动换行；超长无空格串（IP 列表 / URL / JSON）也能
// 在任意字符处断行。API 与原生 <textarea> 完全兼容：onChange 直传事件（e.target.value）、
// rows 作为最小行数、ref / style / maxLength / onKeyDown 等通过 rest 透传，
// 因此可以无脑把任意 <textarea> 替换为本组件获得自适应能力。
export function AutoGrowTextarea({
  value,
  onChange,
  onBlur,
  onFocus,
  placeholder,
  rows,
  minRows,
  maxRows = 24,
  className = '',
  invalid = false,
  mono = false,
  style,
  ...rest
}) {
  const ref = useRef(null)
  // rows 属性作为最小行数（兼容原生用法），minRows 可显式覆盖
  const minR = Math.max(minRows ?? rows ?? 1, 1)

  // 内容变化 / 首次挂载时重算高度：先 auto 还原再取 scrollHeight，
  // 行高与上下 padding 从计算样式读取，min/max 行数折算成像素上下限。
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const lineH = parseFloat(cs.lineHeight) || 20
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0
    const minH = minR * lineH + padY
    const maxH = maxRows * lineH + padY
    const h = Math.min(Math.max(ta.scrollHeight, minH), maxH)
    ta.style.height = `${h}px`
    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden'
  }, [value, minR, maxRows])

  // 行为关键样式用内联（优先级最高，外部 className/style 覆盖不了）：
  // resize:none 由 JS 接管高度；overflow-wrap:anywhere 让长 IP 列表/URL 等无空格长串也能换行
  return (
    <textarea
      ref={ref}
      value={value ?? ''}
      onChange={onChange}
      onBlur={onBlur}
      onFocus={onFocus}
      placeholder={placeholder}
      rows={rows || minR}
      className={`w-full rounded-md border bg-background px-2.5 py-1.5 text-sm leading-normal text-foreground outline-none transition placeholder:text-muted-foreground hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary ${
        mono ? 'font-mono' : ''
      } ${
        invalid ? 'border-destructive ring-1 ring-destructive' : 'border-input'
      } ${className}`}
      style={{ resize: 'none', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', ...style }}
      {...rest}
    />
  )
}

export default { Button, Card, PageContainer, PageHeader, Badge, StatusBadge, Skeleton, LoadingState, EmptyState, ErrorState, DataTable, Pagination, CompactSelect, ComboInput, DatePicker, AutoGrowTextarea }
