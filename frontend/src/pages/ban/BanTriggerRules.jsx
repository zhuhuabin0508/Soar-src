// 封禁工作流触发规则配置页：规则列表 + 新建/编辑弹窗（多条件 AND、冷却期、优先级）
// 规则修改实时生效（worker 每次按需查库匹配）
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Plus, Pencil, Trash2, RefreshCw, Inbox, ChevronDown, Check, Filter, Layers,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { Button, PageContainer, PageHeader, Card, DataTable, CompactSelect } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputBaseCls } from '../../components/property/FormControls'
import { hasPermission } from '../../utils/permissions'
import banWorkflowApi from '../../api/banWorkflow'

const RISK_LEVELS = [
  { v: 0, label: '严重' }, { v: 1, label: '高危' }, { v: 2, label: '中危' },
  { v: 3, label: '低危' }, { v: 4, label: '信息' }, { v: 5, label: '未知' },
]
const DIRECTIONS = [{ v: 0, label: '无' }, { v: 1, label: '内到外' }, { v: 2, label: '外到内' }, { v: 3, label: '内对内' }]
const IP_TAGS = [{ v: 1, label: '外网IP' }, { v: 0, label: '内网IP' }]

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')

// 多选下拉（复用告警列表交互）
function MultiSelect({ placeholder, options, values, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const toggle = (v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  return (
    <div className="relative" ref={ref}>
      <button
        className={`${inputBaseCls} flex h-[34px] w-full items-center justify-between gap-1 text-left ${values.length ? 'border-primary/60 text-foreground' : ''}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="truncate">{values.length ? `${placeholder} ${values.length}` : placeholder}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-[38px] left-0 z-dropdown max-h-60 w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.v}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-accent"
              onClick={() => toggle(o.v)}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded border ${values.includes(o.v) ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                {values.includes(o.v) && <Check className="h-3 w-3" />}
              </span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 条件摘要（列表展示）
function ConditionSummary({ cond }) {
  const parts = []
  if (cond.risk_levels?.length) parts.push(`风险等级: ${cond.risk_levels.map((v) => RISK_LEVELS.find((r) => r.v === v)?.label || v).join('/')}`)
  if (cond.min_severity != null) parts.push(`severity≥${cond.min_severity}`)
  if (cond.directions?.length) parts.push(`方向: ${cond.directions.map((v) => DIRECTIONS.find((d) => d.v === v)?.label || v).join('/')}`)
  if (cond.src_ip_tags?.length) parts.push(`IP标签: ${cond.src_ip_tags.map((v) => IP_TAGS.find((t) => t.v === v)?.label || v).join('/')}`)
  if (cond.alert_name_keywords?.length) parts.push(`关键词: ${cond.alert_name_keywords.join('/')}`)
  if (cond.threat_classes?.length) parts.push(`威胁分类: ${cond.threat_classes.join('/')}`)
  if (!parts.length) return <span className="text-muted-foreground">无条件（匹配全部告警）</span>
  return <span className="text-xs text-foreground">{parts.join(' 且 ')}</span>
}

const EMPTY_FORM = {
  rule_name: '', status: 'enabled',
  risk_levels: [], min_severity: '', directions: [], src_ip_tags: [],
  alert_name_keywords: '', threat_classes: '',
  cooldown_minutes: 60, priority: 0,
}

export default function BanTriggerRules() {
  const canEdit = hasPermission('ban_workflow', 'edit')
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState(null) // {id?} 编辑中；null 关闭
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [quickFilter, setQuickFilter] = useState('') // '' | 'enabled' | 'disabled'

  const load = useCallback(() => {
    setLoading(true)
    banWorkflowApi.rules()
      .then(setRules)
      .catch((e) => toast.error(e.message || '规则加载失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // 指标条统计：从现有规则派生，不发额外请求
  const stats = useMemo(() => {
    let enabled = 0
    rules.forEach((r) => { if (r.status === 'enabled') enabled += 1 })
    return { enabled, disabled: rules.length - enabled }
  }, [rules])

  const filtered = useMemo(
    () => (quickFilter ? rules.filter((r) => r.status === quickFilter) : rules),
    [rules, quickFilter]
  )

  const openCreate = () => { setForm(EMPTY_FORM); setEditor({}) }
  const openEdit = (r) => {
    setForm({
      rule_name: r.rule_name || '',
      status: r.status || 'enabled',
      risk_levels: r.conditions?.risk_levels || [],
      min_severity: r.conditions?.min_severity ?? '',
      directions: r.conditions?.directions || [],
      src_ip_tags: r.conditions?.src_ip_tags || [],
      alert_name_keywords: (r.conditions?.alert_name_keywords || []).join(', '),
      threat_classes: (r.conditions?.threat_classes || []).join(', '),
      cooldown_minutes: r.cooldown_minutes ?? 60,
      priority: r.priority ?? 0,
    })
    setEditor({ id: r.id })
  }

  const setF = (patch) => setForm((f) => ({ ...f, ...patch }))

  const buildBody = () => {
    const splitList = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
    const conditions = {}
    if (form.risk_levels.length) conditions.risk_levels = form.risk_levels
    if (form.min_severity !== '' && form.min_severity != null) conditions.min_severity = Number(form.min_severity)
    if (form.directions.length) conditions.directions = form.directions
    if (form.src_ip_tags.length) conditions.src_ip_tags = form.src_ip_tags
    if (splitList(form.alert_name_keywords).length) conditions.alert_name_keywords = splitList(form.alert_name_keywords)
    if (splitList(form.threat_classes).length) conditions.threat_classes = splitList(form.threat_classes)
    return {
      rule_name: form.rule_name.trim(),
      status: form.status,
      conditions,
      cooldown_minutes: Number(form.cooldown_minutes) || 60,
      priority: Number(form.priority) || 0,
    }
  }

  const save = () => {
    if (!form.rule_name.trim()) {
      toast.error('请填写规则名称')
      return
    }
    setSaving(true)
    const body = buildBody()
    const p = editor.id
      ? banWorkflowApi.updateRule(editor.id, body)
      : banWorkflowApi.createRule(body)
    p.then(() => {
      toast.success(editor.id ? '规则已更新（实时生效）' : '规则已创建（实时生效）')
      setEditor(null)
      load()
    })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  const doDelete = () => {
    setDeleting(true)
    banWorkflowApi.deleteRule(deleteTarget.id)
      .then(() => {
        toast.success(`规则「${deleteTarget.rule_name}」已删除`)
        setDeleteTarget(null)
        load()
      })
      .catch((e) => toast.error(e.message || '删除失败'))
      .finally(() => setDeleting(false))
  }

  const toggleStatus = (r) => {
    const body = {
      rule_name: r.rule_name,
      status: r.status === 'enabled' ? 'disabled' : 'enabled',
      conditions: r.conditions || {},
      cooldown_minutes: r.cooldown_minutes,
      priority: r.priority,
    }
    banWorkflowApi.updateRule(r.id, body)
      .then(() => { toast.success(r.status === 'enabled' ? '规则已停用' : '规则已启用'); load() })
      .catch((e) => toast.error(e.message || '操作失败'))
  }

  const columns = [
    { key: 'rule_name', header: '规则名称', width: '180px', render: (r) => <span className="font-medium">{r.rule_name}</span> },
    {
      key: 'status', header: '状态', width: '90px',
      render: (r) => (
        <button
          disabled={!canEdit}
          className={`inline-flex h-6 w-11 items-center rounded-full px-0.5 transition ${r.status === 'enabled' ? 'bg-success/80' : 'bg-muted'} ${canEdit ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
          title={canEdit ? (r.status === 'enabled' ? '点击停用' : '点击启用') : ''}
          onClick={(e) => { e.stopPropagation(); if (canEdit) toggleStatus(r) }}
        >
          <span className={`h-5 w-5 rounded-full bg-white shadow transition ${r.status === 'enabled' ? 'translate-x-5' : ''}`} />
        </button>
      ),
    },
    { key: 'conditions', header: '触发条件（AND）', width: '420px', render: (r) => <ConditionSummary cond={r.conditions || {}} /> },
    {
      key: 'cooldown', header: '冷却期', width: '90px', numeric: true,
      render: (r) => {
        const v = r.cooldown_minutes
        return (
          <span
            className={`whitespace-nowrap font-mono text-xs tabular-nums ${v ? 'text-foreground' : 'text-muted-foreground'}`}
            title={v == null ? '未统计' : undefined}
          >
            {v == null ? '--' : `${Number(v).toLocaleString()} 分钟`}
          </span>
        )
      },
    },
    {
      key: 'priority', header: '优先级', width: '75px', numeric: true,
      render: (r) => {
        const v = r.priority
        return (
          <span
            className={`tabular-nums ${v ? 'text-foreground' : 'text-muted-foreground'}`}
            title={v == null ? '未统计' : undefined}
          >
            {v == null ? '--' : Number(v).toLocaleString()}
          </span>
        )
      },
    },
    { key: 'updated_at', header: '更新时间', width: '150px', render: (r) => <span className="font-mono text-xs text-muted-foreground">{fmtTime(r.updated_at)}</span> },
    ...(canEdit ? [{
      key: 'actions', header: '操作', width: '125px',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="btn-secondary btn-sm" title="编辑" onClick={() => openEdit(r)}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button className="btn-danger btn-sm" title="删除" onClick={() => setDeleteTarget(r)}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    }] : []),
  ]

  return (
    <PageContainer>
      <PageHeader
        title="触发规则配置"
        extra={!loading && (
          <span className="text-xs text-muted-foreground">
            共 <span className="font-medium tabular-nums text-foreground">{rules.length}</span> 条规则
          </span>
        )}
        actions={
          <>
            <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新规则列表">
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </button>
            {canEdit && (
              <button type="button" onClick={openCreate} className="btn-primary btn-sm">
                <Plus className="mr-1 h-3.5 w-3.5" /> 新建规则
              </button>
            )}
          </>
        }
      />

      {/* 状态指标条：启用/停用分布（点击筛选）+ 右侧汇总，从现有规则派生 */}
      {!loading && rules.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          {[
            { key: 'enabled', label: '启用中', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
            { key: 'disabled', label: '已停用', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40' },
          ].map((chip) => {
            const active = quickFilter === chip.key
            const count = chip.key === 'enabled' ? stats.enabled : stats.disabled
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setQuickFilter(active ? '' : chip.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition-all duration-200 ${
                  active
                    ? `border-transparent ring-1 ${chip.active}`
                    : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
                title={active ? '点击取消该筛选' : `点击筛选「${chip.label}」的规则`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                    chip.key === 'enabled' && count > 0 ? 'animate-pulse' : ''
                  }`}
                />
                {chip.label}
                <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
              </button>
            )
          })}
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5" title="启用规则占全部规则的比例">
              <Layers className="h-3.5 w-3.5 text-primary/80" />
              启用率
              <span
                className={`font-semibold tabular-nums ${
                  stats.enabled > 0 ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {`${Math.round((stats.enabled / rules.length) * 100)}%`}
              </span>
            </span>
          </div>
        </div>
      )}

      <Card className="p-0" bodyClassName="p-0">
        <DataTable
          className="table-stagger"
          columns={columns}
          data={filtered}
          loading={loading}
          rowKey="id"
          selectable={false}
          onRowClick={canEdit ? (r) => openEdit(r) : undefined}
          rowClickHint="点击编辑"
          emptyIcon={Inbox}
          emptyText={rules.length === 0 ? '暂无触发规则' : '未找到匹配的规则'}
          emptyDescription={
            rules.length === 0
              ? '创建规则后，入库告警命中条件将自动触发 IP 风险研判与封禁工作流'
              : '当前筛选下没有规则，点击上方状态标签可查看全部'
          }
          emptyAction={
            rules.length === 0
              ? canEdit && (
                <button type="button" onClick={openCreate} className="btn-primary btn-sm">
                  <Plus className="mr-1 h-3.5 w-3.5" /> 新建规则
                </button>
              )
              : (
                <button type="button" onClick={() => setQuickFilter('')} className="btn-secondary btn-sm">
                  清除筛选
                </button>
              )
          }
        />
      </Card>

      {/* 新建/编辑弹窗 */}
      <Modal
        open={!!editor}
        size="lg"
        title={editor?.id ? '编辑触发规则' : '新建触发规则'}
        onClose={() => setEditor(null)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>取消</Button>
            <Button variant="primary" loading={saving} onClick={save}>保存</Button>
          </>
        )}
      >
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {/* 基本信息 */}
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">规则名称 *</label>
              <input className={`${inputBaseCls} h-[34px] w-full`} placeholder="如：高危境外告警自动研判" value={form.rule_name} onChange={(e) => setF({ rule_name: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">状态</label>
                <CompactSelect block size="lg" value={form.status} onChange={(e) => setF({ status: e.target.value })}>
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </CompactSelect>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">冷却期(分)</label>
                <input type="number" min="1" className={`${inputBaseCls} h-[34px] w-full`} value={form.cooldown_minutes} onChange={(e) => setF({ cooldown_minutes: e.target.value })} title="同一源IP冷却期内不重复触发" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">优先级</label>
                <input type="number" min="0" className={`${inputBaseCls} h-[34px] w-full`} value={form.priority} onChange={(e) => setF({ priority: e.target.value })} title="多条命中取优先级最高的一条" />
              </div>
            </div>
          </div>

          {/* 触发条件 */}
          <div className="rounded-lg border border-border bg-muted p-3">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Filter className="h-3.5 w-3.5" /> 触发条件（全部为 AND 关系，未配置的条件视为通过）
            </div>
            <div className="grid gap-2.5 lg:grid-cols-3">
              <MultiSelect placeholder="风险等级" options={RISK_LEVELS} values={form.risk_levels} onChange={(v) => setF({ risk_levels: v })} />
              <MultiSelect placeholder="访问方向" options={DIRECTIONS} values={form.directions} onChange={(v) => setF({ directions: v })} />
              <MultiSelect placeholder="源IP标签" options={IP_TAGS} values={form.src_ip_tags} onChange={(v) => setF({ src_ip_tags: v })} />
              <div>
                <input type="number" min="0" max="100" className={`${inputBaseCls} h-[34px] w-full`} placeholder="severity 下限（如 50）" value={form.min_severity} onChange={(e) => setF({ min_severity: e.target.value })} />
              </div>
              <input className={`${inputBaseCls} h-[34px] w-full`} placeholder="告警名称关键词（逗号分隔）" value={form.alert_name_keywords} onChange={(e) => setF({ alert_name_keywords: e.target.value })} title="如：暴力破解, 扫描, C&C" />
              <input className={`${inputBaseCls} h-[34px] w-full`} placeholder="威胁一级分类（逗号分隔）" value={form.threat_classes} onChange={(e) => setF({ threat_classes: e.target.value })} />
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={!!deleteTarget}
        title={`删除规则「${deleteTarget?.rule_name || ''}」`}
        onClose={() => setDeleteTarget(null)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" loading={deleting} onClick={doDelete}>确认删除</Button>
          </>
        )}
      >
        <div className="text-sm">删除后立即生效，后续入库告警将不再按该规则触发封禁工作流。</div>
      </Modal>
    </PageContainer>
  )
}
