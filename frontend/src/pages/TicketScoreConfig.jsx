// 工单价值评估：评分规则配置管理
//
// 支持在线调整评分维度、维度权重、1-5 分分值锚点、修正系数、强制置顶与分级阈值，
// 无需改代码即可生效；保存即生成新版本（版本历史保留，可查看/载入历史版本），
// 规则变更后工单列表与详情自动按最新规则折算展示。
// 权限：读取需 ticket_config:view，保存需 ticket_config:edit。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, BookOpen, Check, History, Info, Loader2, Plus, RefreshCw,
  RotateCcw, Save, Scale, ShieldAlert, Trash2,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputCls, labelCls, hintCls } from '../components/property/FormControls'
import { Button, PageContainer, PageHeader, CompactSelect } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import { gradeBadgeCls } from '../utils/ticketScore'
import ticketScoreApi from '../api/ticketScores'

const COLOR_OPTIONS = [
  ['red', '红色'],
  ['orange', '橙色'],
  ['amber', '黄色'],
  ['blue', '蓝色'],
  ['emerald', '绿色'],
  ['slate', '灰色'],
]

const numOrEmpty = (raw) => {
  if (raw === '') return ''
  const n = Number(raw)
  return Number.isFinite(n) ? n : ''
}

const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '--')

// 新维度/系数/置顶规则的标识：只增不改，保证历史评分可按同一标识回溯
const nextKey = (prefix, list) => {
  let i = 1
  while ((list || []).some((x) => x.key === `${prefix}_${i}`)) i += 1
  return `${prefix}_${i}`
}

const newDimension = (dims) => ({
  key: nextKey('dim', dims),
  name: '新评分维度',
  weight: 1,
  question: '',
  basis: '',
  levels: [5, 4, 3, 2, 1].map((score) => ({
    score,
    label: score === 5 ? '最高' : score === 1 ? '最低' : '',
    criteria: '',
  })),
})

const splitRulePayload = (payload) => {
  const {
    version, builtin, note, published_by_name, published_at, ...config
  } = payload || {}
  return {
    meta: { version: version ?? 0, builtin: !!builtin, note: note || '', published_by_name, published_at },
    config: JSON.parse(JSON.stringify(config)),
  }
}

