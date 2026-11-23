// 告警规则命中记录抽屉：该规则命中的日志列表（服务端分页，保留近 7 天）
import { useCallback, useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'

import { alertRuleApi } from '../api/alert'
import HalfDrawer from '../components/HalfDrawer'
import { Badge, Pagination } from '../components/ui'
import { toast } from '../store/toastStore'
import { fmtTime, riskLevelName } from './alertRuleMeta'

// 风险等级徽章颜色（与告警列表一致：严重红/高危橙/中危黄/低危蓝/信息灰）
function RiskBadge({ level }) {
  if (level == null || level < 0) return <span className="text-muted-foreground">--</span>
  const variant = { 0: 'danger', 1: 'danger', 2: 'warning', 3: 'info', 4: 'neutral' }[level] || 'neutral'
  return <Badge variant={variant}>{riskLevelName(level)}</Badge>
}

/**
 * 命中记录抽屉。
 * filter: { ruleId, ruleName, action, today } —— action: 'alert' 产生类 / 'suppress' 抑制类
 */
export default function AlertRuleHitsDrawer({ open, filter, onClose }) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)

  const fetchHits = useCallback((p, ps) => {
    if (!filter) return
    setLoading(true)
    alertRuleApi.hits({
      ...(filter.ruleId ? { rule_id: filter.ruleId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.today ? { today: true } : {}),
      page: p, page_size: ps,
    })
      .then((res) => { setItems(res.items || []); setTotal(res.total || 0) })
      .catch((e) => toast.error(e.message || '命中记录加载失败'))
      .finally(() => setLoading(false))
  }, [filter])

  // 打开 / 切换过滤条件：重置到第一页并加载
  useEffect(() => {
    if (!open || !filter) return
    setPage(1)
    fetchHits(1, pageSize) // eslint-disable-line react-hooks/exhaustive-deps
  }, [open, filter])

  // 翻页 / 改页大小
  useEffect(() => {
    if (!open || !filter) return
    fetchHits(page, pageSize)
  }, [page, pageSize]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = filter
    ? `${filter.today ? '今日' : '近 7 天'}命中记录${filter.ruleName ? ` · ${filter.ruleName}` : ''}`
    : '命中记录'

  return (
    <HalfDrawer open={open} onClose={onClose} title={title} loading={loading && items.length === 0}>
      {items.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Inbox className="h-10 w-10 opacity-40" />
          <div className="text-xs">近 7 天无命中记录</div>
          <div className="text-xs text-muted-foreground">
            命中记录保留最近 7 天；确认规则已启用且条件与到达的日志匹配
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <div key={r.id} className="rounded-lg border border-border bg-muted px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-xs font-medium" title={r.alert_name || ''}>
                  {r.alert_name || '（未命名）'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground" title={fmtTime(r.matched_at)}>
                  {fmtTime(r.matched_at)}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>来源 IP：<span className="font-mono">{r.source_ip || '--'}</span></span>
                <RiskBadge level={r.risk_level} />
                <span className={r.parse_status === 'success' ? 'text-success' : 'text-warning'}>
                  解析{r.parse_status === 'success' ? '成功' : r.parse_status === 'partial' ? '部分解析' : '失败'}
                </span>
                {!filter?.ruleId && r.rule_name && (
                  <span className="truncate" title={r.rule_name}>规则：{r.rule_name}</span>
                )}
              </div>
            </div>
          ))}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(ps) => { setPageSize(ps); setPage(1) }}
          />
        </div>
      )}
    </HalfDrawer>
  )
}
