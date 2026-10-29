import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell, Megaphone, AlertTriangle, XCircle, ExternalLink, Ticket,
  Clock, ShieldAlert, Activity, RefreshCw, MessageSquare,
} from 'lucide-react'
import { notificationsApi } from '../api/notifications'
import { toast } from '../store/toastStore'
import { fmtAbs } from '../utils/absTime'
import { guardNavPermission } from '../utils/permissions'

// 类型图标映射（带语义色容器：公告 info / 系统告警 warning / 执行失败 destructive / 工单 primary）
const TYPE_ICON = {
  announcement: <Megaphone className="h-3.5 w-3.5" />,
  system_alert: <AlertTriangle className="h-3.5 w-3.5" />,
  execution_failed: <XCircle className="h-3.5 w-3.5" />,
  alert_high_risk: <ShieldAlert className="h-3.5 w-3.5" />,
  approval_pending: <Clock className="h-3.5 w-3.5" />,
  workflow: <Activity className="h-3.5 w-3.5" />,
  system_update: <RefreshCw className="h-3.5 w-3.5" />,
  feedback: <MessageSquare className="h-3.5 w-3.5" />,
  ticket: <Ticket className="h-3.5 w-3.5" />,
}

// 类型 → 图标底色容器（浅色圆角底 + 语义色图标）
const TYPE_ICON_CLS = {
  announcement: 'bg-info/15 text-info',
  system_alert: 'bg-warning/15 text-warning',
  execution_failed: 'bg-destructive/15 text-destructive',
  alert_high_risk: 'bg-destructive/15 text-destructive',
  approval_pending: 'bg-info/15 text-info',
  workflow: 'bg-primary/15 text-primary',
  system_update: 'bg-info/15 text-info',
  feedback: 'bg-info/15 text-info',
  ticket: 'bg-primary/15 text-primary',
}

// 类型 → 中文名（滑出提醒卡片标题、合并提示文案用）
const TYPE_LABEL = {
  announcement: '公告',
  system_update: '系统更新',
  system_alert: '系统资源告警',
  alert_high_risk: '高危告警命中',
  receiver_alert: '日志接收异常',
  parse_alert: '解析成功率异常',
  execution_failed: '工作流执行失败',
  approval_pending: '待审批提醒',
  workflow_alert: '封禁工作流告警',
  workflow: '工作流运营通知',
  model_alert: '模型健康异常',
  feedback: '反馈',
  ticket: '工单处置提醒',
}

function getTypeIcon(type) {
  return TYPE_ICON[type] || <Bell className="h-3.5 w-3.5" />
}

function getTypeIconCls(type) {
  return TYPE_ICON_CLS[type] || 'bg-primary/15 text-primary'
}

function getTypeLabel(type) {
  return TYPE_LABEL[type] || '新通知'
}

// 根据通知关联资源生成跳转链接（与通知中心 buildNotificationLink 保持一致）
// related_id 直达详情页（如工单 /tickets/:id），列表类页面用 focus 参数定位高亮
function buildNotificationLink(n) {
  if (!n) return null
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
    announcement: null,
    system_alert: '/system-monitor',
    execution_failed: '/executions',
    approval_pending: '/approvals',
    workflow_alert: '/approvals?tab=all',
    model_alert: '/llm-configs',
    parse_alert: '/strategies',
    receiver_alert: '/receivers',
    alert_high_risk: '/alerts',
    feedback: '/feedbacks/mine',
    ticket: '/tickets',
  }
  return typeMap[n.type] || null
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

// ===== 个人提醒偏好 =====
// 偏好缓存 key（localStorage，进入页面即时可用；服务端为准，登录后刷新）
const PREFS_CACHE_KEY = 'soar_notif_prefs'
// 同类型合并窗口：首条立即滑出提醒，窗口内（30s）后续同类型静默合并（用户确认 30s）
const MERGE_WINDOW_MS = 30000
// 提醒卡片停留时长（比普通 toast 长，留足点击时间）
const TOAST_DURATION = 8000

