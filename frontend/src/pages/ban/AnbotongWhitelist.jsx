import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ShieldCheck, RotateCw, Inbox, Search, X, Plus, Trash2, Loader2, AlertTriangle,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { confirm } from '../../components/ConfirmDialog'
import { Button, PageContainer, PageHeader, Card, DataTable, Badge, CompactSelect } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'
import { splitIPExpression, validateSingleIP, isBanDomain } from '../../utils/ipValidation'

// 设备侧时长（秒，-1 为永久）→ 中文（与安博通黑名单页展示口径一致）
const fmtDeviceDuration = (sec) => {
  if (sec == null || sec === '') return '--'
  const n = Number(sec)
  if (Number.isNaN(n)) return String(sec)
  // 设备对永久条目的 leftTime 返回 uint64 最大值（"无限"），按永久展示
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

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200]
// 页面自动刷新间隔选项（毫秒）；0 = 不自动刷新（仅手动）。交互与黑名单页一致。
const WHITELIST_REFRESH_OPTIONS = [
  { v: 5000, label: '5 秒' },
  { v: 10000, label: '10 秒' },
  { v: 30000, label: '30 秒' },
  { v: 60000, label: '1 分钟' },
  { v: 300000, label: '5 分钟' },
  { v: 0, label: '不自动刷新' },
]
const WHITELIST_REFRESH_STORAGE_KEY = 'soar_whitelist_refresh_ms'
// 读取持久化的刷新间隔（非法/未设置回退默认 5 秒，保持设备 5 秒同步节拍的可见性）
const loadWhitelistRefreshMs = () => {
  const raw = Number(localStorage.getItem(WHITELIST_REFRESH_STORAGE_KEY))
  return WHITELIST_REFRESH_OPTIONS.some((o) => o.v === raw) ? raw : 5000
}
// 有效期预设（秒）：-1 永久，正数上限 30 天（设备限制 1~2592000）
const AGE_PRESETS = [
  { v: '-1', label: '永久' },
  { v: '3600', label: '1 小时' },
  { v: '86400', label: '1 天' },
  { v: '604800', label: '7 天' },
  { v: '2592000', label: '30 天' },
  { v: 'custom', label: '自定义（秒）' },
]
const AGE_MAX = 2592000
// 设备 reason 字段限制 255 字节：按 UTF-8 字节截断（中文占 3 字节），
// 避免字符数未超但字节超限导致提交时被后端拒绝
const REASON_MAX_BYTES = 255
const truncateByBytes = (text, maxBytes) => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = encoder.encode(ch).length
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}
// 白名单条目：仅允许单个 IPv4/IPv6 或域名（不支持 CIDR/范围/通配/MAC）
const invalidWhitelistToken = (token) => {
  if (!token) return true
  return Boolean(validateSingleIP(token)) && !isBanDomain(token)
}

/**
 * 安博通全局白名单（需 ban_workflow:view；增删需 ban_workflow:edit）。
 *
 * - 数据来自后端本地同步表：后台每 5 秒从安博通阻断器拉取，页面按可配置间隔
 *   轮询本地列表 + 顶部展示最近同步时间/耗时/错误；
 * - 支持手动新增（1~100 条，逐条校验后经设备接口实时下发）与单条/批量删除；
 * - 所有增删均写入审计日志，并由后端逐条回传设备执行结果。
 */
