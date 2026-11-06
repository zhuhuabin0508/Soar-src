// 工单暂停策略配置页：全局时效/提醒/兜底分组 + 各暂停分类的时效、提醒阈值、到期处置与可见性
// - 单次/累计暂停上限、暂停次数、批量上限、到期前提醒分钟数
// - 分类策略：启用、单次上限、可操作角色、是否必须填写期望恢复时间、提醒百分比、到期处置、原因可见性、是否允许批量
// - 到期处置选「自动关闭」仅对重复工单生效，保存时同步 auto_close 标记
import { useCallback, useEffect, useState } from 'react'
import { PauseCircle, RotateCcw, RefreshCw } from 'lucide-react'
import { toast } from '../store/toastStore'
import { inputCls, labelCls, hintCls } from '../components/property/FormControls'
import { Button, PageContainer, CompactSelect, EmptyState } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import ticketApi from '../api/tickets'

const TIMEOUT_POLICIES = [
  ['auto_resume', '到期自动恢复'],
  ['auto_resume_escalate', '自动恢复并升级'],
  ['auto_transfer', '自动转办至兜底分组'],
  ['auto_close', '自动关闭（仅重复工单）'],
]
const REASON_VISIBILITIES = [
  ['participants', '处理参与人可见'],
  ['internal', '仅处理组与管理员可见'],
]
const PAUSE_ROLES = [
  ['handler', '处理人'],
  ['creator', '发起人'],
  ['admin', '管理员'],
]
const PAUSE_TYPE_ORDER = [
  'pending_info', 'external_coop', 'user_feedback', 'business_window', 'duplicate_merge', 'other',
]

