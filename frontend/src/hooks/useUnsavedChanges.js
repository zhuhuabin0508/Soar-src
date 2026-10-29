import { createElement as h, useCallback, useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import { AlertTriangle } from 'lucide-react'

/**
 * 监听未保存更改，在两种离开场景下提示用户：
 *
 * 1. **关闭/刷新浏览器**：通过 ``beforeunload`` 事件触发浏览器原生提示。
 * 2. **路由内导航**（点击侧边栏切到其他页面）：通过 react-router v7 的
 *    ``useBlocker`` 拦截，弹出确认弹窗。用户选"留在页面"则取消跳转，
 *    选"放弃修改并离开"则放行。
 *
 * 弹窗通过独立的 ``createRoot`` 挂载到 ``document.body``，调用方**无需**
 * 渲染返回值，保持 ``useUnsavedChanges(dirty)`` 调用即可。这样编辑页面
 * 的现有代码不需要任何改动。
 *
 * 3. **Ctrl+S / Cmd+S**：dirty 时拦截浏览器默认保存对话框，转而调用
 *    可选的 onSave 回调（由页面提供保存动作）；未传 onSave 时仅拦截。
 *
 * Args:
 *     dirty: 当前表单是否有未保存修改（布尔值）。
 *     options.onSave: Ctrl+S 时的保存回调（可选）。
 */
export function useUnsavedChanges(dirty, { onSave } = {}) {
  // dirtyRef 始终持有最新的 dirty 值，供 blocker 回调读取。
  // 关键：保存时调用返回的 bypass() 会同步把 dirtyRef.current 置为 false，
  // 这样即便 setDirty(false) 的状态更新还未生效，navigate 也不会被拦截。
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // Ctrl+S：dirty 时触发保存回调。回调经 ref 转发，避免依赖变化导致监听重建。
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    const onKeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && dirtyRef.current) {
        e.preventDefault()
        onSaveRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [])

  // 1. beforeunload：关闭/刷新浏览器（浏览器原生提示，文案不可自定义）
  const handler = useCallback((e) => {
    if (dirtyRef.current) {
      e.preventDefault()
      e.returnValue = ''
    }
  }, [])

  useEffect(() => {
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [handler])

  // 2. 路由内导航拦截：切换页面时阻塞并弹窗确认
  //    仅当 dirty 且目标路径与当前不同时阻塞，避免同页 hash/query 变化误触发。
  //    回调读取 dirtyRef.current（而非闭包捕获的 dirty），保证拿到最新值，
  //    且 useCallback 依赖为空，避免 dirty 变化时重建 blocker 带来的副作用。
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) => {
        return !!dirtyRef.current && currentLocation.pathname !== nextLocation.pathname
      },
      []
    )
  )

  // 3. blocked 时用独立 Root 渲染确认弹窗（调用方无需渲染返回值）
  //    用独立 createRoot 而非 createPortal，这样 hook 不返回任何 JSX，
  //    各编辑页面现有的 `useUnsavedChanges(dirty)` 调用无需任何改动。
  const containerRef = useRef(null)
  const rootRef = useRef(null)
  const blocked = blocker.state === 'blocked'

  useEffect(() => {
    if (blocked) {
      // 首次阻塞时创建挂载容器
      if (!containerRef.current) {
        const el = document.createElement('div')
        el.dataset.unsavedGuard = '1'
        document.body.appendChild(el)
        containerRef.current = el
        rootRef.current = createRoot(el)
      }
      // 每次阻塞时重新渲染（确保 blocker 回调是最新的）
      rootRef.current?.render(
        h(ConfirmLeaveDialog, {
          onStay: () => blocker.reset?.(),
          onLeave: () => blocker.proceed?.(),
        })
      )
    } else {
      // 解除阻塞时卸载弹窗
      if (rootRef.current) {
        rootRef.current.unmount()
        rootRef.current = null
      }
      if (containerRef.current) {
        containerRef.current.remove()
        containerRef.current = null
      }
    }
  }, [blocked, blocker])

  // 组件卸载时兜底清理弹窗：
  // 调用 blocker.proceed() 后，React Router 可能同步导航导致组件立即卸载，
  // 上面的 effect 来不及跑 else 分支，弹窗会残留在 document.body 上关不掉。
  // 此处仅依赖 []（仅卸载时执行），确保任何卸载场景都清除弹窗。
  useEffect(() => {
    return () => {
      if (rootRef.current) {
        rootRef.current.unmount()
        rootRef.current = null
      }
      if (containerRef.current) {
        containerRef.current.remove()
        containerRef.current = null
      }
    }
  }, [])

  // 保存时调用：同步放行下一次导航。
  // 解决「点保存也弹未保存修改弹窗」的问题——setDirty(false) 是异步状态更新，
  // 紧接着的 navigate() 会在状态生效前触发 blocker，此时 dirty 仍为 true。
  // bypass() 同步把 dirtyRef.current 置 false，blocker 回调读到的就是 false，不再拦截。
  // 用法：const bypassGuard = useUnsavedChanges(dirty); 保存成功后 bypassGuard(); navigate(...)
  const bypass = useCallback(() => {
    dirtyRef.current = false
  }, [])

  return bypass
}

// 未保存修改确认弹窗（用 createElement 渲染，避免 .js 文件中的 JSX 解析问题）
function ConfirmLeaveDialog({ onStay, onLeave }) {
  return h(
    'div',
    { className: 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60' },
    h(
      'div',
      { className: 'w-96 rounded-lg border border-border bg-card p-5 shadow-2xl' },
      h(
        'div',
        { className: 'mb-2 flex items-center gap-2 text-base font-semibold text-foreground' },
        h(AlertTriangle, { className: 'h-4 w-4 text-warning' }),
        h('span', null, '未保存的修改')
      ),
      h(
        'div',
        { className: 'mb-4 text-sm leading-relaxed text-muted-foreground' },
        '当前页面有未保存的修改，离开后将丢失这些更改。确定要离开吗？'
      ),
      h(
        'div',
        { className: 'flex justify-end gap-2' },
        h(
          'button',
          {
            type: 'button',
            onClick: onStay,
            className:
              'rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-secondary',
          },
          '留在页面'
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onLeave,
            className:
              'rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition hover:opacity-90',
          },
          '放弃修改并离开'
        )
      )
    )
  )
}