function validateRule(config) {
  const issues = []
  if (!String(config?.name || '').trim()) issues.push('规则名称不能为空')
  const scale = Number(config?.scale)
  if (!Number.isInteger(scale) || scale < 1 || scale > 100) issues.push('分值放大系数需为 1-100 的整数')
  const cap = Number(config?.factor_cap)
  if (!Number.isFinite(cap) || cap < 1 || cap > 5) issues.push('修正系数总上限需在 1.0-5.0 之间')

  const dims = config?.dimensions || []
  if (!dims.length) issues.push('至少保留 1 个评分维度')
  if (dims.length > 10) issues.push('评分维度最多 10 个')
  const dimKeys = new Set()
  let totalWeight = 0
  dims.forEach((dim, index) => {
    const label = dim.name || `第 ${index + 1} 个维度`
    if (!dim.key) issues.push(`${label} 缺少标识`)
    else if (dimKeys.has(dim.key)) issues.push(`维度标识「${dim.key}」重复`)
    dimKeys.add(dim.key)
    const weight = Number(dim.weight)
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) issues.push(`「${label}」权重需为 1-100 的整数`)
    totalWeight += Number.isFinite(weight) ? weight : 0
    if (!String(dim.name || '').trim()) issues.push(`第 ${index + 1} 个维度名称不能为空`)
    const levels = dim.levels || []
    if (levels.length !== 5) issues.push(`「${label}」需配置 1-5 共 5 个分值锚点`)
    const scores = new Set(levels.map((l) => Number(l.score)))
    if (scores.size !== 5) issues.push(`「${label}」分值锚点需覆盖 1-5 分`)
    levels.forEach((level) => {
      if (!String(level.label || '').trim()) issues.push(`「${label}」${level.score} 分等级名不能为空`)
      if (!String(level.criteria || '').trim()) issues.push(`「${label}」${level.score} 分判定标准不能为空`)
    })
  })
  if (totalWeight !== 100) issues.push(`各维度权重合计必须为 100%（当前 ${totalWeight}%）`)

  const factorKeys = new Set()
  ;(config?.factors || []).forEach((f, index) => {
    if (!f.key) issues.push(`第 ${index + 1} 个修正系数缺少标识`)
    else if (factorKeys.has(f.key)) issues.push(`修正系数标识「${f.key}」重复`)
    factorKeys.add(f.key)
    if (!String(f.name || '').trim()) issues.push(`第 ${index + 1} 个修正系数名称不能为空`)
    const mult = Number(f.multiplier)
    if (!Number.isFinite(mult) || mult < 0.1 || mult > 5) issues.push(`修正系数「${f.name || f.key}」需在 0.1-5.0 之间`)
  })

  const overrideKeys = new Set()
  ;(config?.override_rules || []).forEach((r, index) => {
    if (!r.key) issues.push(`第 ${index + 1} 个置顶规则缺少标识`)
    else if (overrideKeys.has(r.key)) issues.push(`置顶规则标识「${r.key}」重复`)
    overrideKeys.add(r.key)
    if (!String(r.name || '').trim()) issues.push(`第 ${index + 1} 个置顶规则名称不能为空`)
    const value = Number(r.value)
    if (!Number.isInteger(value) || value < 0 || value > 100) issues.push(`置顶规则「${r.name || r.key}」分值需为 0-100 的整数`)
  })

  const grades = config?.grades || []
  if (!grades.length) issues.push('至少配置 1 个评分分级')
  const gradeKeys = new Set()
  grades.forEach((g, index) => {
    if (!String(g.key || '').trim()) issues.push(`第 ${index + 1} 个分级标识不能为空`)
    else if (gradeKeys.has(g.key)) issues.push(`分级标识「${g.key}」重复`)
    gradeKeys.add(g.key)
    if (!String(g.label || '').trim()) issues.push(`第 ${index + 1} 个分级名称不能为空`)
    const min = Number(g.min)
    if (!Number.isInteger(min) || min < 0 || min > 100) issues.push(`分级「${g.label || g.key}」最低分需为 0-100 的整数`)
  })
  if (grades.length) {
    const last = grades[grades.length - 1]
    if (Number(last.min) !== 0) issues.push('最低分级的分数下限必须为 0（保证 0-100 全覆盖）')
    const mins = new Set()
    grades.forEach((g) => {
      const min = Number(g.min)
      if (mins.has(min)) issues.push(`分级最低分不能重复（${min}）`)
      mins.add(min)
    })
  }
  return issues
}

function Section({ title, description, extra, children }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {extra}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  )
}

