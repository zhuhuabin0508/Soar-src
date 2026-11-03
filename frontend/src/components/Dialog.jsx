// 通用模态弹窗容器：覆盖整屏，居中显示，语义令牌适配明暗主题。
//
// 增强（相比旧版）：
// - 修复硬编码 text-foreground（亮色主题下白底白字）
// - ESC 键关闭（open 期间监听）
// - 焦点陷阱：打开后焦点进入弹窗，Tab/Shift+Tab 在弹窗内循环；关闭后还原焦点
// - 背景滚动锁：open 期间禁止背后列表滚动（含 AppShell overflow-auto）
// - 进场动画：遮罩淡入 + 弹窗 scale+fade（尊重 prefers-reduced-motion）
// - size 枚举：sm/md/lg/xl/full（与 maxWidth 字符串向后兼容：size 优先，否则 maxWidth，再否则默认 max-w-2xl）
// - closeOnOverlayClick：是否允许点击遮罩关闭（默认 false，防误操作）
//
// 用法：
//   <Modal open size="lg" title="..." onClose={...}>...</Modal>
//   <Modal open maxWidth="max-w-3xl" title="..." onClose={...}>...</Modal>
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { inputCls } from './property/FormControls'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'
import { AutoGrowTextarea } from './ui'

// size 预设映射到 Tailwind max-width 类
const SIZE_MAP = {
  sm: 'max-w-md',    // 28rem
  md: 'max-w-2xl',   // 42rem（默认）
  lg: 'max-w-4xl',   // 56rem
  xl: 'max-w-6xl',   // 72rem
  full: 'max-w-[95vw]',
}

// 查询弹窗内所有可聚焦元素（按 Tab 顺序）
function queryFocusable(root) {
  if (!root) return []
  const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll(sel)).filter((el) => el.offsetParent !== null)
}

// 通用模态：居中显示
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size,
  maxWidth,
  closeOnOverlayClick = false,
}) {
  const dialogRef = useRef(null)

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useLockBackgroundScroll(open)

  // 焦点陷阱：进入时聚焦弹窗，Tab 循环，关闭时还原
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previouslyFocused = document.activeElement
    // 聚焦到弹窗内第一个可聚焦元素
    const focusables = queryFocusable(dialog)
    if (focusables.length > 0) {
      // 延迟一帧，确保 DOM 已挂载动画可触发
      requestAnimationFrame(() => focusables[0].focus())
    } else {
      dialog.setAttribute('tabindex', '-1')
      requestAnimationFrame(() => dialog.focus())
    }
    // Tab/Shift+Tab 循环
    const handler = (e) => {
      if (e.key !== 'Tab') return
      const list = queryFocusable(dialog)
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus() } catch { /* ignore */ }
      }
    }
  }, [open])

  if (!open) return null

  const widthCls = size ? (SIZE_MAP[size] || SIZE_MAP.md) : (maxWidth || 'max-w-2xl')

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] modal-overlay-enter"
      onClick={closeOnOverlayClick ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={`relative z-modal flex max-h-[90vh] w-full ${widthCls} flex-col rounded-lg border border-border bg-card shadow-2xl modal-enter transition-[max-width] duration-300 ease-out`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div data-allow-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 flex flex-col gap-2">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// 右侧抽屉 Drawer：从右侧滑入，全屏高度，内容区可滚动
// 适用于内容较多、需要长期编辑的场景（如权限矩阵、复杂表单）
// width: 抽屉宽度 class，如 'w-[480px]' / 'w-[640px]' / 'max-w-2xl w-full'
// 增强：ESC 关闭 + 焦点陷阱 + 滚动锁 + 进场动画 + closeOnOverlayClick
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'w-[560px]',
  closeOnOverlayClick = false,
}) {
  const drawerRef = useRef(null)

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useLockBackgroundScroll(open)

  // 焦点陷阱
  useEffect(() => {
    if (!open) return
    const drawer = drawerRef.current
    if (!drawer) return
    const previouslyFocused = document.activeElement
    const focusables = queryFocusable(drawer)
    if (focusables.length > 0) {
      requestAnimationFrame(() => focusables[0].focus())
    } else {
      drawer.setAttribute('tabindex', '-1')
      requestAnimationFrame(() => drawer.focus())
    }
    const handler = (e) => {
      if (e.key !== 'Tab') return
      const list = queryFocusable(drawer)
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus() } catch { /* ignore */ }
      }
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-drawer flex justify-end bg-black/60 backdrop-blur-[2px] modal-overlay-enter"
      onClick={closeOnOverlayClick ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={`relative z-drawer flex h-full ${width} max-w-[95vw] flex-col border-l border-border bg-card shadow-2xl drawer-enter`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏（sticky） */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* 内容区：可滚动 */}
        <div data-allow-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {/* 底部操作栏（sticky） */}
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-card px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// 简易 JSON 输入弹窗：用于「试运行」时让用户填入示例输入
export function JsonInputDialog({
  open,
  title,
  defaultValue,
  onClose,
  onSubmit,
  submitText = '运行',
}) {
  const [text, setText] = useState(
    defaultValue ||
      '{\n  "alert_data": {\n    "src_ip": "203.0.113.100",\n    "alert_type": "brute_force"\n  }\n}'
  )
  const [parseErr, setParseErr] = useState('')

  // 弹窗每次打开时重置为最新 defaultValue
  useEffect(() => {
    if (open && defaultValue !== undefined) {
      setText(defaultValue)
      setParseErr('')
    }
  }, [open, defaultValue])

  if (!open) return null

  const handleSubmit = () => {
    let parsed
    try {
      parsed = text.trim() ? JSON.parse(text) : {}
      setParseErr('')
    } catch (err) {
      setParseErr(`JSON 解析失败：${err.message}`)
      return
    }
    onSubmit(parsed)
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary btn-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="btn-primary btn-sm"
          >
            {submitText}
          </button>
        </>
      }
    >
      <AutoGrowTextarea
        className={`${inputCls} resize-y font-mono`}
        rows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {parseErr && <p className="text-xs text-destructive">{parseErr}</p>}
    </Modal>
  )
}

export default Modal
