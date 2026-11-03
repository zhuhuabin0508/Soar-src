// 主题状态管理：light / dark / system 三态
//
// 设计：
// - theme: 用户偏好（'light' | 'dark' | 'system'），持久化到 localStorage
// - resolvedTheme: 实际应用的值（'light' | 'dark'），由 theme + 系统偏好计算
// - 应用方式：在 <html> 上添加/移除 class="dark"，对应 index.css 的 :root/.dark
// - 监听系统 prefers-color-scheme 变化（仅 theme=system 时跟随）
// - 防 FOUC：index.html 内联一段同步脚本在 React 渲染前应用 class
//
// 用法：
//   import { useThemeStore, toggleTheme, setTheme } from '../store/themeStore'
//   const { theme, resolvedTheme } = useThemeStore()
//   setTheme('dark')
import { create } from 'zustand'

const STORAGE_KEY = 'soar_theme'
const VALID = ['light', 'dark', 'system']

// 读取系统偏好
function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false // 检测失败时回退亮色（与平台默认亮色一致）
  }
}

// 计算实际值
function resolve(theme) {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

// 应用到 <html>
function applyToHtml(resolved) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  root.style.colorScheme = resolved
}

// 初始化：从 localStorage 读
function initTheme() {
  // 默认 light：未设置过偏好的用户（含新用户/清缓存）首屏进入亮色主题；
  // 曾手动切换过主题的用户仍按其 localStorage 偏好还原
  let theme = 'light'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && VALID.includes(saved)) theme = saved
  } catch { /* ignore */ }
  return { theme, resolved: resolve(theme) }
}

const initial = initTheme()
// 启动时立即应用，避免 FOUC（虽然 index.html 已做一次，这里再做一次保证一致性）
applyToHtml(initial.resolved)

export const useThemeStore = create((set, get) => ({
  theme: initial.theme,
  resolved: initial.resolved,

  // 设置主题偏好
  setTheme: (theme) => {
    if (!VALID.includes(theme)) return
    const resolved = resolve(theme)
    applyToHtml(resolved)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
    set({ theme, resolved })
  },

  // 在 light / dark / system 之间循环（用于一键切换）
  cycleTheme: () => {
    const cur = get().theme
    const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'system' : 'light'
    get().setTheme(next)
  },
}))

// 全局监听系统主题变化（仅 theme=system 时跟随）
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const { theme, setTheme } = useThemeStore.getState()
    if (theme === 'system') {
      // 重新应用（保持 system 偏好，只更新 resolved）
      const resolved = resolve('system')
      applyToHtml(resolved)
      useThemeStore.setState({ resolved })
    }
  }
  // addEventListener 在新浏览器可用，旧浏览器回退 addListener
  if (mq.addEventListener) mq.addEventListener('change', handler)
  else if (mq.addListener) mq.addListener(handler)
}

// 便捷 API
export const setTheme = (t) => useThemeStore.getState().setTheme(t)
export const cycleTheme = () => useThemeStore.getState().cycleTheme()

export default useThemeStore