function DimensionCard({ dim, index, disabled, onChange, onRemove, canRemove }) {
  const hasAttackAnchor = (dim.levels || []).some((l) => l.criteria_attack !== undefined)
  const patch = (key, value) => onChange({ ...dim, [key]: value })
  const patchLevel = (score, key, value) => onChange({
    ...dim,
    levels: dim.levels.map((l) => (Number(l.score) === Number(score) ? { ...l, [key]: value } : l)),
  })
  return (
    <div className="rounded-md border border-border bg-background/60">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {index + 1}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title="维度标识用于历史评分回溯，创建后不可修改">
          {dim.key}
        </span>
        <input
          className={`${inputCls} h-8 min-w-40 flex-1`}
          value={dim.name}
          disabled={disabled}
          placeholder="维度名称"
          onChange={(e) => patch('name', e.target.value)}
        />
        <div className="flex items-center gap-1">
          <input
            className={`${inputCls} h-8 w-20 text-right`}
            type="number"
            min={1}
            max={100}
            value={dim.weight}
            disabled={disabled}
            onChange={(e) => patch('weight', numOrEmpty(e.target.value))}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
        {canRemove && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除该维度（权重需重新分配为 100%）"
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="grid gap-2 px-3 py-2 sm:grid-cols-2">
        <div>
          <label className={labelCls}>回答的问题</label>
          <input
            className={`${inputCls} h-8`}
            value={dim.question || ''}
            disabled={disabled}
            placeholder="例如：这件事发生在什么资产上"
            onChange={(e) => patch('question', e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>取值依据</label>
          <input
            className={`${inputCls} h-8`}
            value={dim.basis || ''}
            disabled={disabled}
            placeholder="例如：CMDB 资产等级、业务属性"
            onChange={(e) => patch('basis', e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <div className="grid gap-2 text-[11px] font-medium text-muted-foreground lg:grid-cols-[52px_170px_minmax(0,1fr)]">
          <span>分值</span>
          <span>等级名</span>
          <span>{hasAttackAnchor ? '漏洞类锚点 / 攻击类锚点' : '判定标准与典型场景'}</span>
        </div>
        {(dim.levels || []).map((level) => (
          <div key={level.score} className="grid gap-2 lg:grid-cols-[52px_170px_minmax(0,1fr)] lg:items-start">
            <span className="flex h-7 w-9 items-center justify-center rounded bg-muted text-xs font-semibold text-foreground">
              {level.score} 分
            </span>
            <input
              className={`${inputCls} h-8`}
              value={level.label}
              disabled={disabled}
              placeholder="等级名"
              onChange={(e) => patchLevel(level.score, 'label', e.target.value)}
            />
            <div className="space-y-1.5">
              <textarea
                className={`${inputCls} min-h-[52px] w-full resize-y text-xs`}
                value={level.criteria}
                disabled={disabled}
                placeholder="判定标准与典型场景"
                onChange={(e) => patchLevel(level.score, 'criteria', e.target.value)}
              />
              {level.criteria_attack !== undefined && (
                <textarea
                  className={`${inputCls} min-h-[44px] w-full resize-y text-xs`}
                  value={level.criteria_attack || ''}
                  disabled={disabled}
                  placeholder="攻击类工单锚点（可选）"
                  onChange={(e) => patchLevel(level.score, 'criteria_attack', e.target.value)}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TicketScoreConfig() {
  const canEdit = hasPermission('ticket_config', 'edit')
  const [config, setConfig] = useState(null)
  const [meta, setMeta] = useState({ version: 0, builtin: true, note: '', published_by_name: '', published_at: null })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState({ current_version: 0, items: [] })
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionDetail, setVersionDetail] = useState(null)
  const [versionDetailLoading, setVersionDetailLoading] = useState(false)

  const applyPayload = useCallback((payload) => {
    const { meta: nextMeta, config: nextConfig } = splitRulePayload(payload)
    setMeta(nextMeta)
    setConfig(nextConfig)
  }, [])

  const loadVersions = useCallback(() => {
    setVersionsLoading(true)
    ticketScoreApi.listVersions(50)
      .then((res) => setVersions(res || { current_version: 0, items: [] }))
      .catch(() => {})
      .finally(() => setVersionsLoading(false))
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([ticketScoreApi.getRule(), ticketScoreApi.listVersions(50)])
      .then(([rule, ver]) => {
        applyPayload(rule)
        setVersions(ver || { current_version: 0, items: [] })
      })
      .catch((e) => toast.error(e.message || '加载评分规则失败'))
      .finally(() => setLoading(false))
  }, [applyPayload])

  useEffect(() => { load() }, [load])

  const issues = useMemo(() => (config ? validateRule(config) : []), [config])
  const totalWeight = useMemo(
    () => (config?.dimensions || []).reduce((s, d) => s + Number(d.weight || 0), 0),
    [config],
  )

  const patch = (key, value) => setConfig((c) => ({ ...c, [key]: value }))
  const patchDim = (index, next) => setConfig((c) => ({
    ...c,
    dimensions: c.dimensions.map((d, i) => (i === index ? next : d)),
  }))
  const addDimension = () => setConfig((c) => ({
    ...c,
    dimensions: [...(c.dimensions || []), newDimension(c.dimensions || [])],
  }))
  const removeDimension = (index) => setConfig((c) => ({
    ...c,
    dimensions: c.dimensions.filter((_, i) => i !== index),
  }))

  const patchFactor = (index, next) => setConfig((c) => ({
    ...c,
    factors: (c.factors || []).map((f, i) => (i === index ? next : f)),
  }))
  const addFactor = () => setConfig((c) => ({
    ...c,
    factors: [...(c.factors || []), {
      key: nextKey('factor', c.factors || []),
      name: '新修正系数',
      multiplier: 1.1,
      description: '',
      enabled: true,
    }],
  }))
  const removeFactor = (index) => setConfig((c) => ({
    ...c,
    factors: (c.factors || []).filter((_, i) => i !== index),
  }))

  const patchOverride = (index, next) => setConfig((c) => ({
    ...c,
    override_rules: (c.override_rules || []).map((r, i) => (i === index ? next : r)),
  }))
  const addOverride = () => setConfig((c) => ({
    ...c,
    override_rules: [...(c.override_rules || []), {
      key: nextKey('override', c.override_rules || []),
      name: '新强制置顶规则',
      mode: 'min',
      value: 90,
      description: '',
      enabled: true,
    }],
  }))
  const removeOverride = (index) => setConfig((c) => ({
    ...c,
    override_rules: (c.override_rules || []).filter((_, i) => i !== index),
  }))

  const patchGrade = (index, next) => setConfig((c) => ({
    ...c,
    grades: (c.grades || []).map((g, i) => (i === index ? next : g)),
  }))
  const addGrade = () => setConfig((c) => ({
    ...c,
    grades: [...(c.grades || []), {
      key: `P${(c.grades || []).length}`,
      label: `P${(c.grades || []).length}`,
      min: 0,
      color: 'slate',
      description: '',
    }].sort((a, b) => Number(b.min) - Number(a.min)),
  }))
  const removeGrade = (index) => setConfig((c) => ({
    ...c,
    grades: (c.grades || []).filter((_, i) => i !== index),
  }))

  const handleSave = async () => {
    if (!canEdit) return
    if (issues.length) {
      toast.error(`规则校验未通过：${issues[0]}${issues.length > 1 ? `（共 ${issues.length} 项）` : ''}`)
      return
    }
    const ok = await confirm({
      title: '保存并发布评分规则',
      message: `保存后将生成新版本 v${Number(meta.version || 0) + 1} 并立即生效；已评分工单保留原始结果，同时按新规则折算展示。确认保存？`,
      confirmText: '保存并发布',
      variant: 'warning',
    })
    if (!ok) return
    setSaving(true)
    try {
      const res = await ticketScoreApi.saveRule(config, saveNote.trim())
      applyPayload(res)
      setSaveNote('')
      toast.success(`评分规则已发布：v${res.version}`)
      loadVersions()
    } catch (e) {
      toast.error(e.message || '保存评分规则失败')
    } finally {
      setSaving(false)
    }
  }

  const handleLoadDefault = async () => {
    const ok = await confirm({
      title: '载入内置默认规则',
      message: '将内置默认规则载入编辑器（不会立即生效），确认后可继续调整并点击「保存并发布」。',
      confirmText: '载入默认规则',
      variant: 'info',
    })
    if (!ok) return
    try {
      const res = await ticketScoreApi.getDefaultRule()
      applyPayload(res)
      toast.info('已载入内置默认规则，保存后才会发布生效')
    } catch (e) {
      toast.error(e.message || '载入默认规则失败')
    }
  }

  const openVersions = () => {
    setVersionsOpen(true)
    setVersionDetail(null)
    loadVersions()
  }

  const openVersionDetail = (version) => {
    setVersionDetailLoading(true)
    setVersionDetail(null)
    ticketScoreApi.getVersion(version)
      .then((res) => setVersionDetail(res))
      .catch((e) => toast.error(e.message || '加载版本详情失败'))
      .finally(() => setVersionDetailLoading(false))
  }

  const loadVersionToEditor = (payload) => {
    applyPayload(payload)
    setVersionsOpen(false)
    toast.info(`已载入 v${payload.version} 配置，保存后发布新版本`)
  }

  if (loading || !config) {
    return (
      <PageContainer>
        <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />加载评分规则...
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        title="评分规则配置"
        extra={(
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            当前版本
            <span className="rounded bg-primary/10 px-2 py-0.5 font-mono font-semibold text-primary">
              v{meta.version}{meta.builtin ? '（内置默认）' : ''}
            </span>
            {meta.published_at && <span className="text-xs">发布于 {fmtTime(meta.published_at)}</span>}
          </span>
        )}
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={openVersions}>
              <History className="mr-1 h-3.5 w-3.5" />版本历史
            </Button>
            {canEdit && (
              <Button variant="secondary" size="sm" onClick={handleLoadDefault}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />载入默认规则
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={load} title="重新加载当前生效规则">
              <RefreshCw className="mr-1 h-3.5 w-3.5" />刷新
            </Button>
          </>
        )}
      />

      {!canEdit && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          您没有「工单配置-编辑」权限，当前为只读模式；如需调整规则请联系管理员授权。
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.03] px-3 py-2 text-xs text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5 text-primary" />
        <span className="text-foreground">{config.formula_note || '价值分 = ROUND(Σ(维度得分 × 维度权重) × 20 × 修正系数, 0)'}</span>
        <span className="text-border">|</span>
        <span>维度得分 1-5 分，权重合计必须 100%</span>
        <span className="ml-auto">保存即生成新版本，全部工单自动适配</span>
      </div>

      <div className="space-y-4 pb-4">
        {/* ===== 基础设置 ===== */}
        <Section title="基础设置" description="规则名称、分值放大系数与修正系数总上限">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={labelCls}>规则名称</label>
              <input
                className={`${inputCls} h-9`}
                value={config.name || ''}
                disabled={!canEdit}
                onChange={(e) => patch('name', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>分值放大系数</label>
                <input
                  className={`${inputCls} h-9`}
                  type="number"
                  min={1}
                  max={100}
                  value={config.scale}
                  disabled={!canEdit}
                  onChange={(e) => patch('scale', numOrEmpty(e.target.value))}
                />
                <p className={hintCls}>默认 20：把 1-5 分的加权结果映射到 20-100</p>
              </div>
              <div>
                <label className={labelCls}>修正系数总上限</label>
                <input
                  className={`${inputCls} h-9`}
                  type="number"
                  min={1}
                  max={5}
                  step="0.05"
                  value={config.factor_cap}
                  disabled={!canEdit}
                  onChange={(e) => patch('factor_cap', numOrEmpty(e.target.value))}
                />
                <p className={hintCls}>多类系数连乘后封顶（默认 1.30）</p>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>公式说明</label>
              <textarea
                className={`${inputCls} min-h-[60px] w-full resize-y`}
                value={config.formula_note || ''}
                disabled={!canEdit}
                onChange={(e) => patch('formula_note', e.target.value)}
              />
            </div>
          </div>
        </Section>

        {/* ===== 维度与权重 ===== */}
        <Section
          title="评分维度与权重"
          description="每个维度配置 1-5 分的分值锚点；维度得分 × 权重后加权汇总"
          extra={(
            <span className={`rounded px-2 py-1 text-xs font-medium ${
              totalWeight === 100 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'
            }`}>
              权重合计 {totalWeight}%
            </span>
          )}
        >
          {(config.dimensions || []).map((dim, index) => (
            <DimensionCard
              key={dim.key || index}
              dim={dim}
              index={index}
              disabled={!canEdit}
              canRemove={(config.dimensions || []).length > 1}
              onChange={(next) => patchDim(index, next)}
              onRemove={() => removeDimension(index)}
            />
          ))}
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={addDimension} disabled={(config.dimensions || []).length >= 10}>
              <Plus className="mr-1 h-3.5 w-3.5" />新增维度
            </Button>
          )}
        </Section>

        {/* ===== 修正系数 ===== */}
        <Section
          title="修正系数"
          description="命中后对加权结果整体调整；同类不重复叠加，不同类可连乘（受总上限约束）"
          extra={canEdit && (
            <Button variant="secondary" size="sm" onClick={addFactor}>
              <Plus className="mr-1 h-3.5 w-3.5" />新增系数
            </Button>
          )}
        >
          {(config.factors || []).length === 0 && (
            <p className="text-xs text-muted-foreground">暂未配置修正系数（不影响基础评分）</p>
          )}
          {(config.factors || []).map((factor, index) => (
            <div key={factor.key || index} className="grid gap-2 rounded-md border border-border/70 bg-background/60 p-2 lg:grid-cols-[minmax(0,1.2fr)_110px_minmax(0,1.5fr)_70px_32px] lg:items-center">
              <div className="flex min-w-0 items-center gap-2">
                <Scale className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                <input
                  className={`${inputCls} h-8`}
                  value={factor.name}
                  disabled={!canEdit}
                  placeholder="系数名称"
                  onChange={(e) => patchFactor(index, { ...factor, name: e.target.value })}
                />
              </div>
              <input
                className={`${inputCls} h-8 text-right font-mono`}
                type="number"
                min={0.1}
                max={5}
                step="0.05"
                value={factor.multiplier}
                disabled={!canEdit}
                onChange={(e) => patchFactor(index, { ...factor, multiplier: numOrEmpty(e.target.value) })}
              />
              <input
                className={`${inputCls} h-8`}
                value={factor.description || ''}
                disabled={!canEdit}
                placeholder="适用条件说明"
                onChange={(e) => patchFactor(index, { ...factor, description: e.target.value })}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={factor.enabled !== false}
                  disabled={!canEdit}
                  onChange={(e) => patchFactor(index, { ...factor, enabled: e.target.checked })}
                />
                启用
              </label>
              {canEdit && (
                <button
                  type="button"
                  className="justify-self-end rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="删除该修正系数"
                  onClick={() => removeFactor(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </Section>

        {/* ===== 强制置顶 ===== */}
        <Section
          title="强制置顶规则"
          description="命中后不再依赖常规加权结果，直接抬升到指定分值（set=直接置为，min=不低于）"
          extra={canEdit && (
            <Button variant="secondary" size="sm" onClick={addOverride}>
              <Plus className="mr-1 h-3.5 w-3.5" />新增置顶规则
            </Button>
          )}
        >
          {(config.override_rules || []).length === 0 && (
            <p className="text-xs text-muted-foreground">暂未配置强制置顶规则</p>
          )}
          {(config.override_rules || []).map((rule, index) => (
            <div key={rule.key || index} className="grid gap-2 rounded-md border border-border/70 bg-background/60 p-2 lg:grid-cols-[minmax(0,1.4fr)_100px_90px_minmax(0,1.2fr)_70px_32px] lg:items-center">
              <div className="flex min-w-0 items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-500" />
                <input
                  className={`${inputCls} h-8`}
                  value={rule.name}
                  disabled={!canEdit}
                  placeholder="命中条件说明"
                  onChange={(e) => patchOverride(index, { ...rule, name: e.target.value })}
                />
              </div>
              <CompactSelect
                value={rule.mode}
                onChange={(e) => patchOverride(index, { ...rule, mode: e.target.value })}
                disabled={!canEdit}
              >
                <option value="set">直接置为</option>
                <option value="min">不低于</option>
              </CompactSelect>
              <input
                className={`${inputCls} h-8 text-right font-mono`}
                type="number"
                min={0}
                max={100}
                value={rule.value}
                disabled={!canEdit}
                onChange={(e) => patchOverride(index, { ...rule, value: numOrEmpty(e.target.value) })}
              />
              <input
                className={`${inputCls} h-8`}
                value={rule.description || ''}
                disabled={!canEdit}
                placeholder="补充说明"
                onChange={(e) => patchOverride(index, { ...rule, description: e.target.value })}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={rule.enabled !== false}
                  disabled={!canEdit}
                  onChange={(e) => patchOverride(index, { ...rule, enabled: e.target.checked })}
                />
                启用
              </label>
              {canEdit && (
                <button
                  type="button"
                  className="justify-self-end rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="删除该置顶规则"
                  onClick={() => removeOverride(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </Section>

        {/* ===== 分级阈值 ===== */}
        <Section
          title="评分分级阈值"
          description="按最终价值分从高到低匹配；最低分级的分数下限必须为 0"
          extra={canEdit && (
            <Button variant="secondary" size="sm" onClick={addGrade}>
              <Plus className="mr-1 h-3.5 w-3.5" />新增分级
            </Button>
          )}
        >
          {(config.grades || []).map((grade, index) => (
            <div key={`${grade.key}-${index}`} className="grid gap-2 rounded-md border border-border/70 bg-background/60 p-2 lg:grid-cols-[90px_110px_90px_120px_minmax(0,1fr)_32px] lg:items-center">
              <input
                className={`${inputCls} h-8 font-mono`}
                value={grade.key}
                disabled={!canEdit}
                placeholder="标识（P0）"
                onChange={(e) => patchGrade(index, { ...grade, key: e.target.value })}
              />
              <input
                className={`${inputCls} h-8`}
                value={grade.label}
                disabled={!canEdit}
                placeholder="显示名"
                onChange={(e) => patchGrade(index, { ...grade, label: e.target.value })}
              />
              <input
                className={`${inputCls} h-8 text-right font-mono`}
                type="number"
                min={0}
                max={100}
                value={grade.min}
                disabled={!canEdit}
                onChange={(e) => patchGrade(index, { ...grade, min: numOrEmpty(e.target.value) })}
              />
              <CompactSelect
                value={grade.color}
                onChange={(e) => patchGrade(index, { ...grade, color: e.target.value })}
                disabled={!canEdit}
              >
                {COLOR_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </CompactSelect>
              <input
                className={`${inputCls} h-8`}
                value={grade.description || ''}
                disabled={!canEdit}
                placeholder="分级说明"
                onChange={(e) => patchGrade(index, { ...grade, description: e.target.value })}
              />
              {canEdit && (config.grades || []).length > 1 ? (
                <button
                  type="button"
                  className="justify-self-end rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="删除该分级"
                  onClick={() => removeGrade(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : <span />}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>预览：</span>
            {(config.grades || []).map((g) => (
              <span key={g.key} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ring-1 ${gradeBadgeCls(g.color)}`}>
                {g.label || g.key} ≥ {g.min} 分
              </span>
            ))}
          </div>
        </Section>

        {/* ===== 保存 ===== */}
        {canEdit && (
          <div className="sticky bottom-3 z-10 rounded-lg border border-border bg-card/95 p-3 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                {issues.length === 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" />规则校验通过，保存后立即生效
                  </span>
                ) : (
                  <span className="inline-flex items-start gap-1 text-xs text-destructive" title={issues.join('\n')}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {issues[0]}
                      {issues.length > 1 ? `（共 ${issues.length} 项问题，悬停查看全部）` : ''}
                    </span>
                  </span>
                )}
              </div>
              <input
                className={`${inputCls} h-8 w-64`}
                value={saveNote}
                maxLength={255}
                placeholder="变更说明（可选，记入版本历史）"
                onChange={(e) => setSaveNote(e.target.value)}
              />
              <Button variant="primary" size="sm" loading={saving} disabled={saving || issues.length > 0} onClick={handleSave}>
                <Save className="mr-1 h-3.5 w-3.5" />保存并发布 v{Number(meta.version || 0) + 1}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 版本历史 */}
      <Modal
        open={versionsOpen}
        title="评分规则版本历史"
        onClose={() => setVersionsOpen(false)}
        size="xl"
        footer={<Button variant="secondary" size="sm" onClick={() => setVersionsOpen(false)}>关闭</Button>}
      >
        <div className="grid gap-4 py-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {versionsLoading && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />加载版本...
              </div>
            )}
            {!versionsLoading && (versions.items || []).length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无发布版本（当前使用内置默认规则）</p>
            )}
            {(versions.items || []).map((item) => (
              <button
                key={item.version}
                type="button"
                onClick={() => openVersionDetail(item.version)}
                className={`w-full rounded-md border px-3 py-2 text-left transition ${
                  Number(item.version) === Number(versionDetail?.version)
                    ? 'border-primary bg-primary/[0.05]'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">v{item.version}</span>
                  {Number(item.version) === Number(versions.current_version) && (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">当前生效</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{fmtTime(item.published_at)}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {item.published_by_name || '--'}{item.note ? ` · ${item.note}` : ''}
                </div>
              </button>
            ))}
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-3">
            {versionDetailLoading && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />加载版本详情...
              </div>
            )}
            {!versionDetailLoading && !versionDetail && (
              <p className="py-8 text-center text-sm text-muted-foreground">选择左侧版本查看配置详情</p>
            )}
            {!versionDetailLoading && versionDetail && (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">v{versionDetail.version}</span>
                  {canEdit && (
                    <Button variant="secondary" size="sm" onClick={() => loadVersionToEditor(versionDetail)}>
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />载入编辑器
                    </Button>
                  )}
                </div>
                <div className="text-muted-foreground">
                  {versionDetail.published_by_name || '--'} · {fmtTime(versionDetail.published_at)}
                  {versionDetail.note ? ` · ${versionDetail.note}` : ''}
                </div>
                <div>
                  <div className="mb-1 font-medium text-foreground">维度权重</div>
                  <div className="space-y-1">
                    {(versionDetail.dimensions || []).map((d) => (
                      <div key={d.key} className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1">
                        <span className="text-foreground">{d.name}</span>
                        <span className="font-mono text-muted-foreground">{d.weight}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 font-medium text-foreground">修正系数（上限 ×{versionDetail.factor_cap}）</div>
                  <div className="space-y-1">
                    {(versionDetail.factors || []).map((f) => (
                      <div key={f.key} className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1">
                        <span className="truncate text-foreground">{f.name}</span>
                        <span className="font-mono text-muted-foreground">×{f.multiplier}{f.enabled === false ? '（停用）' : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 font-medium text-foreground">强制置顶</div>
                  <div className="space-y-1">
                    {(versionDetail.override_rules || []).map((r) => (
                      <div key={r.key} className="rounded bg-background px-2 py-1 text-muted-foreground">
                        {r.name}（{r.mode === 'set' ? '=' : '≥'}{r.value}）{r.enabled === false ? '（停用）' : ''}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 font-medium text-foreground">分级阈值</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(versionDetail.grades || []).map((g) => (
                      <span key={g.key} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ring-1 ${gradeBadgeCls(g.color)}`}>
                        {g.label} ≥ {g.min}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
