// 文件接收：状态、业务类型与格式化工具
export const STATUS_META = {
  INIT: { label: '待上传', variant: 'neutral', spinning: false },
  UPLOADING: { label: '上传中', variant: 'info', spinning: true },
  MERGING: { label: '合并中', variant: 'info', spinning: true },
  VERIFYING: { label: '校验中', variant: 'warning', spinning: true },
  SUCCESS: { label: '接收成功', variant: 'success', spinning: false },
  FAILED: { label: '接收失败', variant: 'danger', spinning: false },
  EXPIRED: { label: '已过期', variant: 'neutral', spinning: false },
  CANCELED: { label: '已取消', variant: 'neutral', spinning: false },
}

export const ACTIVE_STATUSES = new Set(['INIT', 'UPLOADING', 'MERGING', 'VERIFYING'])

export const BIZ_TYPE_LABELS = {
  report: '报告',
}

export const FILE_ICON_COLOR = {
  pdf: 'text-rose-500',
  doc: 'text-blue-500',
  docx: 'text-blue-500',
  xls: 'text-emerald-500',
  xlsx: 'text-emerald-500',
  ppt: 'text-orange-500',
  pptx: 'text-orange-500',
  zip: 'text-amber-500',
  rar: 'text-amber-500',
  '7z': 'text-amber-500',
}

export function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—'
  const n = Number(bytes)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatDateInput(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function statusLabel(status) {
  return STATUS_META[status]?.label || status || '—'
}

export function bizTypeLabel(type) {
  return BIZ_TYPE_LABELS[type] || type || '—'
}
