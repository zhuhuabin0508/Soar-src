// API 开放：应用/密钥管理 + 调用监控 + 调用日志 + 对接指南
// 布局对齐「工具」页：PageHeader 固定标题栏 + 分段 Tab + 独立滚动内容区
import { useState } from 'react'
import { PageContainer, PageHeader, PillTabs } from '../../components/ui'
import { KeyRound, Activity, ScrollText, BookOpen, RefreshCw } from 'lucide-react'
import AppsTab from './AppsTab'
import StatsTab from './StatsTab'
import LogsTab from './LogsTab'
import GuideTab from './GuideTab'

const TABS = [
  { key: 'apps', label: '应用管理', icon: KeyRound },
  { key: 'stats', label: '调用监控', icon: Activity },
  { key: 'logs', label: '调用日志', icon: ScrollText },
  { key: 'guide', label: 'API对接指南', icon: BookOpen },
]

export default function ApiOpenManage() {
  const [tab, setTab] = useState('apps')
  // 全局刷新信号：标题栏「刷新」按钮触发当前 Tab 重新拉取数据
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <PageContainer>
      <PageHeader
        title="API开放"
        actions={
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="btn-secondary btn-sm"
            title="刷新当前页签数据"
          >
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PillTabs items={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === 'apps' && <AppsTab refreshKey={refreshKey} />}
      {tab === 'stats' && <StatsTab refreshKey={refreshKey} />}
      {tab === 'logs' && <LogsTab refreshKey={refreshKey} />}
      {tab === 'guide' && <GuideTab refreshKey={refreshKey} />}
    </PageContainer>
  )
}
