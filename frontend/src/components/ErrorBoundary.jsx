// 全局错误边界：捕获子树渲染期异常，提供友好降级 UI，避免白屏。
//
// 用法 1（推荐，普通包裹）：把 ErrorBoundary 包在任意子树外层
//   import { ErrorBoundary } from './components/ErrorBoundary'
//   <ErrorBoundary><MyWidget /></ErrorBoundary>
//
// 用法 2（路由级）：作为 react-router 的 errorElement
//   import { RouteErrorFallback } from './components/ErrorBoundary'
//   { path: '/x', element: <Page />, errorElement: <RouteErrorFallback /> }
//
// 用法 3（全局兜底）：包在 RouterProvider 外层
//   <ErrorBoundary><App /></ErrorBoundary>
//
// 设计要点：
// - 控制台与生产环境区分：开发环境直接显示完整错误栈，生产环境仅显示摘要
// - 提供「重试」（reset 内部 state）与「刷新页面」（location.reload）两个动作
// - 提供错误栈复制（剪贴板）便于反馈
// - 尊重 prefers-reduced-motion
import { Component, useState, useEffect } from 'react'
import { useRouteError, useNavigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw, Copy, Check } from 'lucide-react'
import { getFirstPermittedPath } from './AppShell'

// 友好降级 UI：错误图标 + 标题 + 摘要 + 操作按钮
// componentStack：React 提交/渲染阶段的组件路径。像 insertBefore NotFoundError 这类
// 提交阶段异常，error.stack 只有 react-dom 内部帧（Gc/fl/dl/ll…），必须靠组件栈才能定位页面。
function ErrorFallback({ error, componentStack, onReset, onReload }) {
  const isDev = import.meta.env?.DEV
  const [copied, setCopied] = useState(false)
  // 错误信息附带当前路由，便于把一次报错和具体页面/操作对上
  const routeInfo = typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}`
    : ''
  const copyStack = async () => {
    const text = [
      `路径：${routeInfo}`,
      '',
      error?.stack || String(error || ''),
      componentStack ? `\n\n组件栈：${componentStack}` : '',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默
    }
  }
  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h2 className="text-base font-semibold text-foreground">页面出现异常</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          抱歉，页面渲染时发生错误。可尝试重试当前操作，或刷新页面后继续。
        </p>
      </div>
      {isDev && error?.message && (
        <pre className="max-h-40 w-full max-w-2xl overflow-auto rounded-md border border-border bg-muted p-3 text-left text-xs text-destructive">
          {error.message}
          {error?.stack ? '\n\n' + error.stack : ''}
          {componentStack ? '\n\n组件栈：' + componentStack : ''}
        </pre>
      )}
      <div className="flex items-center gap-2">
        {onReset && (
          <button type="button" onClick={onReset} className="btn-secondary btn-sm">
            <RefreshCw className="h-3.5 w-3.5" /> 重试
          </button>
        )}
        <button type="button" onClick={onReload || (() => window.location.reload())} className="btn-primary btn-sm">
          <RefreshCw className="h-3.5 w-3.5" /> 刷新页面
        </button>
        <button type="button" onClick={copyStack} className="btn-ghost btn-sm">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制错误信息'}
        </button>
      </div>
    </div>
  )
}

// class 形式的错误边界（React 仍要求 class 才能使用 getDerivedStateFromError）
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, componentStack: '' }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    // 上报到控制台，便于调试；可在此扩展远程上报
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
    // 保留组件栈：提交阶段异常（如 insertBefore NotFoundError）只有它才能指出具体页面/组件
    this.setState({ componentStack: info?.componentStack || '' })
  }
  handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: '' })
  }
  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          onReset={this.handleReset}
        />
      )
    }
    return this.props.children
  }
}

// 路由级错误降级：用 useRouteError 取错误
// 作为 react-router errorElement 使用
export function RouteErrorFallback() {
  const error = useRouteError()
  const navigate = useNavigate()
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[RouteError]', error)
  }, [error])
  // 401 → 跳登录（与全局 token 失效语义对齐）
  if (error?.status === 401) {
    setTimeout(() => navigate('/login', { replace: true }), 0)
    return null
  }
  // 404 → 显示专门的「页面不存在」
  if (error?.status === 404) {
    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <div className="text-5xl font-bold text-muted-foreground">404</div>
        <div className="max-w-md">
          <h2 className="text-base font-semibold text-foreground">页面不存在</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            你访问的页面可能已被移除或地址有误。
          </p>
        </div>
        <button type="button" onClick={() => navigate(getFirstPermittedPath(), { replace: true })} className="btn-primary btn-sm">
          返回首页
        </button>
      </div>
    )
  }
  return (
    <ErrorFallback
      error={error}
      onReload={() => navigate(getFirstPermittedPath(), { replace: true })}
    />
  )
}

export default ErrorBoundary
