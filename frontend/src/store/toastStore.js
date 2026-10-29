// 全局 Toast 通知系统
// 统一替代各页面的 window.alert，提供 success / error / warning / info 四种语义。
//
// 用法：
//   import { toast } from '../store/toastStore'
//   toast.success('保存成功')
//   toast.error('删除失败：' + err.message)
//   toast.warning('该操作不可撤销')
//   toast.info('已刷新列表')
//
// 设计要点：
// - 基于 zustand，全局单例，任意组件 / 非组件均可调用
// - 自动消失（默认 success/info 3s，warning 4s，error 5s）
// - 支持手动关闭（点击关闭按钮）
// - 悬停暂停 / 移开恢复：阅读长内容（如通知卡片）时不会被倒计时打断
// - 最多同时显示 5 条，超出自动移除最早的
import { create } from 'zustand'

let _id = 0

const VARIANT_CONFIG = {
  success: { duration: 3000, icon: 'success' },
  error: { duration: 5000, icon: 'error' },
  warning: { duration: 4000, icon: 'warning' },
  info: { duration: 3000, icon: 'info' },
}

// 倒计时定时器（模块级，不进 state）：id -> { timer, startedAt, remaining }
const _timers = new Map()

function _clearTimer(id) {
  const t = _timers.get(id)
  if (t && t.timer) clearTimeout(t.timer)
  _timers.delete(id)
}

function _schedule(id, ms) {
  _clearTimer(id)
  _timers.set(id, {
    timer: setTimeout(() => useToastStore.getState().dismiss(id), ms),
    startedAt: Date.now(),
    remaining: ms,
  })
}

function _push(variant, message, options = {}) {
  const cfg = VARIANT_CONFIG[variant] || VARIANT_CONFIG.info
  const id = ++_id
  const item = {
    id,
    variant,
    message,
    title: options.title || '',
    duration: options.duration != null ? options.duration : cfg.duration,
    // 可点击跳转：点击弹窗主体或操作按钮触发
    onClick: typeof options.onClick === 'function' ? options.onClick : null,
    actionLabel: options.actionLabel || '',
    // 悬停暂停标记（进度条同步暂停）
    paused: false,
  }
  // 自动消失定时器
  if (item.duration > 0) _schedule(id, item.duration)
  // 入队，超出上限移除最早的（连同其定时器）
  useToastStore.setState((s) => {
    const next = [...s.items, item]
    while (next.length > 5) {
      _clearTimer(next[0].id)
      next.splice(0, 1)
    }
    return { items: next }
  })
  return id
}

export const useToastStore = create((set) => ({
  items: [],
  dismiss: (id) => {
    _clearTimer(id)
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id ? { ...it, leaving: true } : it
      ),
    }))
  },
  // 悬停暂停：清掉定时器并冻结剩余时长（重复调用幂等）
  pause: (id) =>
    set((s) => {
      const it = s.items.find((x) => x.id === id)
      if (!it || it.paused || it.leaving) return s
      const t = _timers.get(id)
      if (t) {
        clearTimeout(t.timer)
        _timers.set(id, {
          timer: null,
          startedAt: 0,
          remaining: Math.max(0, t.remaining - (Date.now() - t.startedAt)),
        })
      }
      return { items: s.items.map((x) => (x.id === id ? { ...x, paused: true } : x)) }
    }),
  // 移开恢复：按剩余时长重新倒计时（剩余不足 10% 时直接关闭，避免一闪而过）
  resume: (id) =>
    set((s) => {
      const it = s.items.find((x) => x.id === id)
      if (!it || !it.paused || it.leaving) return s
      const t = _timers.get(id)
      const remaining = t ? t.remaining : it.duration
      if (it.duration > 0 && remaining > it.duration * 0.1) {
        _schedule(id, remaining)
      } else if (it.duration > 0) {
        useToastStore.getState().dismiss(id)
      }
      return { items: s.items.map((x) => (x.id === id ? { ...x, paused: false } : x)) }
    }),
  // 真正移除（动画结束后调用）
  remove: (id) => {
    _clearTimer(id)
    set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
  },
  clear: () => {
    _timers.forEach((t) => t && t.timer && clearTimeout(t.timer))
    _timers.clear()
    set({ items: [] })
  },
}))

// 便捷 API：任意位置可调用
export const toast = {
  success: (msg, opts) => _push('success', msg, opts),
  error: (msg, opts) => _push('error', msg, opts),
  warning: (msg, opts) => _push('warning', msg, opts),
  info: (msg, opts) => _push('info', msg, opts),
  // 兜底：根据布尔值自动选 success / error
  result: (ok, successMsg, errorMsg) =>
    ok ? _push('success', successMsg) : _push('error', errorMsg),
}

export default toast
