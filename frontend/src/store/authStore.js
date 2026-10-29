// 鉴权状态管理：token 与用户信息持久化到 localStorage
// 含令牌刷新定时器（在 token 过期前自动刷新，避免用户频繁重新登录）
import { create } from 'zustand'
import { authApi } from '../api/auth'
import { purgeChatCaches } from '../utils/chatStorage'

const TOKEN_KEY = 'soar_token'
const USER_KEY = 'soar_user'

// 令牌刷新定时器（模块级，避免多实例）
let refreshTimer = null
// 刷新提前量：在 token 过期前 5 分钟刷新（单位毫秒）
const REFRESH_LEAD_MS = 5 * 60 * 1000
// JWT 默认有效期（分钟），与后端 JWT_EXPIRE_MINUTES 对齐
const DEFAULT_JWT_EXPIRE_MINUTES = 1440

/**
 * 从 localStorage 恢复初始状态
 */
function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null
  } catch {
    return null
  }
}

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * 计算令牌剩余有效期（秒），从 JWT payload 的 exp 字段解析。
 * 若无法解析则返回默认值。
 */
function getTokenTtlSeconds(token) {
  if (!token) return DEFAULT_JWT_EXPIRE_MINUTES * 60
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return DEFAULT_JWT_EXPIRE_MINUTES * 60
    const payload = JSON.parse(atob(parts[1]))
    if (!payload.exp) return DEFAULT_JWT_EXPIRE_MINUTES * 60
    return Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
  } catch {
    return DEFAULT_JWT_EXPIRE_MINUTES * 60
  }
}

/**
 * 设置令牌自动刷新定时器（在 token 过期前 5 分钟调用 /auth/refresh）。
 */
function scheduleTokenRefresh(token) {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  const ttl = getTokenTtlSeconds(token)
  // 在过期前 5 分钟刷新；若剩余时间已不足 5 分钟，则 30 秒后刷新
  const delayMs = Math.max(30 * 1000, (ttl - 300)) * 1000
  refreshTimer = setTimeout(async () => {
    try {
      const res = await authApi.refresh()
      if (res.access_token) {
        useAuthStore.getState().setAuth(res.access_token, res.user)
        // 递归设置下一次刷新
        scheduleTokenRefresh(res.access_token)
      }
    } catch {
      // 刷新失败：清除凭证，跳转登录页
      useAuthStore.getState().clearAuth()
    }
  }, delayMs)
}

export const useAuthStore = create((set, get) => ({
  token: loadToken(),
  user: loadUser(),

  // 是否已登录
  isAuthenticated: () => !!get().token,

  // 登录成功后保存凭证 + 启动自动刷新定时器
  setAuth: (token, user) => {
    try {
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } catch {
      // localStorage 不可用时仅内存保存
    }
    set({ token, user })
    // 启动令牌自动刷新
    scheduleTokenRefresh(token)
  },

  // 仅清除凭证（不调用后端登出，用于 token 过期/刷新失败等场景）
  clearAuth: () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      // 对话缓存包含登录用户的私有对话内容：凭证清除时一并清空，
      // 防止同一浏览器上的后续使用者（访客）看到残留的对话记录。
      // 缓存仅是展示层加速，下次登录后由服务端完整重建。
      purgeChatCaches(localStorage)
    } catch {
      // ignore
    }
    set({ token: null, user: null })
  },

  // 登出：调用后端登出接口（拉黑 token）+ 清除本地凭证
  logout: async () => {
    try {
      await authApi.logout()
    } catch {
      // 后端登出失败不阻塞前端清除（token 可能已过期）
    }
    get().clearAuth()
  },

  // 刷新当前用户信息（用于权限变更后同步前端）
  refreshUser: async () => {
    try {
      const user = await authApi.me()
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(user))
      } catch {
        // ignore
      }
      set({ user })
      return user
    } catch {
      return null
    }
  },
}))

// 页面加载时若有 token，启动自动刷新定时器
if (useAuthStore.getState().token) {
  scheduleTokenRefresh(useAuthStore.getState().token)
}

export default useAuthStore
