import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ShieldBan, RotateCw, Inbox, Search, X, LockOpen, Loader2 } from 'lucide-react'
import { toast } from '../../store/toastStore'
import { confirm } from '../../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, Card, DataTable, Badge, CompactSelect } from '../../components/ui'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'
import { validateSingleIP } from '../../utils/ipValidation'

// 设备侧时长（秒，-1 为永久）→ 中文
const fmtDeviceDuration = (sec) => {
  if (sec == null || sec === '') return '--'
  const n = Number(sec)
  if (Number.isNaN(n)) return String(sec)
  // 设备对永久条目的 leftTime 返回 uint64 最大值（18446744073709551615，即"无限"）：
  // 超过 1e12 秒（约 3 万年）按永久展示，避免换算出天文数字
  if (n < 0 || n > 1e12) return '永久'
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分钟`
  return '不足1分钟'
}
const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')

// 安博通黑名单自动刷新间隔选项（毫秒）；0 = 不自动刷新（仅手动）
const BLACKLIST_REFRESH_OPTIONS = [
  { v: 10000, label: '10 秒' },
  { v: 30000, label: '30 秒' },
  { v: 60000, label: '1 分钟' },
  { v: 300000, label: '5 分钟' },
  { v: 0, label: '不自动刷新' },
]
const BLACKLIST_REFRESH_STORAGE_KEY = 'soar_blacklist_refresh_ms'
// 读取持久化的刷新间隔（非法/未设置回退默认 30 秒）
const loadBlacklistRefreshMs = () => {
  const raw = Number(localStorage.getItem(BLACKLIST_REFRESH_STORAGE_KEY))
  return BLACKLIST_REFRESH_OPTIONS.some((o) => o.v === raw) ? raw : 30000
}
// 安博通黑名单每页条数选项与持久化（非法/未设置回退默认 50）
const BLACKLIST_PAGE_SIZE_OPTIONS = [20, 50, 100, 200]
const BLACKLIST_PAGE_SIZE_STORAGE_KEY = 'soar_blacklist_page_size'
const loadBlacklistPageSize = () => {
  const raw = Number(localStorage.getItem(BLACKLIST_PAGE_SIZE_STORAGE_KEY))
  return BLACKLIST_PAGE_SIZE_OPTIONS.includes(raw) ? raw : 50
}

// 安博通黑名单面板列（展示设备返回的全部字段；未知新字段可后续追加）
// 数值语义列（时长/剩余/命中次数）按设计系统规范右对齐（col.numeric）
const blacklistColumns = [
  { key: 'blist', header: '黑名单条目', width: '170px', render: (r) => <span className="font-mono text-[13px] font-medium">{r.blist}</span> },
  { key: 'age', header: '封禁时长', width: '110px', numeric: true, render: (r) => <span>{fmtDeviceDuration(r.age)}</span> },
  { key: 'leftTime', header: '剩余时长', width: '110px', numeric: true, render: (r) => <span>{fmtDeviceDuration(r.leftTime)}</span> },
  { key: 'effectTime', header: '生效时间', width: '160px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{r.effectTime != null && r.effectTime !== '' ? String(r.effectTime).replace('T', ' ').slice(0, 19) : '--'}</span> },
  { key: 'reason', header: '封禁原因', width: '180px', render: (r) => <span className="block max-w-[170px] truncate text-muted-foreground" title={r.reason}>{r.reason || '--'}</span> },
  { key: 'policy_group_name', header: '策略组', width: '120px', render: (r) => <span>{r.policy_group_name || '--'}</span> },
  { key: 'state', header: '状态', width: '90px', render: (r) => <span>{r.state ?? '--'}</span> },
  { key: 'enable', header: '启用', width: '80px', render: (r) => <Badge variant={r.enable === 1 || r.enable === '1' ? 'success' : 'neutral'}>{r.enable === 1 || r.enable === '1' ? '启用' : '停用'}</Badge> },
  { key: 'hit_num', header: '命中次数', width: '90px', numeric: true, render: (r) => <span>{r.hit_num ?? '--'}</span> },
  { key: 'node_id', header: '节点 ID', width: '110px', render: (r) => <span className="font-mono text-[13px] text-muted-foreground">{r.node_id ?? '--'}</span> },
]

/**
 * 安博通黑名单（设备实时，需 ban_workflow:view）：从封禁工作台拆出的独立 Tab 页。
 * 分页拉取 + 自动刷新间隔可调 + 单个 IP 精确查询（设备「查询指定黑名单」，
 * 404 = 未封禁属业务结果，异常按 502 报错）。
 */
export default function AnbotongBlacklist({ embedded = false }) {
  const canView = hasPermission('ban_workflow', 'view')
  // 安博通黑名单（设备实时，分页）：需 ban_workflow:view（端点已按权限矩阵校验；
  // 无权限轮询会 403 且 client.js 对 403 全局 toast，必须避免）
  const [blacklist, setBlacklist] = useState({
    device: null, page: 1, count: 50, page_full: false, paginated: true,
    items: [], note: '', fetched_at: null,
  })
  const [blacklistLoading, setBlacklistLoading] = useState(false)
  const [blacklistError, setBlacklistError] = useState('')
  // 自动刷新间隔（毫秒，0 = 不自动）：localStorage 持久化，切换后立即生效并刷新一次
  const [blacklistRefreshMs, setBlacklistRefreshMs] = useState(loadBlacklistRefreshMs)
  // 分页：页码 + 每页条数（localStorage 持久化）；ref 供无参刷新（轮询/手动）复用当前页
  const [blacklistPage, setBlacklistPage] = useState(1)
  const [blacklistPageSize, setBlacklistPageSize] = useState(loadBlacklistPageSize)
  const blPageRef = useRef(1)
  const blPageSizeRef = useRef(loadBlacklistPageSize())
  const blSeq = useRef(0)
  const blMounted = useRef(true)
  useEffect(() => () => { blMounted.current = false }, [])
  // 总条数统计：设备列表接口不返回 total，由后端全量计数（缓存 60 秒）
  const [blTotal, setBlTotal] = useState({ total: null, loading: false, error: '', fetchedAt: null })
  const blTotalSeq = useRef(0)
  const blTotalInFlight = useRef(false)
  const loadBlacklistTotal = useCallback(() => {
    if (blTotalInFlight.current) return // 避免自动刷新与手动重试并发触发全量统计
    blTotalInFlight.current = true
    const seq = ++blTotalSeq.current
    setBlTotal((s) => ({ ...s, loading: true }))
    banWorkflowApi.anbotongBlacklistCount()
      .then((res) => {
        if (!blMounted.current || seq !== blTotalSeq.current) return
        setBlTotal({
          total: res.total ?? null, loading: false, error: '', fetchedAt: res.fetched_at || null,
        })
      })
      .catch((e) => {
        if (!blMounted.current || seq !== blTotalSeq.current) return
        setBlTotal({ total: null, loading: false, error: e.message || '总条数统计失败', fetchedAt: null })
      })
      .finally(() => { blTotalInFlight.current = false })
  }, [])
  const loadBlacklist = useCallback((pageArg, countArg) => {
    const p = Math.max(1, pageArg ?? blPageRef.current)
    const c = Math.max(1, countArg ?? blPageSizeRef.current)
    blPageRef.current = p
    blPageSizeRef.current = c
    const seq = ++blSeq.current
    const ok = () => blMounted.current && blSeq.current === seq
    setBlacklistLoading(true)
    banWorkflowApi.anbotongBlacklist(p, c)
      .then((res) => {
        if (!ok()) return
        setBlacklist({
          device: res.device, page: res.page || p, count: res.count || c,
          page_full: Boolean(res.page_full), paginated: res.paginated !== false,
          items: res.items || [], note: res.note || '', fetched_at: res.fetched_at,
        })
        setBlacklistError('')
      })
      .catch((e) => { if (ok()) setBlacklistError(e.message || '安博通黑名单拉取失败') })
      .finally(() => { if (ok()) setBlacklistLoading(false) })
  }, [])
  // 翻页 / 调整每页条数（调整页大小回到第 1 页，避免停留在越界页码）
  const gotoBlacklistPage = (p) => {
    const np = Math.max(1, p)
    setBlacklistPage(np)
    loadBlacklist(np)
  }
  const changeBlacklistPageSize = (value) => {
    const nc = Number(value)
    setBlacklistPageSize(nc)
    setBlacklistPage(1)
    loadBlacklist(1, nc)
    try { localStorage.setItem(BLACKLIST_PAGE_SIZE_STORAGE_KEY, String(nc)) } catch { /* 隐私模式等写入失败可忽略 */ }
  }
  // 初始加载：有查看权限进入即拉一次当前数据（与自动刷新开关无关）
  useEffect(() => {
    if (!canView) return
    loadBlacklist()
    loadBlacklistTotal()
  }, [canView, loadBlacklist, loadBlacklistTotal])
  // 自动刷新：按当前间隔轮询当前页 + 总条数（后端缓存，不会每次扫设备）；
  // 调整间隔时重建 timer，embedded 卸载（切 Tab）清理
  useEffect(() => {
    if (!canView || !blacklistRefreshMs) return undefined
    const timer = setInterval(() => {
      loadBlacklist()
      loadBlacklistTotal()
    }, blacklistRefreshMs)
    return () => clearInterval(timer)
  }, [canView, blacklistRefreshMs, loadBlacklist, loadBlacklistTotal])
  const changeBlacklistRefresh = (value) => {
    const ms = Number(value)
    setBlacklistRefreshMs(ms)
    try { localStorage.setItem(BLACKLIST_REFRESH_STORAGE_KEY, String(ms)) } catch { /* 隐私模式等写入失败可忽略 */ }
  }

  // IP 精确查询（设备「查询指定黑名单」）：查询后面板切换为单条结果模式，
  // null = 列表模式；设备对不存在的条目返回 404，后端已归一为 found=false 业务结果
  const [blQueryIp, setBlQueryIp] = useState('')
  const [blQuery, setBlQuery] = useState(null)
  const [blQueryLoading, setBlQueryLoading] = useState(false)
  const runBlacklistQuery = () => {
    const target = blQueryIp.trim()
    const ipErr = validateSingleIP(target, '查询 IP')
    if (ipErr) return toast.error(ipErr)
    setBlQueryLoading(true)
    banWorkflowApi.anbotongBlacklistQuery(target)
      .then((res) => setBlQuery(res))
      .catch((e) => toast.error(e.message || '安博通黑名单查询失败'))
      .finally(() => setBlQueryLoading(false))
  }
  const clearBlacklistQuery = () => {
    setBlQuery(null)
    setBlQueryIp('')
  }

  // 行内解封（需 ban_workflow:edit）：二次确认 → 设备解封 → 刷新列表
  const canEdit = hasPermission('ban_workflow', 'edit')
  const [unbanningIp, setUnbanningIp] = useState('')
  const doUnban = useCallback(async (row) => {
    const ip = String(row?.blist || '').trim()
    if (!ip || unbanningIp) return
    const ok = await confirm({
      title: `解封 IP ${ip}`,
      message: `确认将 ${ip} 从安博通阻断器黑名单中移除？解封后该 IP 立即恢复访问；平台侧该 IP 生效中的封禁记录将同步置为已解封。操作会记录操作人与时间。`,
      confirmText: '确认解封',
      variant: 'warning',
    })
    if (!ok) return
    setUnbanningIp(ip)
    banWorkflowApi.unbanAnbotongBlacklist(ip, '工作台-安博通黑名单手动解封')
      .then((res) => {
        toast.success(res?.already_absent
          ? `IP ${ip} 已不在黑名单中，已按解封处理`
          : `IP ${ip} 已解封（已从安博通阻断器黑名单移除）`)
        // 刷新当前页黑名单，更新设备侧数据状态
        loadBlacklist()
        // 条目已从设备移除：同步刷新总条数（后端已失效统计缓存）
        loadBlacklistTotal()
        // 单条查询模式下同步刷新该条结果（解封后应变更为「不在黑名单中」）
        // 后端返回的 ip 已归一化为小写域名，这里忽略大小写比较，避免大写域名不刷新
        if (blQuery && String(blQuery.ip || '').toLowerCase() === ip.toLowerCase()) {
          banWorkflowApi.anbotongBlacklistQuery(ip).then(setBlQuery).catch(() => {})
        }
      })
      .catch((e) => toast.error(e.message || '解封失败，列表数据保持不变'))
      .finally(() => setUnbanningIp(''))
  }, [unbanningIp, blQuery, loadBlacklist, loadBlacklistTotal])

  // 列表列：末尾追加解封操作（冻结右侧，与封禁工作台操作列同风格）
  const columns = useMemo(() => {
    if (!canEdit) return blacklistColumns
    return [
      ...blacklistColumns,
      {
        key: 'actions', header: '操作', width: '80px', sticky: 'right',
        render: (r) => (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-success disabled:cursor-not-allowed disabled:opacity-50"
              title={unbanningIp ? '解封中…' : '解封'}
              aria-label={`解封 IP ${r.blist}`}
              disabled={Boolean(unbanningIp)}
              onClick={() => doUnban(r)}
            >
              {unbanningIp === r.blist
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <LockOpen className="h-4 w-4" />}
            </button>
          </div>
        ),
      },
    ]
  }, [canEdit, unbanningIp, doUnban])

  // 总页数（总条数未知时降级为按 page_full 判断下一页）
  const blTotalPages = blTotal.total != null
    ? Math.max(1, Math.ceil(blTotal.total / blacklistPageSize))
    : null

  const content = (
    <Card>
      {/* 头部：标题 + 设备标识 ｜ 右侧工具区（自动刷新 + 立即刷新，均次级操作用 ghost） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <ShieldBan className="h-4 w-4 text-primary" />
          <span className="whitespace-nowrap text-sm font-semibold text-foreground">安博通黑名单（设备实时）</span>
          {blacklist.device && (
            <Badge variant="info">{blacklist.device.name}</Badge>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">自动刷新</span>
          <CompactSelect
            size="sm"
            className="shrink-0"
            value={String(blacklistRefreshMs)}
            onChange={(e) => changeBlacklistRefresh(e.target.value)}
          >
            {BLACKLIST_REFRESH_OPTIONS.map((o) => (
              <option key={o.v} value={String(o.v)}>{o.label}</option>
            ))}
          </CompactSelect>
          <Button size="sm" variant="ghost" className="shrink-0" loading={blacklistLoading} onClick={() => loadBlacklist()}>
            <RotateCw className="h-3.5 w-3.5" /> 立即刷新
          </Button>
        </div>
      </div>
      {/* 筛选栏：IP 精确查询为本区域唯一主操作；查询模式提供返回列表出口 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputBaseCls} w-full pl-8 pr-8`}
            placeholder="输入 IP 查询是否在黑名单中"
            value={blQueryIp}
            onChange={(e) => setBlQueryIp(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !blQueryLoading) runBlacklistQuery() }}
          />
          {blQueryIp && (
            <button
              type="button"
              aria-label="清空查询 IP"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => setBlQueryIp('')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button size="sm" className="shrink-0" loading={blQueryLoading} onClick={runBlacklistQuery}>
          <Search className="h-3.5 w-3.5" /> 查询
        </Button>
        {blQuery && (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={clearBlacklistQuery}>
            清除查询，返回列表
          </Button>
        )}
      </div>
      {/* 次级统计信息（弱化层级，不与标题/操作抢视觉重心） */}
      <div className="mt-2 text-xs text-muted-foreground">
        {blacklist.paginated
          ? `本页 ${blacklist.items.length} 条${blacklist.page_full ? '' : ' · 已到末页'}`
          : `共 ${blacklist.items.length} 条`}
        {' · '}更新于 {fmtTime(blacklist.fetched_at)}
        {blacklistRefreshMs
          ? ` · 每 ${BLACKLIST_REFRESH_OPTIONS.find((o) => o.v === blacklistRefreshMs)?.label || `${blacklistRefreshMs / 1000} 秒`}自动刷新`
          : ' · 已暂停自动刷新'}
      </div>
      {/* 三态横幅：拉取失败 / 查询结果 / 分页越界提示（浅底深字） */}
      {blacklistError && (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600">
          拉取失败：{blacklistError}{blacklistRefreshMs ? '（将自动重试）' : ''}
        </div>
      )}
      {blQuery && (
        <div className={`mt-2 rounded-md border px-3 py-2 text-[13px] ${blQuery.found ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-amber-500/30 bg-amber-500/10 text-amber-600'}`}>
          {blQuery.found
            ? `已在安博通黑名单中找到 ${blQuery.ip}（更新于 ${fmtTime(blQuery.fetched_at)}），下方为该条目详情`
            : `${blQuery.ip} 不在安博通黑名单中（更新于 ${fmtTime(blQuery.fetched_at)}）`}
          {blQuery.note ? ` · ${blQuery.note}` : ''}
        </div>
      )}
      {!blQuery && blacklist.note && (
        <div className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[13px] text-blue-600">
          {blacklist.note}（请返回上一页）
        </div>
      )}
      {/* 表格主体：列表页主体区，独立横滚 + 给足纵向扫读空间（不再双重限高） */}
      <div className="mt-3">
        <DataTable
          columns={columns}
          data={blQuery ? (blQuery.found && blQuery.entry ? [blQuery.entry] : []) : blacklist.items}
          loading={blQuery ? blQueryLoading : (blacklistLoading && !blacklist.items.length)}
          rowKey="blist"
          selectable={false}
          maxHeight="26rem"
          emptyText={blQuery ? '未查到：该 IP 不在黑名单中' : (blacklist.page > 1 ? '本页无数据' : '设备黑名单为空')}
          emptyDescription={blQuery ? '设备返回 404，黑名单中没有该 IP 的条目' : (blacklist.page > 1 ? '该页码已超出设备黑名单范围，请返回上一页' : '安博通阻断器上当前没有任何黑名单条目')}
          emptyIcon={Inbox}
        />
      </div>
      {/* 底部分页栏：左侧总页数/总条数，右侧每页条数与翻页；查询模式隐藏，避免与单条详情混淆 */}
      {blacklist.paginated && !blQuery && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {blTotal.total != null
              ? `第 ${blacklistPage} / ${blTotalPages} 页 · 共 ${blTotal.total} 条`
              : blTotal.loading
                ? `第 ${blacklistPage} 页 · 总条数统计中…`
                : `第 ${blacklistPage} 页 · 总条数暂不可用`}
            {!blTotal.loading && blTotal.error && (
              <button
                type="button"
                className="ml-1 text-primary transition hover:underline"
                onClick={loadBlacklistTotal}
              >
                重试
              </button>
            )}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">每页</span>
              {/* 不指定宽度：CompactSelect sm 触发器自带 min-w，外层窄于内部
                  min-width 时按钮会溢出容器、与右侧按钮重叠 */}
              <CompactSelect
                size="sm"
                className="shrink-0"
                value={String(blacklistPageSize)}
                onChange={(e) => changeBlacklistPageSize(e.target.value)}
              >
                {BLACKLIST_PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={String(n)}>{n} 条</option>
                ))}
              </CompactSelect>
            </div>
            <Button
              size="sm" variant="ghost" className="shrink-0"
              disabled={blacklistPage <= 1 || blacklistLoading}
              onClick={() => gotoBlacklistPage(blacklistPage - 1)}
            >
              上一页
            </Button>
            <Button
              size="sm" variant="ghost" className="shrink-0"
              disabled={
                (blTotalPages != null ? blacklistPage >= blTotalPages : !blacklist.page_full)
                || blacklistLoading
              }
              onClick={() => gotoBlacklistPage(blacklistPage + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </Card>
  )

  if (embedded) return content
  return (
    <PageContainer>
      <PageHeader
        title="安博通黑名单"
        description="安博通阻断器设备侧实时黑名单：分页浏览 + 单个 IP 精确查询（404 = 未封禁）"
        actions={(
          <Button size="sm" variant="ghost" loading={blacklistLoading} onClick={() => loadBlacklist()}>
            <RotateCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        )}
      />
      {content}
    </PageContainer>
  )
}