// 通知铃铛：固定在右上角，展示未读数量徽章 + 下拉面板（最近 5 条）
// 新通知按个人偏好分流：右侧滑出提醒（可点击跳转关联详情）/ 仅铃铛计数。
function NotificationBell() {
  const navigate = useNavigate()
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState([])
  const [loadingRecent, setLoadingRecent] = useState(false)
  const [actioning, setActioning] = useState(false)
  const containerRef = useRef(null)
  // 已见过的通知 ID 集合：用于检测"新"通知（仅对未读通知弹窗）
  const seenIdsRef = useRef(new Set())
  // 上一次未读数：用于判断是否需要拉取最近通知做对比
  const prevUnreadRef = useRef(0)
  // 是否完成首次拉取（首次不弹窗，仅记录基线）
  const firstLoadRef = useRef(true)
  // 个人提醒偏好：type → 'toast' | 'silent'（与后端默认策略镜像：工单滑出、其余静默）
  const prefsRef = useRef({})
  // 同类型合并抑制窗口：type → 窗口截止时间戳（首条已弹，窗口内后续静默合并）
  const suppressRef = useRef(new Map())

  // 查某类型的提醒方式：显式配置优先，否则按默认策略（工单滑出、其余静默）
  const getPopupMode = useCallback((type) => {
    const p = prefsRef.current[type]
    if (p === 'toast' || p === 'silent') return p
    return type === 'ticket' ? 'toast' : 'silent'
  }, [])

  // 拉取个人提醒偏好（服务端为准），并写 localStorage 缓存
  const loadPrefs = useCallback(async () => {
    try {
      const res = await notificationsApi.getPrefs()
      const map = {}
      ;(res?.prefs || []).forEach((p) => {
        if (p.popup_mode === 'toast' || p.popup_mode === 'silent') map[p.event_type] = p.popup_mode
      })
      prefsRef.current = map
      try {
        localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(map))
      } catch { /* 存储不可用时忽略 */ }
    } catch {
      // 拉取失败：用 localStorage 缓存兜底（无缓存则走默认策略）
      try {
        const cached = JSON.parse(localStorage.getItem(PREFS_CACHE_KEY) || '{}')
        if (cached && typeof cached === 'object') prefsRef.current = cached
      } catch { /* 忽略 */ }
    }
  }, [])

  // 初始化：先读缓存（即时生效），再异步刷新服务端；监听偏好变更事件（设置页保存后同步）
  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(PREFS_CACHE_KEY) || '{}')
      if (cached && typeof cached === 'object') prefsRef.current = cached
    } catch { /* 忽略 */ }
    loadPrefs()
    const onPrefsChanged = () => loadPrefs()
    window.addEventListener('soar:notification-prefs-changed', onPrefsChanged)
    return () => {
      window.removeEventListener('soar:notification-prefs-changed', onPrefsChanged)
      suppressRef.current.clear()
    }
  }, [loadPrefs])

  // 弹一条滑出提醒卡片（点击跳转关联资源 / 通知中心）
  const showToastReminder = useCallback(
    (title, message, n) => {
      const link = buildNotificationLink(n)
      toast.warning(message, {
        title,
        duration: TOAST_DURATION,
        actionLabel: '查看详情',
        onClick: () => {
          // 点击提醒：静默标记已读 + 跳转
          if (n && !n.is_read) {
            notificationsApi.markRead(n.id).catch(() => {})
            setUnread((u) => Math.max(0, u - 1))
          }
          if (link) {
            navigate(link)
          } else {
            if (!guardNavPermission('notification', 'view', '通知中心')) return
            navigate('/notifications')
          }
        },
      })
    },
    [navigate],
  )

  // 收到一条新通知：按偏好分流。
  // toast 类型：首条立即滑出提醒（保证时效），30s 抑制窗口内后续同类型静默合并
  // （避免批量流转刷屏，合并信息在铃铛下拉与徽章计数可见）。
  const enqueueReminder = useCallback(
    (n) => {
      const mode = getPopupMode(n.type)
      if (mode !== 'toast') {
        console.info('[notif] 静默(仅铃铛):', n.id, n.type, 'mode =', mode)
        return
      }
      const now = Date.now()
      const until = suppressRef.current.get(n.type) || 0
      if (now < until) {
        console.info('[notif] 合并抑制:', n.id, n.type, '窗口剩余', Math.ceil((until - now) / 1000) + 's')
        return
      }
      suppressRef.current.set(n.type, now + MERGE_WINDOW_MS)
      console.info('[notif] 弹出提醒:', n.id, n.type, '->', n.title)
      showToastReminder(`${getTypeLabel(n.type)}提醒`, n.title || '收到新通知', n)
    },
    [getPopupMode, showToastReminder],
  )

  // 检测新通知并按偏好提醒
  const checkNewAndToast = useCallback(
    async (newUnread) => {
      // 未读数没有增长，跳过拉取最近通知
      if (newUnread <= prevUnreadRef.current) return
      try {
        const res = await notificationsApi.list(5, 0)
        const list = Array.isArray(res)
          ? res
          : res?.items || res?.notifications || []
        // 首次拉取：仅记录基线，不弹窗
        if (firstLoadRef.current) {
          list.forEach((n) => seenIdsRef.current.add(n.id))
          firstLoadRef.current = false
          console.info('[notif] 基线记录完成:', list.map((n) => n.id).join(','))
          return
        }
        // 后续轮询：对未见过的未读通知，按个人偏好分流（滑出/仅铃铛）
        for (const n of list) {
          if (seenIdsRef.current.has(n.id)) continue
          seenIdsRef.current.add(n.id)
          if (n.is_read) continue
          console.info('[notif] 新通知:', n.id, n.type, 'title:', n.title)
          enqueueReminder(n)
        }
      } catch (e) {
        console.warn('[notif] 拉取最近通知失败:', e?.message || e)
      }
    },
    [enqueueReminder],
  )

  // 获取未读计数
  const loadUnread = useCallback(async () => {
    try {
      const res = await notificationsApi.unreadCount()
      // 后端返回 { unread_count: N }，兼容旧版 { count: N } 与裸数字
      const count = res?.unread_count ?? res?.count ?? (typeof res === 'number' ? res : 0)
      console.info('[notif] 轮询 unread:', count, '上次:', prevUnreadRef.current)
      setUnread(count || 0)
      // 未读数增长时，拉取最近通知并按偏好提醒
      if (count > prevUnreadRef.current) {
        await checkNewAndToast(count)
      }
      prevUnreadRef.current = count || 0
    } catch (e) {
      console.warn('[notif] 轮询失败:', e?.message || e)
    }
  }, [checkNewAndToast])

  // 初始化 + 轮询刷新未读计数（可见 10s / 后台标签页跳过省请求，回到前台立即补查）
  useEffect(() => {
    loadUnread()
    const timer = setInterval(() => {
      // 后台标签页不请求（浏览器本身也会节流定时器），回到前台由 visibilitychange 立即补查
      if (document.hidden) return
      loadUnread()
    }, 10000)
    const onVisible = () => {
      if (!document.hidden) loadUnread()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadUnread])

  // ===== WebSocket 实时推送 =====
  // 连接 /api/v1/ws/notifications（浏览器 WS 无法带 Authorization 头，token 经子协议传递鉴权）。
  // 服务端通知 commit 后毫秒级推送信号 → 立即 loadUnread() 刷新铃铛并按偏好分流提醒；
  // WS 只是加速信号，上方轮询保留兜底（断网/Redis 故障时提醒退化为轮询节奏）。
  // 断线指数退避重连（1s/2s/5s/10s 封顶 + 随机抖动，防集体惊群）；
  // 4401 鉴权失败不重连；4429 超单用户连接上限继续退避重连（关闭其他标签页后自动恢复）。
  useEffect(() => {
    let ws = null
    let closed = false
    let reconnectTimer = null
    let heartbeatTimer = null
    const BACKOFFS = [1000, 2000, 5000, 10000]
    let attempt = 0

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }

    const connect = () => {
      const token = localStorage.getItem('soar_token')
      if (!token) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      try {
        // token 经子协议传递（不落访问日志；query 串会被 uvicorn/nginx 完整记录）
        ws = new WebSocket(
          `${proto}://${window.location.host}/api/v1/ws/notifications`,
          ['bearer', token],
        )
      } catch {
        return
      }
      ws.onopen = () => {
        attempt = 0
        // 30s 应用层心跳：服务端 90s 收不到任何消息即断开，30s 一跳留足余量
        heartbeatTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 30000)
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.kind === 'notification') {
            console.info('[notif] WS 实时推送:', msg.id, msg.type, '->', msg.title)
            // 推送自带通知全量字段：直接按偏好分流弹提醒，与铃铛同速到达。
            // 不再绕道「未读数对比 → 拉列表」（两次 API 往返慢且有竞态）。
            if (msg.id != null && !seenIdsRef.current.has(msg.id)) {
              seenIdsRef.current.add(msg.id) // 先登记去重，防止后续轮询对同一条重复弹
              enqueueReminder({ ...msg, is_read: false })
            }
            // 同步刷新徽章计数（该 id 已进 seenIds，loadUnread 内不会重复弹）
            loadUnread()
          }
        } catch { /* 忽略非 JSON 帧（pong 等） */ }
      }
      ws.onclose = (ev) => {
        stopHeartbeat()
        if (closed) return
        if (ev.code === 4401) {
          console.warn('[notif] WS 鉴权失败（token 过期/已登出），停止重连，轮询兜底')
          return
        }
        // 4429（超单用户连接上限）不特殊处理：按退避继续重连，
        // 关闭其他标签页释放名额后自动恢复实时推送；期间轮询兜底不丢通知。
        const delay = BACKOFFS[Math.min(attempt, BACKOFFS.length - 1)]
        attempt += 1
        reconnectTimer = setTimeout(connect, delay + Math.random() * 0.3 * delay)
      }
    }

    connect()
    return () => {
      closed = true
      stopHeartbeat()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        try { ws.close() } catch { /* 忽略 */ }
      }
    }
    // loadUnread / enqueueReminder 均为稳定 useCallback 引用（依赖链到 navigate 为止），
    // 不会因重渲染导致 WS 断开重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadUnread, enqueueReminder])

  // 下拉面板外点击关闭
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  // 拉取最近 5 条通知
  const loadRecent = useCallback(async () => {
    setLoadingRecent(true)
    try {
      const res = await notificationsApi.list(5, 0)
      const list = Array.isArray(res)
        ? res
        : res?.items || res?.notifications || []
      setRecent(list)
    } catch {
      setRecent([])
    } finally {
      setLoadingRecent(false)
    }
  }, [])

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    if (next) loadRecent()
  }

  // 标记单条已读
  const handleMarkRead = async (id) => {
    try {
      await notificationsApi.markRead(id)
      setRecent((list) =>
        list.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      )
      setUnread((u) => Math.max(0, u - 1))
    } catch {
      // 静默失败
    }
  }

  // 点击通知项：标记已读 + 跳转到关联资源（如工单详情）或通知中心
  const handleClickNotification = async (n) => {
    if (!n.is_read) {
      // 静默标记已读
      notificationsApi.markRead(n.id).catch(() => {})
      setRecent((list) =>
        list.map((it) => (it.id === n.id ? { ...it, is_read: true } : it))
      )
      setUnread((u) => Math.max(0, u - 1))
    }
    const link = buildNotificationLink(n)
    setOpen(false)
    if (link) {
      navigate(link)
    } else {
      // 没有关联资源，跳转到通知中心查看完整内容（无权限时 toast 拦截）
      if (!guardNavPermission('notification', 'view', '通知中心')) return
      navigate('/notifications')
    }
  }

  // 全部标记已读
  const handleMarkAllRead = async () => {
    if (actioning) return
    setActioning(true)
    try {
      await notificationsApi.markAllRead()
      setRecent((list) => list.map((n) => ({ ...n, is_read: true })))
      setUnread(0)
    } catch {
      // 静默失败
    } finally {
      setActioning(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* 铃铛按钮：悬停微抬 + 铃铛摆动反馈 */}
      <button
        type="button"
        onClick={handleToggle}
        className={`group relative flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-foreground transition-all duration-200 hover:bg-accent hover:ring-1 hover:ring-primary/40 ${
          open ? 'bg-accent ring-1 ring-primary/40' : ''
        }`}
        aria-label="通知"
      >
        <Bell
          className={`h-5 w-5 transition-transform duration-300 ${
            unread > 0 ? 'dot-pulse' : 'group-hover:rotate-12'
          }`}
        />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold tabular-nums text-destructive-foreground shadow ring-2 ring-background">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* 下拉面板 */}
      {open && (
        <div className="drawer-enter absolute right-0 z-dropdown mt-2 w-80 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold text-foreground">通知</span>
            <span className="text-xs tabular-nums text-muted-foreground">{unread} 条未读</span>
          </div>

          {/* 通知列表 */}
          <div className="max-h-[400px] min-h-0 overflow-y-auto">
            {loadingRecent ? (
              <div className="flex flex-col gap-2.5 px-4 py-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <div className="skeleton-shimmer h-3.5 w-3/4 rounded" />
                      <div className="skeleton-shimmer h-2.5 w-1/3 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recent.length === 0 ? (
              <div className="flex h-24 flex-col items-center justify-center gap-1.5 text-muted-foreground">
                <Bell className="h-7 w-7 opacity-60" />
                <div className="text-xs">暂无通知</div>
              </div>
            ) : (
              recent.map((n) => {
                const link = buildNotificationLink(n)
                return (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => handleClickNotification(n)}
                  className={`flex w-full items-start gap-2.5 border-l-2 px-4 py-2.5 text-left transition-colors hover:bg-accent ${
                    n.is_read
                      ? 'border-transparent'
                      : 'border-l-primary bg-primary/10'
                  }`}
                  title={link ? `点击查看关联资源` : '点击查看通知详情'}
                >
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${getTypeIconCls(n.type)}`}>
                    {getTypeIcon(n.type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1 truncate text-sm font-medium text-foreground">
                        {n.title || '(无标题)'}
                        {link && <ExternalLink className="h-3 w-3 shrink-0 text-primary/70" />}
                      </div>
                      {!n.is_read && (
                        <span className="dot-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      )}
                    </div>
                    <div className="mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" title={fmtAbs(n.created_at)}>
                      {fmtRelative(n.created_at)}
                    </div>
                  </div>
                </button>
                )
              })
            )}
          </div>

          {/* 底部操作 */}
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (!guardNavPermission('notification', 'view', '通知中心')) return
                  setOpen(false)
                  navigate('/notifications')
                }}
                className="rounded px-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
              >
                查看全部
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!guardNavPermission('notification', 'view', '通知中心')) return
                  setOpen(false)
                  navigate('/notifications?tab=prefs')
                }}
                className="rounded px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                title="配置各类型通知的提醒方式"
              >
                提醒设置
              </button>
            </div>
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={unread === 0 || actioning}
              className="btn-secondary btn-sm"
            >
              {actioning ? '处理中...' : '全部标记已读'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default NotificationBell
