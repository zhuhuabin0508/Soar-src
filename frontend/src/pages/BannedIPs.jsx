/**
 * 已封禁 IP 页面 —— 独立路由 /banned-ips
 *
 * 功能逻辑已提取到 BannedIPsPanel 组件，本文件仅提供页面级外壳。
 * BannedIPsPanel 同时被工作台（ApprovalCenter）的 Tab 复用。
 */
import BannedIPsPanel from '../components/BannedIPsPanel'

function BannedIPs() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">已封禁 IP</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <BannedIPsPanel />
      </div>
    </div>
  )
}

export default BannedIPs
