/**
 * About —— 关于页面
 *
 * 集中展示平台版本、平台名称、安全合规标识等信息。
 * 版本号原位于侧边栏底部，现移至此页面，避免占用常用导航空间。
 */
import { useEffect, useState } from 'react'
import { ShieldCheck, Info, RefreshCw, Code, FileText } from 'lucide-react'
import { toast } from '../store/toastStore'

export default function About() {
  const [version, setVersion] = useState('')
  const [platformName, setPlatformName] = useState('SOAR 平台')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      setLoading(true)
      const r = await fetch('/api/v1/version')
      const d = await r.json()
      setVersion(d.version || '')
      if (d.platform_name) setPlatformName(d.platform_name)
    } catch (err) {
      toast.error(`加载版本信息失败：${err.message || err}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {/* 头部：科技网格装饰卡片 */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-card bg-tech-grid p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-lg font-bold text-primary-foreground shadow-md shadow-primary/20">
              S
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{platformName}</h1>
            </div>
          </div>
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* 版本信息卡片：顶缘主色线 + 版本号辉光大字号 */}
        <div className="card-accent-top rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">版本信息</span>
          </div>
          {/* 版本号主展示：大字号 + 主色辉光 */}
          <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-secondary px-5 py-4">
            <span className="text-xs text-muted-foreground">当前版本</span>
            <span className="text-glow font-mono text-3xl font-bold tabular-nums text-primary">
              v{version || (loading ? '...' : '-')}
            </span>
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary px-4 py-3">
              <dt className="text-xs text-muted-foreground">版本标识</dt>
              <dd className="text-sm font-medium">安全增强版</dd>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary px-4 py-3">
              <dt className="text-xs text-muted-foreground">平台名称</dt>
              <dd className="text-sm font-medium">{platformName}</dd>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary px-4 py-3">
              <dt className="text-xs text-muted-foreground">运行环境</dt>
              <dd className="text-sm font-medium">Docker 容器化部署</dd>
            </div>
          </dl>
        </div>

        {/* 安全合规 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            <span className="text-sm font-semibold">安全与合规</span>
          </div>
          <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>符合国家网络安全等级保护（等保）要求，用户操作全审计</span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>密码 bcrypt 哈希存储，JWT 令牌会话管理与黑名单吊销</span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>接口 RBAC 权限控制，登录会话过期统一 401 处理</span>
            </li>
          </ul>
        </div>

        {/* 技术栈 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-info" />
            <span className="text-sm font-semibold">技术栈</span>
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-md border border-border bg-secondary px-3 py-2">
              <span className="text-muted-foreground">前端：</span>
              <span className="font-medium text-foreground">React + Vite + TailwindCSS</span>
            </div>
            <div className="rounded-md border border-border bg-secondary px-3 py-2">
              <span className="text-muted-foreground">后端：</span>
              <span className="font-medium text-foreground">FastAPI + SQLAlchemy + PostgreSQL</span>
            </div>
            <div className="rounded-md border border-border bg-secondary px-3 py-2">
              <span className="text-muted-foreground">AI 框架：</span>
              <span className="font-medium text-foreground">LangChain + 自研 Hermes 引擎</span>
            </div>
            <div className="rounded-md border border-border bg-secondary px-3 py-2">
              <span className="text-muted-foreground">引擎：</span>
              <span className="font-medium text-foreground">Hermes ReAct 引擎</span>
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-center gap-2 pb-4 text-xs text-muted-foreground">
          <Code className="h-3 w-3" />
          <span>SOAR Platform · 安全编排自动化与响应</span>
        </div>
      </div>
    </div>
  )
}