// 分钟数 → 可读时长
const fmtMinutes = (m) => {
  const n = Number(m)
  if (!Number.isFinite(n) || n <= 0) return '--'
  if (n < 60) return `${n} 分钟`
  const h = Math.floor(n / 60)
  const r = n % 60
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`
}

// 解析提醒阈值文本："50, 80" → [50, 80]；非 1-99、非升序或重复均视为非法（返回 null）
const parsePercents = (text) => {
  const nums = String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n <= 0 || n >= 100)) return null
  const sorted = [...new Set(nums)].sort((a, b) => a - b)
  return sorted.length === nums.length ? nums : null
}

export default function TicketPauseConfig() {
  const canEdit = hasPermission('ticket_config', 'edit')
  const [config, setConfig] = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [groups, setGroups] = useState([])
  // 提醒阈值输入过程中的原始文本（"50," 这类中间态不写回配置，保存时统一解析）
  const [remindText, setRemindText] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      ticketApi.getPauseConfig(),
      ticketApi.listGroups().catch(() => ({ items: [] })),
    ])
      .then(([cfg, groupRes]) => {
        setConfig(cfg || {})
        setDefaults(cfg || {})
        setGroups(groupRes.items || groupRes || [])
        setRemindText(Object.fromEntries(
          Object.entries(cfg?.types || {}).map(([code, item]) => [
            code, (item.remind_percents || []).join(','),
          ]),
        ))
      })
      .catch((e) => toast.error(e.message || '加载暂停策略失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const patch = (key, value) => setConfig((c) => ({ ...c, [key]: value }))
  const patchType = (code, key, value) => setConfig((c) => ({
    ...c,
    types: { ...(c.types || {}), [code]: { ...((c.types || {})[code] || {}), [key]: value } },
  }))

  // 数字输入：留空保留原值；非法输入不写入
  const numberValue = (v) => (v === '' || v === null || v === undefined ? '' : Number(v))
  const setNumber = (setter, key, raw) => {
    if (raw === '') { setter(key, ''); return }
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) setter(key, Math.floor(n))
  }

  const toggleRole = (code, role, checked) => {
    const current = (config?.types?.[code]?.allow_roles) || []
    const next = checked ? [...current, role] : current.filter((r) => r !== role)
    patchType(code, 'allow_roles', PAUSE_ROLES.map(([k]) => k).filter((k) => next.includes(k)))
  }

  const handleReset = () => {
    if (!defaults) return
    setConfig(structuredClone(defaults))
    setRemindText(Object.fromEntries(
      Object.entries(defaults.types || {}).map(([code, item]) => [
        code, (item.remind_percents || []).join(','),
      ]),
    ))
  }

  const handleSave = () => {
    if (!config) return
    const numericKeys = ['max_pause_minutes', 'max_total_pause_minutes', 'max_pause_count', 'max_batch_size', 'remind_before_expire_minutes']
    for (const key of numericKeys) {
      if (config[key] === '' || config[key] === null || config[key] === undefined) {
        return toast.error('全局时效均为必填正整数')
      }
      if (!(Number(config[key]) > 0)) {
        return toast.error('全局时效均需大于 0')
      }
    }
    if (Number(config.max_total_pause_minutes) < Number(config.max_pause_minutes)) {
      return toast.error('累计暂停上限不能小于单次暂停上限')
    }
    if (Number(config.remind_before_expire_minutes) > Number(config.max_pause_minutes)) {
      return toast.error('到期前提醒时长不能超过单次暂停上限')
    }
    if (Number(config.max_pause_count) > 100) {
      return toast.error('单工单暂停次数上限不能超过 100')
    }
    if (Number(config.max_batch_size) > 500) {
      return toast.error('批量操作上限不能超过 500')
    }
    for (const code of PAUSE_TYPE_ORDER) {
      const item = config.types?.[code]
      if (!item) continue
      if (item.max_minutes === '' || item.max_minutes === null || item.max_minutes === undefined) {
        return toast.error(`「${item.label || code}」的单次上限不能为空`)
      }
      if (!(Number(item.max_minutes) > 0)) {
        return toast.error(`「${item.label || code}」的单次上限必须大于 0`)
      }
      if (Number(item.max_minutes) > Number(config.max_pause_minutes)) {
        return toast.error(`「${item.label || code}」的单次上限不能超过全局单次上限`)
      }
      if (!(item.allow_roles || []).length) {
        return toast.error(`「${item.label || code}」至少选择一个可操作角色`)
      }
      const percents = parsePercents(remindText[code])
      if (!percents) {
        return toast.error(`「${item.label || code}」提醒阈值需为 1-99 的升序数字，如 50,80`)
      }
    }
    // 到期处置为自动关闭时，同步 auto_close 标记（后端两者需同时满足）
    const types = {}
    for (const [code, item] of Object.entries(config.types || {})) {
      types[code] = {
        ...item,
        remind_percents: parsePercents(remindText[code]) || item.remind_percents,
        auto_close: item.timeout_policy === 'auto_close',
      }
    }
    setSaving(true)
    ticketApi.updatePauseConfig({ ...config, types })
      .then((res) => {
        setConfig(res)
        setDefaults(res)
        setRemindText(Object.fromEntries(
          Object.entries(res?.types || {}).map(([code, item]) => [
            code, (item.remind_percents || []).join(','),
          ]),
        ))
        toast.success('暂停策略已保存')
      })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">暂停策略配置</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            设定工单暂停的时效上限、到期提醒与超时处置；暂停期间 SLA 与节点停留计时冻结，到期未恢复将按策略自动处置。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新暂停策略">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
          {canEdit && config && (
            <>
              <Button variant="secondary" size="sm" onClick={handleReset}
                title="撤销未保存的修改，回滚到最近加载/保存的配置">
                <RotateCcw className="mr-1 h-3.5 w-3.5" />撤销修改
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
                保存配置
              </Button>
            </>
          )}
        </div>
      </div>

      {!config && !loading ? (
        <EmptyState
          icon={PauseCircle}
          title="暂无暂停策略数据"
          description="请刷新页面重试，或联系管理员检查服务端配置"
        />
      ) : (
        <div className="space-y-5">
          {/* 全局策略 */}
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">全局策略</h2>
              <label className="inline-flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" disabled={!canEdit} className="h-4 w-4 accent-primary"
                  checked={!!config?.enabled}
                  onChange={(e) => patch('enabled', e.target.checked)} />
                启用工单暂停功能
              </label>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className={labelCls}>单次暂停上限（分钟）</label>
                <input type="number" min="1" disabled={!canEdit} className={`${inputCls} tabular-nums`}
                  value={config?.max_pause_minutes ?? ''}
                  onChange={(e) => setNumber(patch, 'max_pause_minutes', e.target.value)} />
                <p className={hintCls}>{fmtMinutes(config?.max_pause_minutes)}</p>
              </div>
              <div>
                <label className={labelCls}>累计暂停上限（分钟）</label>
                <input type="number"
                  min={Number(config?.max_pause_minutes) > 0 ? Number(config.max_pause_minutes) : 1}
                  disabled={!canEdit} className={`${inputCls} tabular-nums`}
                  value={config?.max_total_pause_minutes ?? ''}
                  onChange={(e) => setNumber(patch, 'max_total_pause_minutes', e.target.value)} />
                <p className={hintCls}>{fmtMinutes(config?.max_total_pause_minutes)}</p>
              </div>
              <div>
                <label className={labelCls}>单工单暂停次数上限</label>
                <input type="number" min="1" max="100"
                  disabled={!canEdit} className={`${inputCls} tabular-nums`}
                  value={config?.max_pause_count ?? ''}
                  onChange={(e) => setNumber(patch, 'max_pause_count', e.target.value)} />
                <p className={hintCls}>超过后需管理员介入处理</p>
              </div>
              <div>
                <label className={labelCls}>批量操作上限（单）</label>
                <input type="number" min="1" max="500"
                  disabled={!canEdit} className={`${inputCls} tabular-nums`}
                  value={config?.max_batch_size ?? ''}
                  onChange={(e) => setNumber(patch, 'max_batch_size', e.target.value)} />
                <p className={hintCls}>单次批量暂停/恢复的工单数量上限</p>
              </div>
              <div>
                <label className={labelCls}>到期前提醒（分钟）</label>
                <input type="number" min="1"
                  max={Number(config?.max_pause_minutes) > 0 ? Number(config.max_pause_minutes) : undefined}
                  disabled={!canEdit} className={`${inputCls} tabular-nums`}
                  value={config?.remind_before_expire_minutes ?? ''}
                  onChange={(e) => setNumber(patch, 'remind_before_expire_minutes', e.target.value)} />
                <p className={hintCls}>距到期不足该时长时额外提醒一次</p>
              </div>
              <div>
                <label className={labelCls}>兜底处理分组</label>
                <CompactSelect block size="lg" disabled={!canEdit}
                  value={config?.fallback_group_id ?? ''}
                  onChange={(e) => patch('fallback_group_id', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">未配置（到期转办将降级为自动恢复）</option>
                  {groups.filter((g) => g.enabled !== false).map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </CompactSelect>
                <p className={hintCls}>到期处置为「自动转办」时使用</p>
              </div>
            </div>
          </section>

          {/* 分类策略 */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-foreground">暂停分类策略</h2>
            {PAUSE_TYPE_ORDER.map((code) => {
              const item = config?.types?.[code]
              if (!item) return null
              const allowClose = code === 'duplicate_merge'
              return (
                <div key={code} className="rounded-lg border border-border bg-card p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{item.label || code}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{code}</span>
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm text-foreground">
                      <input type="checkbox" disabled={!canEdit} className="h-4 w-4 accent-primary"
                        checked={!!item.enabled}
                        onChange={(e) => patchType(code, 'enabled', e.target.checked)} />
                      启用该分类
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <label className={labelCls}>分类名称</label>
                      <input type="text" disabled={!canEdit} className={inputCls}
                        value={item.label || ''}
                        onChange={(e) => patchType(code, 'label', e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls}>单次暂停上限（分钟）</label>
                      <input type="number" min="1"
                        max={Number(config?.max_pause_minutes) > 0 ? Number(config.max_pause_minutes) : undefined}
                        disabled={!canEdit} className={`${inputCls} tabular-nums`}
                        value={item.max_minutes ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          patchType(code, 'max_minutes', raw === '' ? '' : Math.max(0, Math.floor(Number(raw) || 0)))
                        }} />
                      <p className={hintCls}>{fmtMinutes(item.max_minutes)}</p>
                    </div>
                    <div>
                      <label className={labelCls}>到期处置</label>
                      <CompactSelect block size="lg" disabled={!canEdit}
                        value={item.timeout_policy || 'auto_resume'}
                        onChange={(e) => patchType(code, 'timeout_policy', e.target.value)}>
                        {TIMEOUT_POLICIES
                          .filter(([v]) => allowClose || v !== 'auto_close')
                          .map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </CompactSelect>
                    </div>
                    <div>
                      <label className={labelCls}>暂停原因可见性</label>
                      <CompactSelect block size="lg" disabled={!canEdit}
                        value={item.reason_visibility || 'participants'}
                        onChange={(e) => patchType(code, 'reason_visibility', e.target.value)}>
                        {REASON_VISIBILITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </CompactSelect>
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelCls}>可操作角色</label>
                      <div className="flex flex-wrap items-center gap-4 pt-1">
                        {PAUSE_ROLES.map(([role, label]) => (
                          <label key={role} className="inline-flex items-center gap-2 text-sm text-foreground">
                            <input type="checkbox" disabled={!canEdit} className="h-4 w-4 accent-primary"
                              checked={(item.allow_roles || []).includes(role)}
                              onChange={(e) => toggleRole(code, role, e.target.checked)} />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>提醒阈值（%）</label>
                      <input type="text" disabled={!canEdit} className={inputCls}
                        placeholder="如 50,80"
                        value={remindText[code] ?? ''}
                        onChange={(e) => setRemindText((t) => ({ ...t, [code]: e.target.value }))} />
                      <p className={hintCls}>按暂停时长的百分比提醒，需升序且不重复</p>
                    </div>
                    <div className="flex flex-col gap-2 pt-1">
                      <label className="inline-flex items-center gap-2 text-sm text-foreground">
                        <input type="checkbox" disabled={!canEdit} className="h-4 w-4 accent-primary"
                          checked={!!item.require_expected_resume}
                          onChange={(e) => patchType(code, 'require_expected_resume', e.target.checked)} />
                        必须填写期望恢复时间
                      </label>
                      <label className="inline-flex items-center gap-2 text-sm text-foreground">
                        <input type="checkbox" disabled={!canEdit} className="h-4 w-4 accent-primary"
                          checked={item.allow_batch !== false}
                          onChange={(e) => patchType(code, 'allow_batch', e.target.checked)} />
                        允许批量暂停
                      </label>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>

          {!loading && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-6 py-4 text-[13px] text-muted-foreground">
              <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                到期提醒由后台定时任务每 5 分钟扫描：按阈值百分比提醒处理人，到期后按「到期处置」自动恢复 / 恢复并升级 /
                转办兜底分组 / 关闭重复工单；暂停期间禁止流转、回退、转办与认领。
              </p>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  )
}