export default function AnbotongWhitelist({ embedded = false }) {
  const canView = hasPermission('ban_workflow', 'view')
  const canEdit = hasPermission('ban_workflow', 'edit')

  const [data, setData] = useState({
    items: [], total: 0, page: 1, count: 50, sync: {}, fetched_at: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [enableFilter, setEnableFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState([])
  const [syncing, setSyncing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // 自动刷新间隔（毫秒，0=不自动刷新），持久化到 localStorage（与黑名单页同交互）
  const [refreshMs, setRefreshMs] = useState(loadWhitelistRefreshMs)

  const filtersRef = useRef({ keyword: '', enable: '', page: 1, pageSize: 50 })
  filtersRef.current = { keyword, enable: enableFilter, page, pageSize }
  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const load = useCallback((override = {}) => {
    const p = Math.max(1, override.page ?? filtersRef.current.page)
    const c = Math.max(1, override.pageSize ?? filtersRef.current.pageSize)
    const kw = override.keyword ?? filtersRef.current.keyword
    const en = override.enable ?? filtersRef.current.enable
    const seq = ++seqRef.current
    const alive = () => mountedRef.current && seqRef.current === seq
    setLoading(true)
    banWorkflowApi.anbotongWhitelist({ page: p, count: c, keyword: kw, enable: en })
      .then((res) => {
        if (!alive()) return
        // 删除后当前页可能越界：自动回退到最后一页
        if ((res.items || []).length === 0 && res.total > 0 && p > 1) {
          const last = Math.max(1, Math.ceil(res.total / c))
          setPage(last)
          load({ page: last })
          return
        }
        setData({
          items: res.items || [],
          total: res.total || 0,
          page: res.page || p,
          count: res.count || c,
          sync: res.sync || {},
          fetched_at: res.fetched_at || null,
        })
        setError('')
      })
      .catch((e) => { if (alive()) setError(e.message || '白名单列表加载失败') })
      .finally(() => { if (alive()) setLoading(false) })
  }, [])

  // 首次进入拉取一次当前页（与自动刷新开关无关）
  useEffect(() => {
    if (canView) load({ page: 1 })
  }, [canView, load])
  // 自动刷新：按当前间隔轮询（页面隐藏时暂停请求）；调整间隔只重建 timer，不重置页码
  useEffect(() => {
    if (!canView || !refreshMs) return undefined
    const timer = setInterval(() => {
      if (!document.hidden) load()
    }, refreshMs)
    return () => clearInterval(timer)
  }, [canView, refreshMs, load])

  // 切换自动刷新间隔：立即生效并持久化（0=停止轮询，仅保留手动同步/刷新）
  const changeRefreshMs = (value) => {
    const ms = Number(value)
    setRefreshMs(ms)
    try {
      localStorage.setItem(WHITELIST_REFRESH_STORAGE_KEY, String(ms))
    } catch {
      // 隐私模式等场景写入失败：当前会话内仍生效
    }
  }

  // 关键词防抖过滤；启用状态切换立即生效（首次挂载不重复请求）
  const keywordInitRef = useRef(true)
  useEffect(() => {
    if (!canView) return undefined
    if (keywordInitRef.current) {
      keywordInitRef.current = false
      return undefined
    }
    const timer = setTimeout(() => {
      setPage(1)
      setSelected([])
      load({ page: 1, keyword })
    }, 300)
    return () => clearTimeout(timer)
  }, [keyword, canView, load])

  const changeEnableFilter = (value) => {
    setEnableFilter(value)
    setPage(1)
    setSelected([])
    load({ page: 1, enable: value })
  }
  const gotoPage = (p) => {
    const np = Math.max(1, p)
    setPage(np)
    setSelected([])
    load({ page: np })
  }
  const changePageSize = (value) => {
    const nc = Number(value)
    setPageSize(nc)
    setPage(1)
    setSelected([])
    load({ page: 1, pageSize: nc })
  }
  // 批量选择上限与设备批量接口一致（100 条）
  const handleSelectChange = (keys) => {
    if (keys.length > 100) {
      toast.warning('单次最多选择 100 条，已自动截断')
      setSelected(keys.slice(0, 100))
      return
    }
    setSelected(keys)
  }

  const syncState = data.sync || {}
  const refreshLabel = WHITELIST_REFRESH_OPTIONS.find((o) => o.v === refreshMs)?.label || `${refreshMs / 1000} 秒`
  const syncingNow = syncing
  const doManualSync = () => {
    if (syncingNow) return
    setSyncing(true)
    banWorkflowApi.syncAnbotongWhitelist()
      .then((res) => {
        toast.success(`同步完成：安博通白名单共 ${res.total} 条（耗时 ${res.took_ms ?? '--'}ms）`)
        load()
      })
      .catch((e) => toast.error(e.message || '安博通白名单同步失败'))
      .finally(() => setSyncing(false))
  }

  // ===== 新增 =====
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({
    text: '', age: '-1', customAge: '', enable: '1', reason: '工作台-安博通白名单手动添加',
  })
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [addError, setAddError] = useState('')
  const [addResults, setAddResults] = useState(null)

  const resetAdd = () => {
    setAddForm({
      text: '', age: '-1', customAge: '', enable: '1', reason: '工作台-安博通白名单手动添加',
    })
    setAddError('')
    setAddResults(null)
    setAddSubmitting(false)
  }
  const closeAdd = () => {
    if (addSubmitting) return
    setAddOpen(false)
    resetAdd()
  }

  // 备注字节数（设备 reason 字段限制 255 字节，中文按 UTF-8 计算）
  const addReasonBytes = useMemo(
    () => new TextEncoder().encode(addForm.reason.trim()).length,
    [addForm.reason],
  )

  // 解析新增输入：去重 + 逐条校验（前端先兜底，后端仍会做权威校验）
  const parsedAdd = useMemo(() => {
    const tokens = splitIPExpression(addForm.text)
    const targets = []
    const invalid = []
    const seen = new Set()
    for (const token of tokens) {
      if (invalidWhitelistToken(token)) {
        invalid.push(token)
        continue
      }
      const key = token.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(token)
    }
    return { targets, invalid }
  }, [addForm.text])

  const submitAdd = () => {
    if (addSubmitting) return
    if (!parsedAdd.targets.length) return setAddError('请至少输入一条合法的白名单条目')
    if (parsedAdd.invalid.length) {
      return setAddError(
        `以下条目不是合法的 IP/域名（不支持 CIDR/地址段/MAC）：${parsedAdd.invalid.slice(0, 8).join('、')}${parsedAdd.invalid.length > 8 ? '…' : ''}`,
      )
    }
    if (parsedAdd.targets.length > 100) return setAddError('单次最多新增 100 条')
    const age = addForm.age === 'custom' ? Number(addForm.customAge) : Number(addForm.age)
    if (!Number.isInteger(age) || age === 0 || age < -1 || age > AGE_MAX) {
      return setAddError('有效期必须为 -1（永久）或 1~2592000 秒')
    }
    const reason = addForm.reason.trim()
    if (!reason) return setAddError('请填写添加方式/备注')
    if (/["\\]/.test(reason) || /\n|\r/.test(reason)) {
      return setAddError('备注不能包含英文引号、反斜杠或换行')
    }
    if (new TextEncoder().encode(reason).length > REASON_MAX_BYTES) {
      return setAddError(`备注不能超过 ${REASON_MAX_BYTES} 字节（中文按 3 字节计）`)
    }

    const entries = parsedAdd.targets.map((wlist) => ({
      wlist, age, enable: Number(addForm.enable), reason,
    }))
    setAddSubmitting(true)
    setAddError('')
    setAddResults(null)
    banWorkflowApi.createAnbotongWhitelist(entries)
      .then((res) => {
        const failed = (res.results || []).filter((r) => !r.success)
        if (!failed.length) {
          toast.success(`已新增 ${res.created_count} 条白名单并实时同步至安博通阻断器`)
          setAddOpen(false)
          resetAdd()
          setPage(1)
          load({ page: 1 })
          return
        }
        setAddResults({ created: res.created_count, failed })
        // 成功后端已落库：输入框只保留失败条目，便于修正后重试（避免重复提交 409）
        setAddForm((f) => ({ ...f, text: failed.map((r) => r.wlist).join('\n') }))
        toast.warning(`新增完成：成功 ${res.created_count} 条，失败 ${failed.length} 条`)
        load()
      })
      .catch((e) => setAddError(e.message || '安博通白名单新增失败'))
      .finally(() => setAddSubmitting(false))
  }

  // ===== 删除（单条 / 批量） =====
  const doDelete = async (wlists) => {
    if (!canEdit || deleting || !wlists.length) return
    if (wlists.length > 100) return toast.error('单次最多删除 100 条')
    const preview = wlists.slice(0, 5).join('、')
    const ok = await confirm({
      title: `删除安博通白名单（${wlists.length} 条）`,
      message: `确认从安博通阻断器全局白名单中删除以下条目？${preview}${wlists.length > 5 ? ` 等 ${wlists.length} 条` : ''}。删除后这些对象不再享受白名单豁免，操作会记录操作人与时间。`,
      confirmText: '确认删除',
      variant: 'warning',
    })
    if (!ok) return
    setDeleting(true)
    banWorkflowApi.deleteAnbotongWhitelist(wlists, '工作台-安博通白名单手动删除')
      .then((res) => {
        const failed = (res.results || []).filter((r) => !r.success)
        if (failed.length) {
          toast.warning(`删除完成：成功 ${res.deleted_count} 条，失败 ${failed.length} 条（${failed[0].message || '设备返回失败'}）`)
        } else {
          toast.success(`已删除 ${res.deleted_count} 条白名单并从安博通阻断器移除`)
        }
        setSelected([])
        load()
      })
      .catch((e) => toast.error(e.message || '安博通白名单删除失败'))
      .finally(() => setDeleting(false))
  }

  // ===== 表格列 =====
  const columns = useMemo(() => {
    const base = [
      {
        key: 'wlist', header: '白名单条目', width: '170px',
        render: (r) => <span className="font-mono text-[13px] font-medium">{r.wlist}</span>,
      },
      {
        key: 'age', header: '有效期', width: '110px', numeric: true,
        render: (r) => <span>{fmtDeviceDuration(r.age)}</span>,
      },
      {
        key: 'leftTime', header: '剩余时长', width: '110px', numeric: true,
        render: (r) => <span>{fmtDeviceDuration(r.leftTime)}</span>,
      },
      {
        key: 'effectTime', header: '生效时间', width: '160px',
        render: (r) => (
          <span className="font-mono text-[13px] text-muted-foreground">
            {r.effectTime ? String(r.effectTime).replace('T', ' ').slice(0, 19) : '--'}
          </span>
        ),
      },
      {
        key: 'reason', header: '添加方式', width: '180px',
        render: (r) => <span className="block max-w-[170px] truncate text-muted-foreground" title={r.reason}>{r.reason || '--'}</span>,
      },
      {
        key: 'policy_group_name', header: '策略组', width: '120px',
        render: (r) => <span className="block truncate" title={r.policy_group_name}>{r.policy_group_name || '--'}</span>,
      },
      {
        key: 'state', header: '状态', width: '90px',
        render: (r) => (
          <Badge variant={r.state === 1 || r.state === '1' ? 'success' : 'neutral'}>
            {r.state === 1 || r.state === '1' ? '生效' : '未生效'}
          </Badge>
        ),
      },
      {
        key: 'enable', header: '启用', width: '80px',
        render: (r) => (
          <Badge variant={r.enable === 1 || r.enable === '1' ? 'success' : 'neutral'}>
            {r.enable === 1 || r.enable === '1' ? '启用' : '停用'}
          </Badge>
        ),
      },
      {
        key: 'hit_num', header: '命中次数', width: '90px', numeric: true,
        render: (r) => <span>{r.hit_num ?? '--'}</span>,
      },
      {
        key: 'node_id', header: '节点 ID', width: '110px',
        render: (r) => <span className="block truncate font-mono text-[13px] text-muted-foreground">{r.node_id || '--'}</span>,
      },
    ]
    if (!canEdit) return base
    return [
      ...base,
      {
        key: 'actions', header: '操作', width: '80px', sticky: 'right',
        render: (r) => (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              title={deleting ? '删除中…' : '删除'}
              aria-label={`删除白名单 ${r.wlist}`}
              disabled={deleting}
              onClick={() => doDelete([r.wlist])}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </div>
        ),
      },
    ]
  }, [canEdit, deleting, doDelete])

  const selectedCount = selected.length
  const content = (
    <Card>
      {/* 头部：标题 + 同步状态 ｜ 右侧工具区（立即同步 / 新增 / 批量删除） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="whitespace-nowrap text-sm font-semibold text-foreground">安博通全局白名单</span>
          {syncState.device?.name && <Badge variant="info">{syncState.device.name}</Badge>}
          <Badge variant={syncState.last_error ? 'warning' : 'success'}>
            {syncState.last_error ? '同步异常' : '自动同步中'}
          </Badge>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">自动刷新</span>
          <CompactSelect
            size="sm"
            className="shrink-0"
            value={String(refreshMs)}
            onChange={(e) => changeRefreshMs(e.target.value)}
          >
            {WHITELIST_REFRESH_OPTIONS.map((o) => (
              <option key={o.v} value={String(o.v)}>{o.label}</option>
            ))}
          </CompactSelect>
          {/* 触发设备侧全量同步需要 edit 权限，view 用户不展示入口（避免必然 403） */}
          {canEdit && (
            <Button size="sm" variant="ghost" className="shrink-0" loading={syncingNow} onClick={doManualSync}>
              <RotateCw className="h-3.5 w-3.5" /> 立即同步
            </Button>
          )}
          {canEdit && (
            <>
              <Button
                size="sm" variant="primary" className="shrink-0"
                disabled={deleting}
                onClick={() => { resetAdd(); setAddOpen(true) }}
              >
                <Plus className="h-3.5 w-3.5" /> 新增白名单
              </Button>
              <Button
                size="sm" variant="danger" className="shrink-0"
                disabled={!selectedCount || deleting}
                loading={deleting && Boolean(selectedCount)}
                onClick={() => doDelete(selected)}
              >
                <Trash2 className="h-3.5 w-3.5" /> 批量删除{selectedCount ? `（${selectedCount}）` : ''}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 筛选栏：关键词（条目/备注/策略组）+ 启用状态 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputBaseCls} w-full pl-8 pr-8`}
            placeholder="搜索白名单条目 / 备注 / 策略组"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => setKeyword('')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <CompactSelect size="sm" className="shrink-0" value={enableFilter} onChange={(e) => changeEnableFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="1">仅启用</option>
          <option value="0">仅停用</option>
        </CompactSelect>
      </div>

      {/* 同步状态行：增量 5s / 全量 60s 双节拍 + 耗时 / 错误 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>最近同步：{fmtTime(syncState.last_success_at || syncState.last_sync_at)}</span>
        <span>同步模式：{syncState.mode === 'full' ? '全量校正' : '增量'}（增量 5s / 全量 60s）</span>
        <span>增量同步：{fmtTime(syncState.last_delta_at)}</span>
        <span>全量校正：{fmtTime(syncState.last_full_at)}</span>
        <span>同步耗时：{syncState.took_ms != null ? `${syncState.took_ms}ms` : '--'}</span>
        <span>设备条目：{syncState.total != null ? `${syncState.total} 条` : '--'}</span>
        <span>页面更新：{fmtTime(data.fetched_at)}</span>
        <span>自动刷新：{refreshMs ? `每 ${refreshLabel}` : '已暂停'}</span>
        {syncState.last_error && (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" /> {syncState.last_error}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600">
          白名单列表加载失败：{error}（将自动重试）
        </div>
      )}

      {/* 表格主体 */}
      <div className="mt-3">
        <DataTable
          columns={columns}
          data={data.items}
          loading={loading && !data.items.length}
          rowKey="wlist"
          selectable={canEdit}
          selectedKeys={selected}
          onSelectChange={handleSelectChange}
          stickyHeader
          maxHeight="26rem"
          emptyText={keyword || enableFilter ? '没有符合筛选条件的白名单' : '安博通全局白名单为空'}
          emptyDescription={
            keyword || enableFilter
              ? '请调整搜索关键词或状态筛选后重试'
              : '设备全局白名单当前没有条目，可点击「新增白名单」手动添加'
          }
          emptyIcon={Inbox}
        />
      </div>

      {/* 分页栏：左侧总页数/总条数，右侧每页条数与翻页（与黑名单页一致） */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          第 {page} / {Math.max(1, Math.ceil(data.total / pageSize))} 页 · 共 {data.total} 条
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">每页</span>
            <CompactSelect size="sm" className="shrink-0" value={String(pageSize)} onChange={(e) => changePageSize(e.target.value)}>
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={String(n)}>{n} 条</option>)}
            </CompactSelect>
          </div>
          <Button size="sm" variant="ghost" className="shrink-0" disabled={page <= 1 || loading} onClick={() => gotoPage(page - 1)}>
            上一页
          </Button>
          <Button size="sm" variant="ghost" className="shrink-0" disabled={page * pageSize >= data.total || loading} onClick={() => gotoPage(page + 1)}>
            下一页
          </Button>
        </div>
      </div>

      {/* 新增弹窗 */}
      <Modal
        open={addOpen}
        title="新增安博通白名单"
        onClose={closeAdd}
        maxWidth="max-w-2xl"
        footer={(
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">提交后实时下发至安博通阻断器并记录操作日志</span>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={closeAdd} disabled={addSubmitting}>取消</Button>
              <Button size="sm" loading={addSubmitting} onClick={submitAdd}>
                {addSubmitting
                  ? '下发中…'
                  : `下发并保存${parsedAdd.targets.length ? `（${parsedAdd.targets.length}）` : ''}`}
              </Button>
            </div>
          </div>
        )}
      >
        <div className="space-y-5">
          {/* 条目输入 */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="wl-add-text" className="text-[13px] font-medium text-foreground">
                白名单条目 <span className="text-destructive">*</span>
              </label>
              <div className="flex items-center gap-2 text-[11px] tabular-nums">
                <span className={parsedAdd.targets.length > 100 ? 'text-destructive' : 'text-muted-foreground'}>
                  {parsedAdd.targets.length} / 100 条
                </span>
                {parsedAdd.invalid.length > 0 && (
                  <span className="text-destructive">非法 {parsedAdd.invalid.length} 条</span>
                )}
              </div>
            </div>
            <textarea
              id="wl-add-text"
              className={`${inputBaseCls} min-h-[132px] w-full resize-y font-mono text-[13px] leading-relaxed ${parsedAdd.invalid.length ? '!border-destructive' : ''}`}
              placeholder={'每行一条，或用逗号/空格分隔，例如：\n192.0.2.10\n2001:db8::10\ntrusted.example.com'}
              value={addForm.text}
              onChange={(e) => setAddForm((f) => ({ ...f, text: e.target.value }))}
              disabled={addSubmitting}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              仅支持单个 IPv4/IPv6 或 ASCII 域名；不支持 CIDR、地址段、通配与 MAC。重复条目自动去重。
            </p>
            {parsedAdd.invalid.length > 0 ? (
              <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-all">
                  无法识别：{parsedAdd.invalid.slice(0, 8).join('、')}
                  {parsedAdd.invalid.length > 8 ? ` 等 ${parsedAdd.invalid.length} 条` : ''}
                </span>
              </div>
            ) : parsedAdd.targets.length > 0 ? (
              <p className="text-xs text-emerald-600">格式校验通过，将新增 {parsedAdd.targets.length} 条白名单</p>
            ) : null}
          </section>

          {/* 下发参数：移动端纵向堆叠，≥640px 三列对齐 */}
          <section className="rounded-lg border border-border bg-muted/40 p-3 sm:p-4">
            <div className="mb-3 text-[13px] font-medium text-foreground">下发参数</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <div className="min-w-0">
                <label className="mb-1 block text-xs font-medium text-foreground">
                  有效期 <span className="text-destructive">*</span>
                </label>
                <CompactSelect
                  className="w-full"
                  value={addForm.age}
                  onChange={(e) => setAddForm((f) => ({ ...f, age: e.target.value }))}
                  disabled={addSubmitting}
                >
                  {AGE_PRESETS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </CompactSelect>
                {addForm.age === 'custom' && (
                  <input
                    type="number"
                    min={1}
                    max={AGE_MAX}
                    step={1}
                    className={`${inputBaseCls} mt-2 w-full`}
                    placeholder="1~2592000 秒"
                    value={addForm.customAge}
                    onChange={(e) => setAddForm((f) => ({ ...f, customAge: e.target.value }))}
                    disabled={addSubmitting}
                  />
                )}
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">永久 -1；自定义 1~2592000 秒</p>
              </div>
              <div className="min-w-0">
                <label className="mb-1 block text-xs font-medium text-foreground">启用状态</label>
                <CompactSelect
                  className="w-full"
                  value={addForm.enable}
                  onChange={(e) => setAddForm((f) => ({ ...f, enable: e.target.value }))}
                  disabled={addSubmitting}
                >
                  <option value="1">启用</option>
                  <option value="0">停用</option>
                </CompactSelect>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">停用条目不参与封禁匹配</p>
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label htmlFor="wl-add-reason" className="text-xs font-medium text-foreground">
                    添加方式/备注 <span className="text-destructive">*</span>
                  </label>
                  <span className={`shrink-0 text-[11px] tabular-nums ${addReasonBytes > REASON_MAX_BYTES ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {addReasonBytes}/{REASON_MAX_BYTES}
                  </span>
                </div>
                <input
                  id="wl-add-reason"
                  className={`${inputBaseCls} w-full`}
                  value={addForm.reason}
                  onChange={(e) => setAddForm((f) => ({
                    ...f,
                    reason: truncateByBytes(e.target.value, REASON_MAX_BYTES),
                  }))}
                  disabled={addSubmitting}
                />
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">写入设备 reason 字段，不含英文引号/反斜杠</p>
              </div>
            </div>
          </section>

          {addError && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-all">{addError}</span>
            </div>
          )}
          {addResults && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700">
              <div className="font-medium">部分条目下发失败（成功 {addResults.created} 条）：</div>
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs">
                {addResults.failed.map((r) => (
                  <li key={r.wlist}>{r.wlist}：{r.message || `HTTP ${r.status}`}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </Card>
  )

  if (embedded) return content
  return (
    <PageContainer>
      <PageHeader
        title="安博通白名单"
        description="安博通阻断器全局白名单：每 5 秒自动同步设备数据，支持手动新增与批量删除，保障封禁预检准确"
        actions={(
          <Button size="sm" variant="ghost" loading={loading} onClick={() => load()}>
            <RotateCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        )}
      />
      {content}
    </PageContainer>
  )
}
