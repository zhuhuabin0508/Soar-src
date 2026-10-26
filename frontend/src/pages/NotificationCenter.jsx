import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell, Megaphone, AlertTriangle, XCircle, ExternalLink, Settings2,
  Activity, ShieldAlert, RefreshCw, MessageSquare, Clock, Ticket,
} from 'lucide-react'
import { notificationsApi, notificationRulesApi } from '../api/notifications'
import NotificationRulesPanel from '../components/NotificationRulesPanel'
import { EmptyState, Skeleton, CompactSelect } from '../components/ui'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'

// 根据通知关联资源生成跳转链接
function buildNotificationLink(n) {
  if (!n) return null
  // 优先使用 related_type + related_id
  if (n.related_type && n.related_id) {
    const map = {
      workflow: `/workflows?focus=${n.related_id}`,
      execution: `/executions?focus=${n.related_id}`,
      agent: `/agents/${n.related_id}/monitor`,
      tool: `/tools?focus=${n.related_id}`,
      knowledge_base: `/knowledge-base?focus=${n.related_id}`,
      user: `/users?focus=${n.related_id}`,
      ticket: `/tickets/${n.related_id}`,
      feedback: `/feedbacks/mine?focus=${n.related_id}`,
      llm_config: `/llm-configs?focus=${n.related_id}`,
      parse_template: `/strategies?focus=${n.related_id}`,
      alert_rule: `/alerts?focus=${n.related_id}`,
      log_receiver: `/receivers?focus=${n.related_id}`,
    }
    if (map[n.related_type]) return map[n.related_type]
  }
  // 按通知类型 fallback
  const typeMap = {
    announcement: '/notifications',
    system_alert: '/system-monitor',
    execution_failed: '/executions',
    approval_pending: '/approvals',
    workflow_alert: '/approvals?tab=all',
    model_alert: '/llm-configs',
    parse_alert: '/strategies',
    receiver_alert: '/receivers',
    alert_high_risk: '/alerts',
    feedback: '/feedbacks/mine',
  }
  return typeMap[n.type] || null
}

// 类型图标 / 语义色 / 中文标签映射（event-types 接口异常时的兜底）
const TYPE_META = {
  announcement: { icon: Megaphone, cls: 'bg-info/10 text-info hover:bg-info/20', label: '公告' },
  system_update: { icon: RefreshCw, cls: 'bg-info/10 text-info hover:bg-info/20', label: '系统更新' },
  system_alert: { icon: AlertTriangle, cls: 'bg-warning/10 text-warning hover:bg-warning/20', label: '系统资源告警' },
  alert_high_risk: { icon: ShieldAlert, cls: 'bg-destructive/10 text-destructive hover:bg-destructive/20', label: '高危告警命中' },
  receiver_alert: { icon: AlertTriangle, cls: 'bg-warning/10 text-warning hover:bg-warning/20', label: '日志接收异常' },
  parse_alert: { icon: AlertTriangle, cls: 'bg-warning/10 text-warning hover:bg-warning/20', label: '解析成功率异常' },
  execution_failed: { icon: XCircle, cls: 'bg-destructive/10 text-destructive hover:bg-destructive/20', label: '工作流执行失败' },
  approval_pending: { icon: Clock, cls: 'bg-info/10 text-info hover:bg-info/20', label: '待审批提醒' },
  workflow_alert: { icon: ShieldAlert, cls: 'bg-warning/10 text-warning hover:bg-warning/20', label: '封禁工作流告警' },
  workflow: { icon: Activity, cls: 'bg-primary/10 text-primary hover:bg-primary/20', label: '工作流运营通知' },
  model_alert: { icon: AlertTriangle, cls: 'bg-warning/10 text-warning hover:bg-warning/20', label: '模型健康异常' },
  feedback: { icon: MessageSquare, cls: 'bg-info/10 text-info hover:bg-info/20', label: '反馈' },
  ticket: { icon: Ticket, cls: 'bg-primary/10 text-primary hover:bg-primary/20', label: '工单' },
}

