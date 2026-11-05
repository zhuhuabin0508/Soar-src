// 命令式确认弹窗：替代 window.confirm，统一交互质感。
//
// 两种用法：
//
// 1. 命令式（推荐，替换 window.confirm 最省事）：
//    import { confirm } from '../components/ConfirmDialog'
//    const ok = await confirm({ title: '确认删除', message: '该操作不可撤销', variant: 'danger' })
//    if (!ok) return
//
// 2. 声明式（已有页面可继续用）：
//    <ConfirmDialog open={...} title={...} message={...} onConfirm={...} onCancel={...} />
//
// 命令式实现：内部用全局 store 管理一份「当前确认请求」，
// confirm() 返回 Promise，由 ConfirmDialogHost 解析。
import { useState, useEffect } from 'react'
import { Modal } from './Dialog'
import { AlertTriangle, Info, HelpCircle } from 'lucide-react'

// 不同变体对应的确认按钮样式
const VARIANT_BTN = {
  danger: 'btn-danger',
  warning: 'btn-primary',
  info: 'btn-primary',
}

// 不同变体对应的图标（带语义色圆形底衬，与全局设计语言一致）
const VARIANT_ICON = {
  danger: (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/15">
      <AlertTriangle className="h-5 w-5 text-destructive" />
    </span>
  ),
  warning: (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/15">
      <AlertTriangle className="h-5 w-5 text-warning" />
    </span>
  ),
  info: (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
      <Info className="h-5 w-5 text-primary" />
    </span>
  ),
}

// 声明式组件（保留向后兼容）
export function ConfirmDialog({
  open,
  title = '确认操作',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  variant = 'danger',
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      maxWidth="max-w-md"
      footer={
        <>
          <button type="button" onClick={onCancel} className="btn-secondary btn-sm">
            {cancelText}
          </button>
          <button type="button" onClick={onConfirm} className={`${VARIANT_BTN[variant] || 'btn-primary'} btn-sm`}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3 py-2">
        <span className="shrink-0">{VARIANT_ICON[variant] || <Info className="h-5 w-5 text-primary" />}</span>
        {/* message 支持字符串或 ReactNode（结构化确认摘要） */}
        {typeof message === 'string' ? (
          <p className="flex-1 text-sm text-muted-foreground">{message}</p>
        ) : (
          <div className="min-w-0 flex-1 text-sm text-muted-foreground">{message}</div>
        )}
      </div>
    </Modal>
  )
}

// ============ 命令式 confirm() ============
// 全局状态：当前挂起的确认请求（同一时间只显示一个）
let _resolver = null
const _listeners = new Set()

function _setState(updater) {
  _state = updater(_state)
  _listeners.forEach((fn) => fn())
}

let _state = { open: false, title: '', message: '', confirmText: '确定', cancelText: '取消', variant: 'danger' }

/**
 * 命令式确认弹窗，返回 Promise<boolean>。
 * @param {object} opts
 * @param {string} [opts.title='确认操作']
 * @param {string} [opts.message='']
 * @param {string} [opts.confirmText='确定']
 * @param {string} [opts.cancelText='取消']
 * @param {'danger'|'warning'|'info'} [opts.variant='danger']
 * @returns {Promise<boolean>} true=确认，false=取消
 */
export function confirm(opts = {}) {
  return new Promise((resolve) => {
    _resolver = resolve
    _setState(() => ({
      open: true,
      title: opts.title || '确认操作',
      message: opts.message || '',
      confirmText: opts.confirmText || '确定',
      cancelText: opts.cancelText || '取消',
      variant: opts.variant || 'danger',
    }))
  })
}

function _resolve(value) {
  if (_resolver) {
    _resolver(value)
    _resolver = null
  }
  _setState((s) => ({ ...s, open: false }))
}

// 全局 Host 组件：在 App 根挂载一次，监听 _state 变化
export function ConfirmDialogHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    _listeners.add(fn)
    return () => _listeners.delete(fn)
  }, [])
  const s = _state
  return (
    <ConfirmDialog
      open={s.open}
      title={s.title}
      message={s.message}
      confirmText={s.confirmText}
      cancelText={s.cancelText}
      variant={s.variant}
      onConfirm={() => _resolve(true)}
      onCancel={() => _resolve(false)}
    />
  )
}

export default ConfirmDialog
