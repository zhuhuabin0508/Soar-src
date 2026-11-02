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
// 捕获，React 会卸载整棵树导致白屏。jsdom + 真实大屏组件复现确认：页面自身渲染在
// 静态数据/高频轮询/随机交互下零错误，根因高度指向外部 DOM 突变（浏览器翻译插件/
// 扩展移除或移动 React 管辖节点）。此前挂在页面组件 useEffect 里的自愈监听无效：
// 崩溃卸载时 effect cleanup 先移除了监听器，错误冒泡到 window 时监听已不存在，
// 因此必须在组件树外（模块级）注册。
//
// 恢复策略（jsdom 验证：连续 5 次外部 DOM 破坏全部自动恢复，数据轮询不中断）：
//   1. 原地恢复：unmount 旧 root → 清空容器 → 新建 root 重渲（不整页刷新，秒级恢复，
//      大屏状态由 URL 参数 + localStorage 复原）；
//   2. 防抖：React 崩溃会连发多个 error 事件，同一串只触发一次恢复；
//   3. 防风暴：10 分钟窗口内原地恢复超 5 次（环境持续破坏 DOM）退化为整页 reload，
//      reload 超 3 次仍崩溃则暂停自愈（窗口过期后自动重试），避免刷新风暴。
//
// ⚠ 注意：自愈只能「崩溃后恢复」，无法消除首次报错本身——控制台仍会出现一次
// NotFoundError（浏览器对未捕获异常的原生记录，无法拦截）。判断修复是否生效的
// 标准是「大屏是否白屏停留」，而不是控制台是否出现红色报错。
const CRASH_STATE_KEY = 'app_crash_recovery_state'
const DIAG_KEY = 'app_crash_diag'
const CRASH_WINDOW_MS = 10 * 60 * 1000
const MAX_REBUILDS = 5
const MAX_RELOADS = 3
const PAGE_LOAD_TS = Date.now()

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

// ============ 崩溃现场取证（配合上面的自愈使用）============
// 真实浏览器环境（扩展/翻译插件/CSP）无法在沙箱复现，只能靠线上取证：
// 用 MutationObserver 环形缓冲记录 body 子树的 childList 突变（React 自身的
// 提交也会计入，靠时间戳与内容判读；refresh=0 的静态大屏上 React 几乎不做
// childList 突变，出现即可疑——翻译插件典型特征是插入/移动 <font> 元素）。
// 崩溃时把最近突变 + 错误栈 + 页面存活时长落盘 localStorage（app_crash_diag，
// 供跨 reload 读取）并打印 [CrashDiag]，据此判定：
//   - 有外部特征突变 → 环境问题（关翻译/扩展），自愈负责兜底恢复；
//   - 无任何突变仍崩 → 页面数据/渲染路径缺陷，凭快照继续排查。
const mutLog = []
let crashDiagDumped = false

function describeNode(n) {
  try {
    if (!n) return '?'
    if (n.nodeType === 3) return `text(${String(n.textContent || '').slice(0, 16)})`
    if (n.nodeType !== 1) return `node#${n.nodeType}`
    let s = n.tagName.toLowerCase()
    if (n.id) s += '#' + n.id
    const c = typeof n.className === 'string' ? n.className.trim() : ''
    if (c) s += '.' + c.split(/\s+/).slice(0, 3).join('.')
    return s
  } catch {
    return '?'
  }
}

function pathOf(el) {
  const parts = []
  let cur = el
  let depth = 0
  while (cur && cur.nodeType === 1 && depth < 6) {
    let s = cur.tagName.toLowerCase()
    if (cur.id) s += '#' + cur.id
    parts.unshift(s)
    if (cur.id === 'root' || cur === document.body) break
    cur = cur.parentElement
    depth += 1
  }
  return parts.join('>')
}

try {
  new MutationObserver((records) => {
    for (const r of records) {
      if (mutLog.length > 300) mutLog.splice(0, 60)
      const at = pathOf(r.target)
      for (const n of r.removedNodes) mutLog.push(`${Date.now()} rm [${describeNode(n)}] @${at}`)
      for (const n of r.addedNodes) mutLog.push(`${Date.now()} add [${describeNode(n)}] @${at}`)
    }
  }).observe(document.body, { childList: true, subtree: true })
} catch {
  /* 观察器不可用时静默降级（不影响自愈） */
}

function dumpCrashDiag(e) {
  if (crashDiagDumped) return
  crashDiagDumped = true
  // 延后一拍：等 MutationObserver 的微任务先冲刷，把崩溃提交前的突变记全
  setTimeout(() => {
    const diag = {
      at: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - PAGE_LOAD_TS) / 1000),
      url: window.location.pathname + window.location.search,
      message: String(e?.message || ''),
      stack: String(e?.error?.stack || '').slice(0, 600),
      recentMutations: mutLog.slice(-40),
    }
    try { window.localStorage.setItem(DIAG_KEY, JSON.stringify(diag)) } catch { /* 忽略超限 */ }
    // eslint-disable-next-line no-console
    console.error('[CrashDiag] 崩溃现场：', diag)
  }, 0)
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
  dumpCrashDiag(e)
  const state = readCrashState()
  if (state.reloads.length >= MAX_RELOADS) {
    // 整页重载后仍持续崩溃：暂停自愈，等 10 分钟窗口过期后自动重试
    setTimeout(() => { recovering = false }, 60 * 1000)
    return
  }
  if (state.rebuilds.length >= MAX_REBUILDS) {
    // 原地恢复频次过高（环境持续破坏 DOM），退化为整页 reload（URL 状态保留，恢复后自动复原）
    state.reloads.push(Date.now())
    writeCrashState(state)
    // eslint-disable-next-line no-console
    console.error(`[CrashRecovery] 10 分钟内已重建 ${state.rebuilds.length} 次仍崩溃，改为整页刷新（第 ${state.reloads.length}/${MAX_RELOADS} 次）`)
    setTimeout(() => window.location.reload(), 500)
    return
  }
  state.rebuilds.push(Date.now())
  writeCrashState(state)
  const nth = state.rebuilds.length
  setTimeout(() => {
    try { root.unmount() } catch { /* 树已损坏时 unmount 可能抛错，忽略 */ }
    try { container.replaceChildren() } catch { /* ignore */ }
    root = ReactDOM.createRoot(container)
    root.render(<App />)
    // eslint-disable-next-line no-console
    console.log(`[CrashRecovery] 已重建页面（第 ${nth}/${MAX_REBUILDS} 次），数据将在下个刷新周期恢复`)
    // 给新树一个提交周期后解除防抖，允许后续崩溃再次恢复
    setTimeout(() => { recovering = false }, 2000)
  }, 100)
})