const READ_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'read', label: '已读' },
]

function getTypeIcon(type) {
  const Icon = TYPE_META[type]?.icon || Bell
  return <Icon className="h-4 w-4" />
}

// 类型图标外框语义色（rounded-full p-1.5 bg-*/10）
function getTypeCls(type) {
  return TYPE_META[type]?.cls || 'bg-primary/10 text-primary hover:bg-primary/20'
}

// 相对时间格式化：刚刚 / X分钟前 / X小时前 / X天前
function fmtRelative(t) {
  if (!t) return '-'
  let ts
  try {
    ts = new Date(t).getTime()
  } catch {
    return t
  }
  if (isNaN(ts)) return t
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

// 绝对时间（hover 提示用）
function fmtAbsolute(t) {
  if (!t) return ''
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

const PAGE_SIZE = 20

function NotificationCenter() {
  const navigate = useNavigate()
  // Tab 切换：list（通知列表） | rules（通知规则）
  const [tab, setTab] = useState('list')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 筛选条件
  const [typeFilter, setTypeFilter] = useState('')
  const [readFilter, setReadFilter] = useState('')
  // 类型筛选选项：优先取后端 /notification-rules/event-types（与通知规则配置同源），
  // 接口异常时回退 TYPE_META 静态清单
  const [typeOptions, setTypeOptions] = useState(
    [{ value: '', label: '全部类型' }].concat(
      Object.entries(TYPE_META).map(([value, m]) => ({ value, label: m.label })),
    ),
  )
  // 类型 → 中文标签（列表徽标 / 详情弹窗展示用）
  const [typeLabels, setTypeLabels] = useState(
    Object.fromEntries(Object.entries(TYPE_META).map(([v, m]) => [v, m.label])),
  )
  // 操作进行中：null | 'all' | <id>
  const [actionId, setActionId] = useState(null)
  // 通知详情弹窗
  const [detailItem, setDetailItem] = useState(null)
  useLockBackgroundScroll(!!detailItem)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await notificationsApi.list(PAGE_SIZE, offset)
      const list = Array.isArray(res)
        ? res
        : res?.items || res?.notifications || []
      setItems(list)
      setTotal(res?.total ?? list.length)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [offset])

  useEffect(() => {
    load()
  }, [load])

  // 拉取事件类型清单（与通知规则配置同源），补充工单类型后构建筛选项与标签映射
  useEffect(() => {
    let cancelled = false
    notificationRulesApi
      .eventTypes()
      .then((res) => {
        if (cancelled) return
        const ets = (res?.event_types || []).filter((et) => et.value && et.value !== '*')
        if (ets.length === 0) return
        // 合并 TYPE_META 里的工单（不在可配置清单中，但列表会出现）
        const merged = [...ets]
        if (!merged.some((et) => et.value === 'ticket')) {
          merged.push({ value: 'ticket', label: TYPE_META.ticket.label, desc: '工单通知（精确投递）', group: '工单' })
        }
        setTypeOptions(
          [{ value: '', label: '全部类型' }].concat(merged.map((et) => ({ value: et.value, label: et.label }))),
        )
        setTypeLabels(Object.fromEntries(merged.map((et) => [et.value, et.label])))
      })
      .catch(() => {/* 接口异常时保留 TYPE_META 兜底 */})
    return () => { cancelled = true }
  }, [])

  // 客户端筛选（API 仅支持 limit/offset）
  const filtered = items.filter((n) => {
    if (typeFilter && n.type !== typeFilter) return false
    if (readFilter === 'unread' && n.is_read) return false
    if (readFilter === 'read' && !n.is_read) return false
    return true
  })

  const handleMarkRead = async (id) => {
    if (actionId !== null) return
    setActionId(id)
    try {
      await notificationsApi.markRead(id)
      setItems((list) =>
        list.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      )
    } catch (err) {
      setError(err.message || '标记已读失败')
    } finally {
      setActionId(null)
    }
  }

  // 点击通知项：标记已读 + 跳转到关联资源或打开详情
  const handleViewNotification = async (n) => {
    if (!n.is_read) {
      // 静默标记已读，不阻塞跳转
      notificationsApi.markRead(n.id).catch(() => {})
      setItems((list) =>
        list.map((it) => (it.id === n.id ? { ...it, is_read: true } : it))
      )
    }
    const link = buildNotificationLink(n)
    if (link && link !== '/notifications') {
      navigate(link)
    } else {
      setDetailItem(n)
    }
  }

  // 跳转到关联资源（详情弹窗内的「查看详情」按钮）
  const handleGotoRelated = (n) => {
    const link = buildNotificationLink(n)
    if (link && link !== '/notifications') {
      setDetailItem(null)
      navigate(link)
    }
  }

  const handleMarkAllRead = async () => {
    if (actionId !== null) return
    setActionId('all')
    try {
      await notificationsApi.markAllRead()
      setItems((list) => list.map((n) => ({ ...n, is_read: true })))
    } catch (err) {
      setError(err.message || '全部标记已读失败')
    } finally {
      setActionId(null)
    }
  }

  const handleDelete = async (id) => {
    if (actionId !== null) return
    setActionId(id)
    try {
      await notificationsApi.remove(id)
      setItems((list) => list.filter((n) => n.id !== id))
      setTotal((t) => Math.max(0, t - 1))
    } catch (err) {
      setError(err.message || '删除失败')
    } finally {
      setActionId(null)
    }
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < total

  const handlePrev = () => {
    if (canPrev) setOffset(Math.max(0, offset - PAGE_SIZE))
  }
  const handleNext = () => {
    if (canNext) setOffset(offset + PAGE_SIZE)
  }

  const hasUnread = items.some((n) => !n.is_read)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部标题栏 */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">通知中心</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">站内通知统一收件箱；各模块事件的通知投递均可在「通知规则」中配置（工单除外）</p>
        </div>
        {tab === 'list' && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={!hasUnread || actionId !== null}
            className="btn-secondary btn-sm"
          >
            {actionId === 'all' ? '处理中...' : '全部标记已读'}
          </button>
        )}
      </header>

      {/* Tab 切换栏 */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-6 py-2">
        <button
          type="button"
          onClick={() => setTab('list')}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'list'
              ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <Bell className="h-3.5 w-3.5" />
          通知列表
        </button>
        <button
          type="button"
          onClick={() => setTab('rules')}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'rules'
              ? 'bg-primary/10 text-primary ring-1 ring-primary/25'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <Settings2 className="h-3.5 w-3.5" />
          通知规则
        </button>
      </div>

      {/* 通知规则 Tab */}
      {tab === 'rules' ? (
        <div className="flex-1 overflow-y-auto p-6">
          <NotificationRulesPanel />
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
      {/* 筛选区：卡片条样式，控件统一 input-base 风格（h-9） */}
      <div className="border-b border-border px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="whitespace-nowrap text-xs text-muted-foreground">类型</span>
            <CompactSelect
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              size="lg"
            >
              {typeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </CompactSelect>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="whitespace-nowrap text-xs text-muted-foreground">状态</span>
            <CompactSelect
              value={readFilter}
              onChange={(e) => setReadFilter(e.target.value)}
              size="lg"
            >
              {READ_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </CompactSelect>
          </div>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-lg border border-border" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={items.length === 0 ? '暂无通知' : '未匹配到符合筛选条件的通知'}
            description={items.length === 0 ? '系统公告、告警与执行结果通知将在此展示' : '尝试调整类型或已读状态筛选条件'}
            className="py-16"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {filtered.map((n) => {
              const link = buildNotificationLink(n)
              const hasRelated = link && link !== '/notifications'
              return (
              <div
                key={n.id}
                className="cursor-pointer rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent"
              >
                <div className="flex items-start gap-4">
                  {/* 未读/已读状态圆点：未读主色 / 已读弱化 */}
                  <span
                    className={`mt-3 h-2 w-2 shrink-0 rounded-full ${n.is_read ? 'bg-border' : 'bg-primary'}`}
                    title={n.is_read ? '已读' : '未读'}
                  />
                  <button
                    type="button"
                    onClick={() => handleViewNotification(n)}
                    className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full p-1.5 transition-colors ${getTypeCls(n.type)}`}
                    title="点击查看详情"
                  >
                    {getTypeIcon(n.type)}
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => handleViewNotification(n)}
                      className="block w-full cursor-pointer text-left"
                      title="点击查看详情"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground hover:text-primary">
                          {n.title || '(无标题)'}
                        </span>
                        {!n.is_read && (
                          <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            未读
                          </span>
                        )}
                        {n.type && (
                          <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={n.type}>
                            {typeLabels[n.type] || n.type}
                          </span>
                        )}
                        {hasRelated && (
                          <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" title={`关联：${n.related_type}#${n.related_id}`}>
                            <ExternalLink className="h-2.5 w-2.5" />
                            {n.related_type}#{n.related_id}
                          </span>
                        )}
                      </div>
                      {n.content && (
                        <div className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                          {n.content}
                        </div>
                      )}
                      <div
                        className="mt-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                        title={fmtAbsolute(n.created_at)}
                      >
                        {fmtRelative(n.created_at)}
                      </div>
                    </button>
                  </div>
                  {/* 操作 */}
                  <div className="flex shrink-0 items-center gap-2">
                    {hasRelated && (
                      <button
                        type="button"
                        onClick={() => handleGotoRelated(n)}
                        disabled={actionId !== null}
                        className="btn-secondary btn-sm"
                        title="跳转到关联资源"
                      >
                        查看详情
                      </button>
                    )}
                    {!n.is_read && (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(n.id)}
                        disabled={actionId !== null}
                        className="btn-secondary btn-sm"
                      >
                        {actionId === n.id ? '处理中' : '标记已读'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(n.id)}
                      disabled={actionId !== null}
                      className="btn-danger btn-sm"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
              )
            })}
          </div>
        )}

        {/* 分页 */}
        {!loading && filtered.length > 0 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">
              共 {total} 条，第 {currentPage} / {totalPages} 页
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrev}
                disabled={!canPrev}
                className="btn-secondary btn-sm"
              >
                上一页
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={!canNext}
                className="btn-secondary btn-sm"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 通知详情弹窗 */}
      {detailItem && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={() => setDetailItem(null)}>
          <div
            className="card-accent-top w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">通知详情</h3>
              <button
                type="button"
                onClick={() => setDetailItem(null)}
                className="rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div data-allow-scroll className="max-h-[70vh] space-y-3 overflow-y-auto overscroll-contain p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-foreground">{detailItem.title || '(无标题)'}</span>
                {detailItem.type && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={detailItem.type}>
                    {typeLabels[detailItem.type] || detailItem.type}
                  </span>
                )}
                {!detailItem.is_read && (
                  <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    未读
                  </span>
                )}
              </div>
              {detailItem.content && (
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                  {detailItem.content}
                </div>
              )}
              <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={fmtAbsolute(detailItem.created_at)}>
                {fmtRelative(detailItem.created_at)} · {fmtAbsolute(detailItem.created_at)}
              </div>
              {detailItem.related_type && detailItem.related_id && (
                <div className="rounded-md border border-border bg-secondary p-3 text-xs">
                  <div className="text-muted-foreground">关联资源</div>
                  <div className="mt-1 text-foreground">
                    {detailItem.related_type} #{detailItem.related_id}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <button type="button" onClick={() => setDetailItem(null)} className="btn-secondary">关闭</button>
              {buildNotificationLink(detailItem) && buildNotificationLink(detailItem) !== '/notifications' && (
                <button
                  type="button"
                  onClick={() => handleGotoRelated(detailItem)}
                  className="btn-primary"
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  查看关联资源
                </button>
              )}
            </div>
          </div>
        </div>
      )}
        </div>
      )}
    </div>
  )
}

export default NotificationCenter
