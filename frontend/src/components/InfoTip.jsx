/**
 * InfoTip —— 圆圈感叹号 Tooltip 组件
 *
 * 将页面中的小字辅助说明替换为：一个圆圈中间感叹号的图标，
 * 鼠标 hover 时弹出 tooltip 显示说明文字，保持页面整洁。
 *
 * 使用 React Portal 渲染到 body 层，避免被父容器 overflow:hidden 裁剪。
 *
 * 用法：
 *   <InfoTip text="这是说明文字" />
 *   <InfoTip text="顶部弹出" placement="top" />
 *   <InfoTip text={<>支持 <code>JSX</code> 内容</>} />
 */
import { useState, useRef, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

// 共享：浮层定位 hook（InfoTip / HoverTip 复用）
// show: 是否显示；placement: top/bottom/left/right
// 返回 { triggerRef, tipRef, coords }
function useFloatTip({ show, placement }) {
  const [coords, setCoords] = useState({ top: 0, left: 0, arrow: 'top' })
  const triggerRef = useRef(null)
  const tipRef = useRef(null)

  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const tipWidth = tipRef.current?.offsetWidth || 240
    const tipHeight = tipRef.current?.offsetHeight || 60
    const gap = 8
    let top, left, arrow

    switch (placement) {
      case 'bottom':
        top = rect.bottom + gap
        left = rect.left + rect.width / 2 - tipWidth / 2
        arrow = 'top'
        break
      case 'left':
        top = rect.top + rect.height / 2 - tipHeight / 2
        left = rect.left - tipWidth - gap
        arrow = 'right'
        break
      case 'right':
        top = rect.top + rect.height / 2 - tipHeight / 2
        left = rect.right + gap
        arrow = 'left'
        break
      default: // top
        top = rect.top - tipHeight - gap
        left = rect.left + rect.width / 2 - tipWidth / 2
        arrow = 'bottom'
    }

    // 边界修正：防止超出视口
    if (left < 8) left = 8
    if (left + tipWidth > window.innerWidth - 8) left = window.innerWidth - tipWidth - 8
    if (top < 8) {
      // 顶部放不下，自动切换到下方
      top = rect.bottom + gap
      arrow = 'top'
    }

    setCoords({ top, left, arrow })
  }, [placement])

  useLayoutEffect(() => {
    if (show) {
      computePosition()
      window.addEventListener('scroll', computePosition, true)
      window.addEventListener('resize', computePosition)
      return () => {
        window.removeEventListener('scroll', computePosition, true)
        window.removeEventListener('resize', computePosition)
      }
    }
  }, [show, computePosition])

  return { triggerRef, tipRef, coords }
}

const ARROW_CLS = {
  top: 'top-0 left-1/2 -translate-x-1/2 -translate-y-full border-b-gray-700',
  bottom: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-full border-t-gray-700',
  left: 'left-0 top-1/2 -translate-y-1/2 -translate-x-full border-r-gray-700',
  right: 'right-0 top-1/2 -translate-y-1/2 translate-x-full border-l-gray-700',
}

function InfoTip({ text, placement = 'top', className = '' }) {
  const [show, setShow] = useState(false)
  const { triggerRef, tipRef, coords } = useFloatTip({ show, placement })

  // 空内容时不渲染，避免无用图标
  if (!text) return null

  return (
    <span
      className={`relative inline-flex shrink-0 items-center ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {/* 圆圈感叹号图标 */}
      <span
        ref={triggerRef}
        className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-border text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        tabIndex={0}
        role="img"
        aria-label="提示"
      >
        !
      </span>

      {/* Tooltip 气泡：通过 Portal 渲染到 body，避免被父容器 overflow 裁剪 */}
      {show && createPortal(
        <span
          ref={tipRef}
          className="pointer-events-none fixed z-[9999] w-max max-w-xs whitespace-normal rounded-lg border border-border bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-xl"
          style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
        >
          {text}
          {/* 小箭头 */}
          <span
            className={`absolute h-0 w-0 border-4 border-transparent ${ARROW_CLS[coords.arrow] || ARROW_CLS.top}`}
          />
        </span>,
        document.body
      )}
    </span>
  )
}

/**
 * HoverTip —— 通用悬停浮层组件
 *
 * 包裹任意 children，hover 时显示 text 浮层（即时显示，比原生 title 更快更明显）。
 * 通过 Portal 渲染到 body，避免被父容器 overflow:hidden 裁剪或被表格/卡片遮挡。
 *
 * 用法：
 *   <HoverTip text="被引用：智能体A、智能体B">
 *     <span>3 个</span>
 *   </HoverTip>
 */
export function HoverTip({ text, children, placement = 'top' }) {
  const [show, setShow] = useState(false)
  const { triggerRef, tipRef, coords } = useFloatTip({ show, placement })

  // 无内容直接渲染 children
  if (!text) return children

  return (
    <span
      className="inline-flex"
      ref={triggerRef}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && createPortal(
        <span
          ref={tipRef}
          className="pointer-events-none fixed z-[9999] w-max max-w-sm whitespace-normal rounded-lg border border-border bg-secondary px-3 py-2 text-xs leading-relaxed text-foreground shadow-xl"
          style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
        >
          {text}
          <span
            className={`absolute h-0 w-0 border-4 border-transparent ${ARROW_CLS[coords.arrow] || ARROW_CLS.top}`}
          />
        </span>,
        document.body
      )}
    </span>
  )
}

export default InfoTip
