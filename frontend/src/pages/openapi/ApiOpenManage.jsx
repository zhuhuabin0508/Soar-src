// API 开放平台管理：应用/密钥管理 + 调用监控 + 调用日志
import { useState } from 'react'
import { PageContainer, PageHeader } from '../../components/ui'
import { KeyRound, Activity, ScrollText, Boxes } from 'lucide-react'
import AppsTab from './AppsTab'
import StatsTab from './StatsTab'
import LogsTab from './LogsTab'

const TABS = [
  { key: 'apps', label: '应用管理', icon: Boxes },
  { key: 'stats', label: '调用监控', icon: Activity },
  { key: 'logs', label: '调用日志', icon: ScrollText },
]

export default function ApiOpenManage() {
  const [tab, setTab] = useState('apps')
  return (
    <PageContainer>
      <PageHeader
        title="API 开放平台"
        description="向第三方系统安全开放平台数据：API Key 鉴权、按应用可配置数据授权、独立限流配额、全量调用审计与监控"
      />
      {/* Tab 切换 */}
      <div className="mb-4 flex items-center gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
              tab === key
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === 'apps' && <AppsTab />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'logs' && <LogsTab />}
    </PageContainer>
  )
}
