import './csp-style-shim'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'reactflow/dist/style.css'
import './index.css'

// ============ React 树崩溃自愈（组件树外全局兜底，勿移入组件）============
// 背景：/ticket-monitor 大屏曾报
//   NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before
//   which the new node is to be inserted is not a child of this node.
// 该异常发生在 React commit 阶段（insertOrAppendPlacementNode），ErrorBoundary 无法
// 捕获，React 会卸载整棵树导致白屏。已用 jsdom + 真实大屏组件复现确认：根因是外部
// DOM 突变（浏览器翻译插件 / 扩展移除或移动 React 管辖的节点），页面自身渲染无缺陷。
// 之前挂在页面组件 useEffect 里的自愈监听无效：崩溃卸载时 effect cleanup 先移除了
// 监听器，错误冒泡到 window 时监听已不存在。因此必须在组件树外（模块级）注册。
//
// 恢复策略（jsdom 验证：连续 5 次外部 DOM 破坏全部自动恢复，数据轮询不中断）：
//   1. 原地恢复：unmount 旧 root → 清空容器 → 新建 root 重渲（不整页刷新，秒级恢复，
//      大屏状态由 URL 参数 + localStorage 复原）；
//   2. 防抖：React 崩溃会连发多个 error 事件，同一串只触发一次恢复；
//   3. 防风暴：10 分钟窗口内原地恢复超 5 次（环境持续破坏 DOM）退化为整页 reload，
//      reload 超 3 次仍崩溃则放弃自愈，避免刷新风暴。
const CRASH_STATE_KEY = 'app_crash_recovery_state'
const CRASH_WINDOW_MS = 10 * 60 * 1000
const MAX_REBUILDS = 5
const MAX_RELOADS = 3

function readCrashState() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CRASH_STATE_KEY) || '{}')
    const now = Date.now()
    return {
      rebuilds: Array.isArray(raw.rebuilds) ? raw.rebuilds.filter((t) => now - t < CRASH_WINDOW_MS) : [],
      reloads: Array.isArray(raw.reloads) ? raw.reloads.filter((t) => now - t < CRASH_WINDOW_MS) : [],
    }
  } catch {
    return { rebuilds: [], reloads: [] }
  }
}

function writeCrashState(state) {
  try { window.localStorage.setItem(CRASH_STATE_KEY, JSON.stringify(state)) } catch { /* 隐私模式等忽略 */ }
}

function isDomMismatchCrash(e) {
  const msg = String(e?.message || '')
  const name = String(e?.error?.name || '')
  // 浏览器：Failed to execute 'insertBefore'/'removeChild' on 'Node': ...
  // 兼容 jsdom 消息：The node to be removed is not a child of this node.
  return /insertBefore|removeChild|NotFoundError|not a child of this node/i.test(msg) || name === 'NotFoundError'
}

const container = document.getElementById('root')
let root = ReactDOM.createRoot(container)
root.render(<App />)

let recovering = false
window.addEventListener('error', (e) => {
  if (!isDomMismatchCrash(e) || recovering) return
  recovering = true
  // eslint-disable-next-line no-console
  console.error('[CrashRecovery] 检测到 React DOM 失配崩溃，尝试自动恢复：', String(e?.message || e?.error || ''))
  const state = readCrashState()
  if (state.reloads.length >= MAX_RELOADS) {
    // 整页重载后仍持续崩溃：放弃自愈，等待人工介入
    setTimeout(() => { recovering = false }, 60 * 1000)
    return
  }
  if (state.rebuilds.length >= MAX_REBUILDS) {
    // 原地恢复频次过高（环境持续破坏 DOM），退化为整页 reload（URL 状态保留，恢复后自动复原）
    state.reloads.push(Date.now())
    writeCrashState(state)
    setTimeout(() => window.location.reload(), 500)
    return
  }
  state.rebuilds.push(Date.now())
  writeCrashState(state)
  setTimeout(() => {
    try { root.unmount() } catch { /* 树已损坏时 unmount 可能抛错，忽略 */ }
    try { container.replaceChildren() } catch { /* ignore */ }
    root = ReactDOM.createRoot(container)
    root.render(<App />)
    // 给新树一个提交周期后解除防抖，允许后续崩溃再次恢复
    setTimeout(() => { recovering = false }, 2000)
  }, 100)
})
