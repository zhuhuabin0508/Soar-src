// 告警规则全屏编辑页（XDR 风格重构）：Modal → 左右分栏表单页
// - 左栏（max-w 760）：① 基本信息 ② 规则类型（匹配/统计/关联[预留]）
//   ③ 规则配置（检测范围 + 条件构建器[两层嵌套] + 统计配置）④ 输出与字段配置
//   （双控件：取值方式 + 值）⑤ 告警聚合；编号分区卡片，表单标签置顶
// - 右栏 sticky：规则摘要（实时人类可读）+ 测试面板（匹配链 / 统计模拟 / 最终动作）
// - 页头：存为草稿（默认）/ 测试并发布（门禁：测试通过前置灰）
// - 路由：/alert-rules/new（新建，可带 location.state.initial 模板/复制预填）、
//   /alert-rules/:id/edit（编辑）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Check, ChevronDown, CircleDot, FlaskConical, Layers, Link2, Play, Plus,
  Trash2,
} from 'lucide-react'

import { alertRuleApi, alertRuleGroupApi } from '../api/alert'
import { devices as devicesApi } from '../api/client'
import { confirm } from '../components/ConfirmDialog'
import { inputBaseCls } from '../components/property/FormControls'
import { Badge, Button, PageContainer, CompactSelect } from '../components/ui'
import { toast } from '../store/toastStore'
import { hasPermission } from '../utils/permissions'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { validateIPExpression, validateCidrList } from '../utils/ipValidation'
import {
  ACTION_META, ALL_FIELDS, ENUM_FIELDS, FIELD_GROUPS, IP_FIELDS, NO_VALUE_OPS, NUMERIC_FIELDS,
  OPS, RISK_LEVELS, SET_OPS, coerceValue, fieldLabel, fmtCondValue, opLabel,
  renderTemplateLocal, riskLevelName, treeDepth, treeLeafCount,
} from './alertRuleMeta'

// ===== 常量 =====
// 字段配置：常用字段行（XDR 双控件模式）
const FIELDMAP_MAIN = [
  { field: 'alert_name', label: '告警名称', modes: ['static', 'map', 'keep'] },
  { field: 'risk_level', label: '告警等级', modes: ['static', 'keep'] },
  { field: 'src_ip', label: '源 IP', modes: ['map', 'static'] },
  { field: 'dst_ip', label: '目的 IP', modes: ['map', 'static'] },
  { field: 'src_port', label: '源端口', modes: ['map', 'static'] },
  { field: 'dst_port', label: '目的端口', modes: ['map', 'static'] },
  { field: 'threat_type', label: '威胁类型', modes: ['map', 'static'] },
  { field: 'threat_sub_type', label: '威胁子类型', modes: ['map', 'static'] },
  { field: 'description', label: '告警描述', modes: ['map', 'static'] },
]
const FIELDMAP_MAIN_FIELDS = FIELDMAP_MAIN.map((r) => r.field)
// 可选字段（折叠区）：标准模型中排除常用行后的其余字段
const FIELDMAP_OPTIONAL = ALL_FIELDS.filter((f) => !FIELDMAP_MAIN_FIELDS.includes(f))

const MODE_LABELS = { static: '静态值', map: '字段映射', keep: '保留解析结果' }
const WINDOW_UNITS = [
  { value: 'minute', label: '分钟' }, { value: 'hour', label: '小时' }, { value: 'day', label: '天' },
]
const unitName = (u) => (WINDOW_UNITS.find((x) => x.value === u) || {}).label || u
const QUICK_WINDOWS = [
  { value: 5, unit: 'minute', label: '5分钟' },
  { value: 60, unit: 'minute', label: '1小时' },
  { value: 24, unit: 'hour', label: '24小时' },
]
const QUICK_AGGS = [
  { value: 30, unit: 'minute', label: '30分钟' },
  { value: 60, unit: 'minute', label: '1小时' },
  { value: 24, unit: 'hour', label: '1天' },
]
// 名称模板可插入变量 chip
const TEMPLATE_VARS = ['threat_type', 'alert_name', 'src_ip', 'dst_ip', 'device_type', 'account_name', 'host_ip']

// ===== 表单转换（行数据 / 模板载荷 → 表单；表单 → 后端 RuleCreate 载荷）=====
const defaultLeaf = () => ({ field: 'risk_level', op: 'in', value: [0, 1] })

export function ruleToForm(src) {
  const ov = src?.override || {}
  const conds = src?.conditions
  // 条件树：新版嵌套 dict 直接用；旧版扁平 list 包一层；空给默认行（深拷贝防外部引用污染）
  let condTree
  if (conds && !Array.isArray(conds) && Array.isArray(conds.items)) {
    condTree = JSON.parse(JSON.stringify({ logic: conds.logic || src?.match || 'all', items: conds.items }))
  } else if (Array.isArray(conds) && conds.length) {
    condTree = JSON.parse(JSON.stringify({ logic: src?.match || 'all', items: conds }))
  } else {
    condTree = { logic: 'all', items: [defaultLeaf()] }
  }
  // 字段配置：field_mapping + 旧 override.alert_name/risk_level 迁移（mapping 优先）
  const fieldMapping = {}
  Object.entries(src?.field_mapping || {}).forEach(([k, v]) => {
    if (v && v.mode) fieldMapping[k] = { mode: v.mode, value: v.value ?? '' }
  })
  if (!fieldMapping.alert_name && ov.alert_name) fieldMapping.alert_name = { mode: 'static', value: ov.alert_name }
  if (!fieldMapping.risk_level && (ov.risk_level !== '' && ov.risk_level != null)) {
    fieldMapping.risk_level = { mode: 'static', value: String(ov.risk_level) }
  }
  const levelMap = {}
  Object.entries(ov.level_map || {}).forEach(([k, v]) => { levelMap[String(Number(k))] = Number(v) })
  const stats = src?.stats_config || {}
  return {
    name: src?.name || '',
    description: src?.description || '',
    group: src?.group || '其他',
    enabled: src?.enabled !== false,
    priority: src?.priority ?? 100,
    scope: src?.scope || 'global',
    device_type: src?.device_type || '',
    type: src?.type === 'stats' ? 'stats' : 'match',
    action: src?.action || 'alert',
    condTree,
    stats: {
      window: { value: stats.window?.value ?? 5, unit: stats.window?.unit || 'minute' },
      method: stats.method || 'count',
      distinct_field: stats.distinct_field || '',
      group_by: stats.group_by ? [...stats.group_by] : [],
      threshold: stats.threshold ?? 10,
    },
    fieldMapping,
    tags: Array.isArray(ov.tags) ? [...ov.tags] : [],
    suppressReason: ov.reason || '',
    levelMap,
    aggregation: src?.alert_aggregation
      ? { window: { value: src.alert_aggregation.window?.value ?? 30, unit: src.alert_aggregation.window?.unit || 'minute' }, keys: [...(src.alert_aggregation.keys || [])] }
      : null,
  }
}

export function buildRuleBody(form, draft) {
  // 条件树叶子：过滤未选字段行；NO_VALUE 操作符 value 置 null；其余 coerce
  const cleanNode = (node) => {
    if (node.type === 'group') {
      return { type: 'group', logic: node.logic, items: node.items.map(cleanNode).filter(Boolean) }
    }
    if (!node.field?.trim()) return null
    return {
      field: node.field.trim(),
      op: node.op,
      value: NO_VALUE_OPS.includes(node.op) ? null : coerceValue(node.op, node.value),
    }
  }
  const items = form.condTree.items.map(cleanNode).filter(Boolean)
  const conditions = { logic: form.condTree.logic, items }
  // override：按动作输出（suppress 原因 / 等级映射 / 标签）；alert_name/risk_level 已并入 field_mapping
  let override = {}
  if (form.action === 'suppress') override = { reason: form.suppressReason.trim() || null }
  else if (form.action === 'adjust_level') {
    override = { level_map: Object.keys(form.levelMap).length ? form.levelMap : null }
  }
  if (form.tags.length) override = { ...override, tags: form.tags }
  // 字段配置：剔除空行（map 未选来源 / static 空值且非数字字段）
  const fieldMapping = {}
  Object.entries(form.fieldMapping).forEach(([target, cfg]) => {
    if (!cfg?.mode) return
    if (cfg.mode === 'keep') { fieldMapping[target] = { mode: 'keep', value: null }; return }
    if (cfg.mode === 'map' && !cfg.value) return
    if (cfg.mode === 'static' && (cfg.value === '' || cfg.value == null)) return
    fieldMapping[target] = { mode: cfg.mode, value: cfg.value }
  })
  const isStats = form.type === 'stats'
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    enabled: !!form.enabled,
    priority: Number(form.priority) || 0,
    scope: form.scope,
    device_type: form.scope === 'device_type' ? form.device_type.trim() : '',
    match: form.condTree.logic,
    conditions,
    type: form.type,
    action: isStats ? 'alert' : form.action,
    stats_config: isStats
      ? {
        window: { value: Number(form.stats.window.value) || 1, unit: form.stats.window.unit },
        method: form.stats.method,
        distinct_field: form.stats.method === 'count_distinct' ? form.stats.distinct_field : null,
        group_by: form.stats.group_by,
        threshold: Number(form.stats.threshold) || 1,
      }
      : null,
    field_mapping: fieldMapping,
    alert_aggregation: form.aggregation,
    group: form.group || '其他',
    draft: !!draft,
    override,
  }
}

// ===== 枚举多选（复选框弹层，值显示中文名）=====
function EnumMultiSelect({ options, values, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const toggle = (v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  const label = values.length
    ? values.map((v) => (options.find((o) => o.value === v) || {}).label ?? v).join('、')
    : '请选择（可多选）'
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={`${inputBaseCls} flex h-8 w-full items-center justify-between gap-1 text-left ${values.length ? 'border-primary/60' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`truncate text-[13px] ${values.length ? '' : 'text-muted-foreground'}`}>{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-[36px] left-0 z-dropdown max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={String(o.value)} type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-accent"
              onClick={() => toggle(o.value)}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded border ${values.includes(o.value) ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                {values.includes(o.value) && <Check className="h-3 w-3" />}
              </span>
              <span className="truncate">{o.label}（{o.value}）</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 条件值输入（按字段类型联动）=====
function ValueInput({ cond, onChange }) {
  const { field, op, value } = cond
  const [touched, setTouched] = useState(false)
  const isIPCondition = IP_FIELDS.includes(field)
  // 即时校验：IP 字段 / in_cidr 网段条件（与后端统一规则）
  const rawValue = Array.isArray(value) ? value.join(',') : value
  let ipError = null
  if (!NO_VALUE_OPS.includes(op) && rawValue?.toString().trim()) {
    if (op === 'in_cidr') ipError = validateCidrList(rawValue, fieldLabel(field))
    else if (isIPCondition) ipError = validateIPExpression(rawValue, fieldLabel(field))
  }
  if (NO_VALUE_OPS.includes(op)) {
    return <input className={`${inputBaseCls} h-8 w-full`} disabled placeholder="无需取值" />
  }
  const enumList = ENUM_FIELDS[field]
  if (enumList) {
    if (SET_OPS.includes(op)) {
      return <EnumMultiSelect options={enumList} values={Array.isArray(value) ? value : []} onChange={onChange} />
    }
    if (op === 'eq' || op === 'ne') {
      const known = enumList.some((o) => String(o.value) === String(value))
      return (
        <CompactSelect size="md" block value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">请选择</option>
          {!known && value !== '' && value != null && <option value={value}>{String(value)}</option>}
          {enumList.map((o) => <option key={String(o.value)} value={o.value}>{o.label}（{o.value}）</option>)}
        </CompactSelect>
      )
    }
  }
  const isNumeric = NUMERIC_FIELDS.includes(field) || ['gt', 'gte', 'lt', 'lte'].includes(op)
  if (isNumeric) {
    return (
      <input type="number" className={`${inputBaseCls} h-8 w-full font-mono`} value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} placeholder="数字" />
    )
  }
  const placeholder = op === 'in_cidr'
    ? 'CIDR，如 10.0.0.0/8（多个逗号分隔）'
    : IP_FIELDS.includes(field)
      ? 'IP 或 CIDR，如 10.0.0.0/8'
      : SET_OPS.includes(op) ? '多个值用逗号分隔' : '比较值'
  return (
    <div className="w-full">
      <input
        className={`${inputBaseCls} h-8 w-full ${isIPCondition || op === 'in_cidr' ? 'font-mono' : ''}${touched && ipError ? ' border-destructive ring-1 ring-destructive' : ''}`}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        placeholder={placeholder}
      />
      {touched && ipError && <div className="mt-1 text-[11px] text-destructive">{ipError}</div>}
    </div>
  )
}

// 字段下拉（分组，常用在前；支持自定义字段兜底）——CompactSelect 自绘菜单（无原生弹层黑闪）
function FieldSelect({ value, onChange, className }) {
  const known = ALL_FIELDS.includes(value)
  return (
    <CompactSelect size="md" variant="input" className={className} value={value}
      onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">选择字段</option>}
      {FIELD_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.fields.map((f) => <option key={`${g.label}-${f}`} value={f}>{fieldLabel(f)}（{f}）</option>)}
        </optgroup>
      ))}
      {!known && value && <optgroup label="自定义字段"><option value={value}>{value}</option></optgroup>}
    </CompactSelect>
  )
}

// ===== 条件构建器（递归树：叶行 + 组卡片，最多两层组嵌套）=====
const LEAF_FIELD_CLS = 'w-[240px] shrink-0'
const LEAF_OP_CLS = `${inputBaseCls} h-8 w-[160px] shrink-0`
const DEL_BTN_CLS = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-destructive'

// 叶子行：字段 240 / 操作符 160 固定对齐；值+删除位成组自适应（窄屏整组换行，不溢出卡片）
function CondLeaf({ leaf, onChange, onRemove, disableRemove }) {
  const set = (patch) => {
    const next = { ...leaf, ...patch }
    // 切到无需取值的操作符清空值；切字段时枚举值类型可能不匹配，重置值
    if (patch.op && NO_VALUE_OPS.includes(patch.op)) next.value = ''
    if (patch.field !== undefined && patch.field !== leaf.field) {
      next.value = ENUM_FIELDS[patch.field] && SET_OPS.includes(next.op) ? [] : ''
    }
    onChange(next)
  }
  return (
    <div className="group flex w-full flex-wrap items-center gap-2 rounded-md px-1 py-1 transition hover:bg-accent">
      <FieldSelect className={LEAF_FIELD_CLS} value={leaf.field} onChange={(v) => set({ field: v })} />
      <CompactSelect size="md" className="w-[160px] shrink-0" value={leaf.op} onChange={(e) => set({ op: e.target.value })}>
        {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </CompactSelect>
      <div className="flex min-w-[140px] flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <ValueInput cond={leaf} onChange={(v) => set({ value: v })} />
        </div>
        <button type="button" className={`${DEL_BTN_CLS} shrink-0`} title="删除条件" disabled={disableRemove} onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// 条件组（递归；depth=1 顶层组、depth=2 第二层组；depth>=2 不允许再嵌组）
function CondGroup({ group, depth, onChange, onRemove }) {
  const setItem = (idx, next) => onChange({ ...group, items: group.items.map((it, i) => (i === idx ? next : it)) })
  const removeItem = (idx) => onChange({ ...group, items: group.items.filter((_, i) => i !== idx) })
  const addLeaf = () => onChange({ ...group, items: [...group.items, defaultLeaf()] })
  const addSub = () => onChange({
    ...group,
    items: [...group.items, { type: 'group', logic: 'all', items: [defaultLeaf()] }],
  })
  const canNest = depth < 2
  return (
    <div className="rounded-lg border border-border border-l-2 border-l-primary/50 bg-muted p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
          {['all', 'any'].map((l) => (
            <button
              key={l} type="button"
              className={`rounded px-2.5 py-1 text-[12px] transition ${group.logic === l ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => onChange({ ...group, logic: l })}
            >
              {l === 'all' ? '全部满足' : '任一满足'}
            </button>
          ))}
        </div>
        {onRemove && (
          <button type="button" className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition hover:bg-accent hover:text-destructive"
            title="删除整个条件组" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />删除组
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {group.items.map((item, i) => (
          item.type === 'group' ? (
            <CondGroup
              key={i} group={item} depth={depth + 1}
              onChange={(next) => setItem(i, next)}
              onRemove={() => removeItem(i)}
            />
          ) : (
            <CondLeaf
              key={i} leaf={item}
              onChange={(next) => setItem(i, next)}
              onRemove={() => removeItem(i)}
              disableRemove={false}
            />
          )
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[12px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
          onClick={addLeaf}>
          <Plus className="h-3.5 w-3.5" />新增条件
        </button>
        {canNest && (
          <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[12px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
            onClick={addSub}>
            <Layers className="h-3.5 w-3.5" />新增条件组
          </button>
        )}
      </div>
    </div>
  )
}

// ===== 字段配置双控件行（取值方式 120px + 值自适应）=====
function FieldMapRow({ field, label, modes, cfg, onChange }) {
  const mode = cfg?.mode || ''
  const value = cfg?.value ?? ''
  const setMode = (m) => onChange({ mode: m, value: m === 'static' ? (field === 'risk_level' ? '1' : '') : m === 'map' ? '' : null })
  let valueCtl = null
  if (mode === 'static') {
    if (field === 'risk_level') {
      valueCtl = (
        <div className="flex flex-wrap items-center gap-1.5">
          {RISK_LEVELS.map((l) => (
            <button key={l.value} type="button"
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition ${String(value) === String(l.value) ? 'border-primary/60 bg-primary/5 font-medium text-foreground' : 'border-border text-muted-foreground hover:border-primary/40'}`}
              onClick={() => onChange({ mode, value: String(l.value) })}>
              <span className={`h-2 w-2 rounded-full ${['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-gray-400'][l.value]}`} />
              {l.label}
            </button>
          ))}
        </div>
      )
    } else {
      valueCtl = (
        <input className={`${inputBaseCls} h-8 w-full`} value={value} maxLength={512}
          onChange={(e) => onChange({ mode, value: e.target.value })}
          placeholder={field === 'alert_name' ? '如 【{threat_type}】{src_ip} 告警（{field} 插值）' : '固定值'} />
      )
    }
  } else if (mode === 'map') {
    valueCtl = (
      <FieldSelect className="w-full" value={value || ''} onChange={(v) => onChange({ mode, value: v })} />
    )
  } else if (mode === 'keep') {
    valueCtl = <input className={`${inputBaseCls} h-8 w-full`} disabled value="" placeholder="保留解析结果（不覆盖）" />
  }
  // 未选模式：值区域整体渲染为一个全宽取值方式下拉（点击即选），
  // 避免出现看似可点实则禁用的"假输入框"（点击无响应）
  if (!mode) {
    return (
      <div className="flex items-center gap-2.5 py-1.5">
        <span className="w-[104px] shrink-0 truncate text-[13px] text-foreground" title={label}>{label}</span>
        <CompactSelect size="md" block className="flex-1" title="选择取值方式" value=""
          onChange={(e) => setMode(e.target.value)}>
          <option value="">请选择取值方式（静态值 / 字段映射 / 保留解析结果）</option>
          {modes.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
        </CompactSelect>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-[104px] shrink-0 truncate text-[13px] text-foreground" title={label}>{label}</span>
      <CompactSelect size="md" className="w-[120px] shrink-0" value={mode} onChange={(e) => setMode(e.target.value)}>
        {modes.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
      </CompactSelect>
      <div className="min-w-[120px] flex-1">{valueCtl}</div>
      <button type="button" className={DEL_BTN_CLS} title="清除该字段配置"
        onClick={() => onChange(null)}>
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}

// ===== 编号分区卡片 =====
function SectionCard({ no, title, desc, children, id }) {
  return (
    <section id={id} className="card p-6">
      <div className="mb-4 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary">
          {no}
        </span>
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          {desc && <p className="mt-0.5 text-[12px] text-muted-foreground">{desc}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

// 表单标签置顶（13px 标签；hint 与 label 基线对齐，超长时整体换行不挤压）
function FormItem({ label, required, hint, children, className }) {
  return (
    <label className={`block space-y-1.5 ${className || ''}`}>
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[13px] text-foreground">
          {label} {required && <span className="text-destructive">*</span>}
        </span>
        {hint && <span className="text-[12px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

// ===== 主组件 =====
export default function AlertRuleEditPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id } = useParams()
  const editingId = id ? Number(id) : null
  const canEdit = hasPermission('alert', 'handle')

  const [form, setForm] = useState(() => ruleToForm(location.state?.initial || null))
  const [initialSnap, setInitialSnap] = useState(() => JSON.stringify(ruleToForm(location.state?.initial || null)))
  const [loading, setLoading] = useState(!!editingId)
  const [rules, setRules] = useState([])
  const [groups, setGroups] = useState([])
  const [deviceTypes, setDeviceTypes] = useState([])
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [isDraftRule, setIsDraftRule] = useState(false)
  const [lastTestOk, setLastTestOk] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [optionalOpen, setOptionalOpen] = useState(false)
  const [aggEnabled, setAggEnabled] = useState(() => !!location.state?.initial?.alert_aggregation)
  // 测试面板
  const [testText, setTestText] = useState('{\n  "risk_level": 1,\n  "alert_name": "Webshell 文件检测",\n  "threat_type": "Webshell",\n  "device_type": "qingteng_wanxiang"\n}')
  const [logsOpen, setLogsOpen] = useState(false)
  const [recentLogs, setRecentLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [pickedIds, setPickedIds] = useState([])

  const setF = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setTree = (next) => setF({ condTree: next })

  // 加载：编辑时按 id 从列表取规则 + 全量规则（优先级位次）+ 分组
  useEffect(() => {
    const tasks = [alertRuleApi.list(), alertRuleGroupApi.list()]
    if (editingId) {
      Promise.all(tasks).then(([res, gs]) => {
        const rows = res.items || []
        setRules(rows)
        setGroups(gs.items || [])
        const row = rows.find((r) => r.id === editingId)
        if (!row) { toast.error('规则不存在或已被删除'); navigate('/alert-rules', { replace: true }); return }
        const f = ruleToForm(row)
        setForm(f)
        setInitialSnap(JSON.stringify(f))
        setIsDraftRule(!!row.draft)
        setAggEnabled(!!row.alert_aggregation)
      }).catch((e) => {
        toast.error(e.message || '加载失败')
        navigate('/alert-rules', { replace: true })
      }).finally(() => setLoading(false))
    } else {
      Promise.all(tasks).then(([res, gs]) => {
        setRules(res.items || [])
        setGroups(gs.items || [])
      }).catch(() => { /* 列表失败不阻塞新建 */ }).finally(() => setLoading(false))
    }
  }, [editingId, navigate])

  // 设备类型建议（datalist）
  useEffect(() => {
    setDeviceTypes([...new Set(rules.map((r) => r.device_type).filter(Boolean))])
  }, [rules])

  // 无权限：只读跳回列表
  useEffect(() => {
    if (!canEdit) { toast.error('没有告警规则的操作权限'); navigate('/alert-rules', { replace: true }) }
  }, [canEdit, navigate])

  const dirty = useMemo(() => JSON.stringify(form) !== initialSnap, [form, initialSnap])

  // 匹配语义变更 → 重置发布门禁（名称/描述/分组/优先级/启停不影响）
  const semanticsKey = useMemo(() => JSON.stringify({
    t: form.type, a: form.action, c: form.condTree, s: form.scope, d: form.device_type,
    st: form.type === 'stats' ? form.stats : null,
    fm: form.fieldMapping, ag: form.aggregation,
  }), [form])
  const semanticsRef = useRef(semanticsKey)
  useEffect(() => {
    if (semanticsRef.current !== semanticsKey) {
      semanticsRef.current = semanticsKey
      setLastTestOk(false)
    }
  }, [semanticsKey])

  // ===== 校验 =====
  const validateForm = () => {
    if (!form.name.trim()) return '规则名称不能为空'
    if (form.scope === 'device_type' && !form.device_type.trim()) return '按设备类型作用域必须指定设备类型'
    if (!Number.isFinite(Number(form.priority)) || Number(form.priority) < 0) return '优先级必须是不小于 0 的整数'
    const count = treeLeafCount(form.condTree)
    if (!count) return '至少需要一条匹配条件'
    if (treeDepth(form.condTree) > 2) return '条件组最多两层嵌套'
    // 递归校验叶子：字段必选、操作符合法、需值操作符必须有值
    const leafOk = (c) => {
      if (!c.field?.trim()) return false
      if (!OPS.some((o) => o.value === c.op)) return false
      if (NO_VALUE_OPS.includes(c.op)) return true
      return !(c.value === '' || c.value == null || (Array.isArray(c.value) && !c.value.length))
    }
    const walkOk = (node) => (node.type === 'group' ? node.items.every(walkOk) : leafOk(node))
    for (const it of form.condTree.items) {
      if (!walkOk(it)) {
        if (it.type === 'group') return '条件组内存在未完成的条件（未选字段或缺比较值）'
        return `条件「${fieldLabel(it.field)}」未选字段或缺少比较值`
      }
    }
    // IP 条件格式校验（与后端硬拦截口径一致）
    const walkIP = (node) => {
      if (node.type === 'group') {
        for (const child of node.items) {
          const e = walkIP(child)
          if (e) return e
        }
        return ''
      }
      const raw = Array.isArray(node.value) ? node.value.join(',') : node.value
      if (!raw?.toString().trim()) return ''
      if (node.op === 'in_cidr') return validateCidrList(raw, fieldLabel(node.field)) || ''
      if (IP_FIELDS.includes(node.field)) return validateIPExpression(raw, fieldLabel(node.field)) || ''
      return ''
    }
    for (const it of form.condTree.items) {
      const ipErr = walkIP(it)
      if (ipErr) return ipErr
    }
    if (form.type === 'stats') {
      const w = Number(form.stats.window.value)
      if (!Number.isFinite(w) || w < 1) return '统计窗口数值必须 ≥ 1'
      if (form.stats.method === 'count_distinct' && !form.stats.distinct_field) return '去重计数必须指定去重字段'
      const th = Number(form.stats.threshold)
      if (!Number.isFinite(th) || th < 1) return '触发阈值必须 ≥ 1'
    }
    if (form.action === 'adjust_level' && !Object.keys(form.levelMap).length) {
      return '调整等级规则至少需要配置一条等级映射'
    }
    if (aggEnabled && form.aggregation && !form.aggregation.keys.length) return '启用告警聚合必须选择聚合键字段'
    // 字段配置：static/map 必须有值
    for (const [target, cfg] of Object.entries(form.fieldMapping)) {
      if (!cfg?.mode) continue
      if (cfg.mode === 'map' && !cfg.value) return `字段「${fieldLabel(target)}」的字段映射未选择来源字段`
      if (cfg.mode === 'static' && (cfg.value === '' || cfg.value == null)) return `字段「${fieldLabel(target)}」的静态值为空`
      // IP 字段静态值格式校验（含 {变量} 模板插值时跳过）
      if (cfg.mode === 'static' && IP_FIELDS.includes(target)
        && String(cfg.value).trim() && !String(cfg.value).includes('{')) {
        const msg = validateIPExpression(cfg.value, fieldLabel(target))
        if (msg) return msg
      }
    }
    return ''
  }

  // ===== 保存（draft 决定草稿语义；keepDraft 保持原状态）=====
  const persist = async (draftFlag, keepDraft = false) => {
    const err = validateForm()
    if (err) { toast.error(err); return null }
    const body = buildRuleBody(form, keepDraft ? isDraftRule : draftFlag)
    setSaving(true)
    try {
      let saved
      if (editingId == null) saved = await alertRuleApi.create(body)
      else saved = await alertRuleApi.update(editingId, body)
      setInitialSnap(JSON.stringify(form))
      if (!keepDraft) setIsDraftRule(!!draftFlag)
      return saved
    } catch (e) {
      toast.error(e.message || '保存失败')
      return null
    } finally { setSaving(false) }
  }

  const saveDraft = async () => {
    const saved = await persist(true)
    if (saved) {
      toast.success('已存为草稿（不参与线上匹配，可在列表页继续编辑或发布）')
      bypassGuard()
      navigate('/alert-rules')
    }
  }

  // 编辑已发布规则的「保存修改」：保持已发布状态直接生效
  const saveNormal = async () => {
    const saved = await persist(false, true)
    if (saved) {
      toast.success('规则已保存，立即生效')
      bypassGuard()
      navigate('/alert-rules')
    }
  }

  // ===== 测试 =====
  const parseSamples = () => {
    const text = testText.trim()
    if (!text) throw new Error('请先填写测试样例')
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error('样例不是合法 JSON') }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    for (const it of arr) {
      if (typeof it !== 'object' || it === null || Array.isArray(it)) {
        throw new Error('每条样例必须是 JSON 对象（字段名 → 值）')
      }
    }
    if (arr.length > 10) throw new Error('样例最多 10 条')
    return arr
  }

  const runTest = async () => {
    let samples
    try { samples = parseSamples() } catch (e) { toast.error(e.message); return }
    // 草稿参与匹配（表单不完整时仅测试已保存规则）
    let draft = null
    const err = validateForm()
    if (!err) draft = buildRuleBody(form, true)
    setTesting(true)
    try {
      const res = await alertRuleApi.test(samples.map((fields) => ({ fields })), draft)
      setTestResult(res)
      // 发布门禁：草稿（id=0）在任一样例上生效即通过
      const ok = (res.results || []).some((r) => r.final?.rule_id === 0)
      setLastTestOk(ok)
      if (ok) toast.success('测试通过：当前规则在样例上生效，可发布')
      else toast.warning('测试未通过：当前规则未在任何样例上生效，请调整条件或更换样例')
    } catch (e) {
      toast.error(e.message || '测试失败')
    } finally { setTesting(false) }
  }

  // ===== 测试并发布（门禁：lastTestOk）=====
  const saveAndPublish = async () => {
    if (!lastTestOk) {
      toast.error('请先在右侧测试面板运行测试并通过，再发布')
      return
    }
    let samples
    try { samples = parseSamples() } catch (e) { toast.error(e.message); return }
    const err = validateForm()
    if (err) { toast.error(err); return }
    setPublishing(true)
    try {
      // 1) 保存（保持/设置草稿态，发布由服务端复验后置 draft=0）
      const saved = await persist(true, editingId != null)
      if (!saved) return
      const rid = saved.id || editingId
      // 2) 发布（服务端用同批样例复验）
      await alertRuleApi.publish(rid, samples.map((fields) => ({ fields })))
      toast.success('规则已发布，立即参与线上匹配')
      bypassGuard()
      navigate('/alert-rules')
    } catch (e) {
      toast.error(e.message || '发布失败')
    } finally { setPublishing(false) }
  }

  const bypassGuard = useUnsavedChanges(dirty, { onSave: saveNormal })

  // ===== 最近日志挑选 =====
  const loadRecentLogs = useCallback(() => {
    setLogsLoading(true)
    devicesApi.logReceivers.receiveLogs({ parse_status: 'success', page: 1, page_size: 20 })
      .then((res) => { setRecentLogs(res.items || []); setPickedIds([]) })
      .catch((e) => toast.error(e.message || '最近日志加载失败'))
      .finally(() => setLogsLoading(false))
  }, [])

  const importPickedLogs = () => {
    const picked = recentLogs.filter((l) => pickedIds.includes(l.id))
    if (!picked.length) { toast.error('请先勾选日志'); return }
    const samples = picked.map((l) => {
      try { return JSON.parse(l.parsed_fields || '{}') } catch { return {} }
    })
    setTestText(JSON.stringify(samples, null, 2))
    setLogsOpen(false)
    toast.success(`已导入 ${samples.length} 条日志的解析字段`)
  }

  // ===== 名称模板预览（用第一条样例渲染）=====
  const firstSample = useMemo(() => {
    try {
      const p = JSON.parse(testText.trim())
      return Array.isArray(p) ? p[0] : p
    } catch { return null }
  }, [testText])
  const nameCfg = form.fieldMapping.alert_name
  const namePreview = nameCfg?.mode === 'static' && nameCfg.value
    ? renderTemplateLocal(nameCfg.value, firstSample || {})
    : ''

  // ===== 优先级位次 =====
  const priorityPos = useMemo(() => {
    const sorted = rules
      .filter((r) => editingId == null || r.id !== editingId)
      .sort((a, b) => (a.priority - b.priority) || (a.id - b.id))
    const p = Number(form.priority) || 0
    return { pos: sorted.filter((r) => r.priority <= p).length + 1, total: sorted.length + 1 }
  }, [rules, form.priority, editingId])

  // ===== 右栏人类可读摘要 =====
  const humanSummary = useMemo(() => {
    const conds = (form.condTree.items || []).length
      ? condTreeText(form.condTree)
      : '（未配置条件）'
    const levelCfg = form.fieldMapping.risk_level
    const levelText = levelCfg?.mode === 'static' ? riskLevelName(levelCfg.value) : '解析结果等级'
    if (form.type === 'stats') {
      const s = form.stats
      const g = s.group_by.length ? `同一${s.group_by.map(fieldLabel).join('+')}` : '全部事件'
      const m = s.method === 'count_distinct' ? `「${fieldLabel(s.distinct_field)}」去重后数量` : '事件数'
      let text = `${g} 在 ${s.window.value} ${unitName(s.window.unit)}内 ${m} ≥ ${s.threshold} 时，产生${levelText}告警`
      if (conds !== '（未配置条件）') text += `（仅统计满足条件的日志：${conds}）`
      if (form.aggregation) text += `；相近告警将按 ${form.aggregation.keys.map(fieldLabel).join('+')} ${form.aggregation.window.value}${unitName(form.aggregation.window.unit)}内聚合`
      return text
    }
    let text = `当 ${conds} 的日志出现时`
    if (form.action === 'suppress') text += '，抑制告警（不产生告警，仅保留接收明细）'
    else if (form.action === 'adjust_level') text += `，产生告警并按映射调整等级（当前${levelText}兜底）`
    else text += `，产生${levelText}告警`
    if (form.aggregation && form.action !== 'suppress') {
      text += `；相近告警将按 ${form.aggregation.keys.map(fieldLabel).join('+')} ${form.aggregation.window.value}${unitName(form.aggregation.window.unit)}内聚合`
    }
    return text
  }, [form])

  // ===== 渲染 =====
  if (loading) {
    return (
      <PageContainer>
        <div className="py-20 text-center text-[13px] text-muted-foreground">加载中…</div>
      </PageContainer>
    )
  }

  const tree = form.condTree
  const setTopLogic = (logic) => setTree({ ...tree, logic })
  const setTopItem = (i, next) => setTree({ ...tree, items: tree.items.map((it, idx) => (idx === i ? next : it)) })
  const removeTopItem = (i) => setTree({ ...tree, items: tree.items.filter((_, idx) => idx !== i) })
  const addTopLeaf = () => setTree({ ...tree, items: [...tree.items, defaultLeaf()] })
  const addTopGroup = () => setTree({ ...tree, items: [...tree.items, { type: 'group', logic: 'any', items: [defaultLeaf()] }] })

  const optionalConfigured = FIELDMAP_OPTIONAL.filter((f) => form.fieldMapping[f]?.mode).length
  const mainConfigured = FIELDMAP_MAIN_FIELDS.filter((f) => form.fieldMapping[f]?.mode).length

  const isPublishedEdit = editingId != null && !isDraftRule
  const publishBtnText = isPublishedEdit ? '测试并上线' : '测试并发布'
  const saveBtnText = isPublishedEdit ? '保存修改' : '存为草稿'

  return (
    <PageContainer>
      {/* ===== 页头（吸顶）===== */}
      <div className="sticky top-0 z-sticky -mx-6 mb-4 border-b border-border bg-background px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="返回列表"
            onClick={() => navigate('/alert-rules')}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">
              {editingId == null ? '新建告警规则' : `编辑告警规则 #${editingId}`}
              {editingId != null && isDraftRule && <Badge variant="warning" className="ml-2">草稿</Badge>}
            </h2>
            {dirty && <span className="text-[11.5px] text-warning">有未保存的修改</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {lastTestOk && (
              <span className="flex items-center gap-1 text-[12px] text-success">
                <Check className="h-3.5 w-3.5" />测试已通过
              </span>
            )}
            <Button variant="secondary" onClick={isPublishedEdit ? saveNormal : saveDraft} disabled={saving || publishing}>
              {saving ? '保存中…' : saveBtnText}
            </Button>
            <Button
              onClick={saveAndPublish}
              disabled={!lastTestOk || saving || publishing}
              title={lastTestOk ? '保存并用测试样例复验后上线' : '请先在右侧测试面板运行测试并通过'}
            >
              {publishing ? '发布中…' : publishBtnText}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 xl:flex-row">
        {/* ===== 左栏：①-⑤ 分区（max-w 760）===== */}
        <div className="w-full max-w-[760px] space-y-4">
          {/* ① 基本信息 */}
          <SectionCard no="①" title="基本信息" desc="规则名称全局唯一；草稿不参与线上匹配">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormItem label="规则名称" required>
                <input className={inputBaseCls} value={form.name} maxLength={255}
                  onChange={(e) => setF({ name: e.target.value })} placeholder="如：暴力破解-登录失败聚合" />
              </FormItem>
              <FormItem label="规则分组">
                <CompactSelect size="lg" block value={form.group} onChange={(e) => setF({ group: e.target.value })}>
                  {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
                  {!groups.some((g) => g.name === form.group) && form.group && <option value={form.group}>{form.group}</option>}
                </CompactSelect>
              </FormItem>
              <FormItem label="优先级" hint={`越小越先匹配 · 第 ${priorityPos.pos}/${priorityPos.total} 位`}>
                <input type="number" min="0" className={inputBaseCls} value={form.priority}
                  onChange={(e) => setF({ priority: e.target.value })} />
              </FormItem>
              <FormItem label="启用状态">
                <div className="flex h-[38px] items-center gap-2.5">
                  <button
                    type="button" role="switch" aria-checked={form.enabled}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${form.enabled ? 'bg-primary' : 'bg-input'}`}
                    onClick={() => setF({ enabled: !form.enabled })}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                  <span className="text-[13px] text-muted-foreground">{form.enabled ? '已启用，参与线上匹配' : '已停用，不参与线上匹配'}</span>
                </div>
              </FormItem>
            </div>
            <FormItem label="描述" className="mt-4">
              <textarea className={`${inputBaseCls} h-20 resize-none`} value={form.description} maxLength={255}
                onChange={(e) => setF({ description: e.target.value })} placeholder="选填，说明规则用途与排查思路" />
              <div className="text-right text-[11px] text-muted-foreground">{form.description.length}/255</div>
            </FormItem>
          </SectionCard>

          {/* ② 规则类型 */}
          <SectionCard no="②" title="规则类型" desc="Tab 切换后下方「规则配置」联动变化">
            <div className="grid grid-cols-3 gap-3">
              {[
                { value: 'match', icon: CircleDot },
                { value: 'stats', icon: FlaskConical },
                { value: 'correlation', icon: Link2 },
              ].map(({ value: v, icon: Icon }) => {
                const disabled = v === 'correlation'
                const active = form.type === v
                return (
                  <button
                    key={v} type="button" disabled={disabled}
                    title={disabled ? '规划中（P2 预留）' : undefined}
                    className={`rounded-lg border p-3 text-left transition ${active ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/20' : 'border-border hover:border-primary/40 hover:bg-accent'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                    onClick={() => setF({ type: v, action: v === 'stats' ? 'alert' : form.action })}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-primary" />
                      <span className="text-[13.5px] font-medium">{v === 'match' ? '匹配' : v === 'stats' ? '统计' : '关联'}</span>
                      {active && <Check className="ml-auto h-4 w-4 text-primary" />}
                    </div>
                    <div className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      {v === 'match' ? '单条日志命中条件即触发' : v === 'stats' ? '时间窗口内计数达阈值触发' : '多条件按时间先后关联触发（规划中）'}
                    </div>
                  </button>
                )
              })}
            </div>
          </SectionCard>

          {/* ③ 规则配置 */}
          <SectionCard no="③" title="规则配置" desc={form.type === 'stats' ? '匹配条件为统计的输入筛选；仅统计满足条件的日志' : '命中条件的日志按「输出与字段配置」产生告警'}>
            {/* 检测范围 */}
            <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormItem label="适用设备类型">
                <div className="flex gap-2">
                  {[
                    { value: 'global', label: '全部' },
                    { value: 'device_type', label: '指定' },
                  ].map(({ value: v, label }) => (
                    <button key={v} type="button"
                      className={`h-8 flex-1 rounded-md border text-[13px] transition ${form.scope === v ? 'border-primary/60 bg-primary/5 font-medium text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}
                      onClick={() => setF({ scope: v })}>
                      {label}
                    </button>
                  ))}
                </div>
              </FormItem>
              <FormItem label="设备类型" required={form.scope === 'device_type'}>
                <input className={inputBaseCls} value={form.device_type} list="rule-device-types"
                  disabled={form.scope !== 'device_type'}
                  onChange={(e) => setF({ device_type: e.target.value })} placeholder="如 qingteng_wanxiang" />
                <datalist id="rule-device-types">{deviceTypes.map((t) => <option key={t} value={t} />)}</datalist>
              </FormItem>
            </div>

            {/* 匹配条件构建器 */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] text-foreground">
                匹配条件 <span className="ml-1 text-[12px] text-muted-foreground">（{treeLeafCount(tree)} 条）</span>
              </span>
              <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
                {['all', 'any'].map((l) => (
                  <button key={l} type="button"
                    className={`rounded px-2.5 py-1 text-[12px] transition ${tree.logic === l ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-accent'}`}
                    onClick={() => setTopLogic(l)}>
                    {l === 'all' ? '全部满足 (AND)' : '任一满足 (OR)'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              {tree.items.map((item, i) => (
                item.type === 'group' ? (
                  <CondGroup key={i} group={item} depth={1} onChange={(next) => setTopItem(i, next)} onRemove={() => removeTopItem(i)} />
                ) : (
                  <CondLeaf key={i} leaf={item} onChange={(next) => setTopItem(i, next)} onRemove={() => removeTopItem(i)} disableRemove={false} />
                )
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[12px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                onClick={addTopLeaf}>
                <Plus className="h-3.5 w-3.5" />新增条件
              </button>
              <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[12px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                onClick={addTopGroup}>
                <Layers className="h-3.5 w-3.5" />新增条件组
              </button>
            </div>

            {/* 统计配置（type=stats） */}
            {form.type === 'stats' && (
              <div className="mt-4 rounded-lg border border-border bg-muted p-4">
                <div className="mb-3 text-[13px] font-medium text-foreground">统计配置</div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FormItem label="统计时间窗口">
                    <div className="flex gap-2">
                      <input type="number" min="1" className={`${inputBaseCls} h-8 w-24`} value={form.stats.window.value}
                        onChange={(e) => setF({ stats: { ...form.stats, window: { ...form.stats.window, value: e.target.value } } })} />
                      <CompactSelect size="md" className="w-28" value={form.stats.window.unit}
                        onChange={(e) => setF({ stats: { ...form.stats, window: { ...form.stats.window, unit: e.target.value } } })}>
                        {WINDOW_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                      </CompactSelect>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1.5">
                      {QUICK_WINDOWS.map((q) => (
                        <button key={q.label} type="button"
                          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${Number(form.stats.window.value) === q.value && form.stats.window.unit === q.unit ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}
                          onClick={() => setF({ stats: { ...form.stats, window: { value: q.value, unit: q.unit } } })}>
                          {q.label}
                        </button>
                      ))}
                    </div>
                  </FormItem>
                  <FormItem label="统计方式">
                    <CompactSelect size="lg" block value={form.stats.method}
                      onChange={(e) => setF({ stats: { ...form.stats, method: e.target.value } })}>
                      <option value="count">计数（不去重）</option>
                      <option value="count_distinct">去重计数</option>
                    </CompactSelect>
                    {form.stats.method === 'count_distinct' && (
                      <div className="pt-1.5">
                        <FieldSelect className="w-full" value={form.stats.distinct_field}
                          onChange={(v) => setF({ stats: { ...form.stats, distinct_field: v } })} />
                      </div>
                    )}
                  </FormItem>
                  <FormItem label="分组字段（group by）" hint="每个分组独立计数">
                    <div className="flex flex-wrap gap-1.5">
                      {['src_ip', 'dst_ip', 'account_name', 'host_ip', 'device_type', 'threat_type'].map((f) => {
                        const on = form.stats.group_by.includes(f)
                        return (
                          <button key={f} type="button"
                            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${on ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}
                            onClick={() => setF({
                              stats: { ...form.stats, group_by: on ? form.stats.group_by.filter((x) => x !== f) : [...form.stats.group_by, f] },
                            })}>
                            {fieldLabel(f)}
                          </button>
                        )
                      })}
                    </div>
                  </FormItem>
                  <FormItem label="触发阈值" hint="窗口内计数 ≥ N 时触发">
                    <input type="number" min="1" className={`${inputBaseCls} h-8 w-32 font-mono`} value={form.stats.threshold}
                      onChange={(e) => setF({ stats: { ...form.stats, threshold: e.target.value } })} />
                  </FormItem>
                </div>
                {/* 实时人类可读预览 */}
                <div className="mt-3 rounded-md bg-background px-3 py-2 text-[12px] text-muted-foreground">
                  {statsPreviewText(form.stats)}
                </div>
              </div>
            )}
          </SectionCard>

          {/* ④ 输出与字段配置 */}
          <SectionCard no="④" title="输出与字段配置" desc="取值方式：静态值（固定文本/等级）/ 字段映射（取解析字段）/ 保留解析结果">
            {form.type === 'stats' && (
              <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
                统计类规则固定「生成告警」，在计数达到阈值时按以下字段配置产生告警。
              </div>
            )}
            {form.type !== 'stats' && (
              <div className="mb-3 grid grid-cols-3 gap-3">
                {Object.entries(ACTION_META).map(([value, meta]) => (
                  <button key={value} type="button"
                    className={`rounded-lg border p-2.5 text-left transition ${form.action === value ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/20' : 'border-border hover:border-primary/40 hover:bg-accent'}`}
                    onClick={() => setF({ action: value })}>
                    <div className="flex items-center justify-between">
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {form.action === value && <Check className="h-3.5 w-3.5 text-primary" />}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {form.action === 'suppress' && form.type !== 'stats' ? (
              <div className="rounded-lg border border-border bg-muted p-4">
                <FormItem label="抑制原因" hint="进命中记录留痕">
                  <input className={inputBaseCls} value={form.suppressReason} maxLength={512}
                    onChange={(e) => setF({ suppressReason: e.target.value })} placeholder="如：健康检查误报，无需告警" />
                </FormItem>
                <p className="mt-2 text-[12px] text-muted-foreground">抑制规则命中后不产生告警，仅保留接收明细与命中记录。</p>
              </div>
            ) : form.action === 'adjust_level' && form.type !== 'stats' ? (
              <div className="rounded-lg border border-border bg-muted p-4">
                <div className="text-[13px] text-foreground">等级映射（原等级 → 新等级，未映射的等级保留原值）</div>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {RISK_LEVELS.map((l) => (
                    <div key={l.value} className="flex items-center gap-2">
                      <span className="w-[86px] shrink-0 text-[12.5px]">{l.label}（{l.value}）</span>
                      <span className="text-muted-foreground">→</span>
                      <CompactSelect size="md" className="flex-1" value={form.levelMap[l.value] ?? ''}
                        onChange={(e) => {
                          const next = { ...form.levelMap }
                          if (e.target.value === '') delete next[l.value]
                          else next[l.value] = Number(e.target.value)
                          setF({ levelMap: next })
                        }}>
                        <option value="">保留原值</option>
                        {RISK_LEVELS.map((x) => <option key={x.value} value={x.value}>调整为 {x.label}（{x.value}）</option>)}
                      </CompactSelect>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* 常用字段配置行 */}
                <div className="divide-y divide-border">
                  {FIELDMAP_MAIN.map((row) => (
                    <FieldMapRow
                      key={row.field} field={row.field} label={row.label} modes={row.modes}
                      cfg={form.fieldMapping[row.field]}
                      onChange={(next) => {
                        const fm = { ...form.fieldMapping }
                        if (next) fm[row.field] = next
                        else delete fm[row.field]
                        setF({ fieldMapping: fm })
                      }}
                    />
                  ))}
                </div>
                {/* 名称模板变量插入 + 预览 */}
                {form.fieldMapping.alert_name?.mode === 'static' && (
                  <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11.5px] text-muted-foreground">插入变量：</span>
                      {TEMPLATE_VARS.map((v) => (
                        <button key={v} type="button"
                          className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                          onClick={() => setF({
                            fieldMapping: {
                              ...form.fieldMapping,
                              alert_name: { mode: 'static', value: `${form.fieldMapping.alert_name.value}{${v}}` },
                            },
                          })}>
                          {`{${v}}`}
                        </button>
                      ))}
                    </div>
                    <div className="text-[12px]">
                      <span className="text-muted-foreground">名称预览：</span>
                      <span className="font-medium">{namePreview || '（空）'}</span>
                      {!firstSample && <span className="ml-1.5 text-[11px] text-muted-foreground">（在右侧测试面板填入样例后按样例字段渲染）</span>}
                    </div>
                  </div>
                )}
                {/* 可选字段折叠区 */}
                <button type="button"
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[12.5px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  onClick={() => setOptionalOpen((v) => !v)}>
                  <Plus className="h-3.5 w-3.5" />
                  添加可选字段（已配置 {mainConfigured + optionalConfigured}/{FIELDMAP_MAIN.length + FIELDMAP_OPTIONAL.length} 条）
                  <ChevronDown className={`h-3.5 w-3.5 transition ${optionalOpen ? 'rotate-180' : ''}`} />
                </button>
                {optionalOpen && (
                  <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-muted px-3 py-1">
                    {FIELDMAP_OPTIONAL.map((f) => (
                      <FieldMapRow
                        key={f} field={f} label={fieldLabel(f)} modes={['map', 'static', 'keep']}
                        cfg={form.fieldMapping[f]}
                        onChange={(next) => {
                          const fm = { ...form.fieldMapping }
                          if (next) fm[f] = next
                          else delete fm[f]
                          setF({ fieldMapping: fm })
                        }}
                      />
                    ))}
                  </div>
                )}
                {/* 附加标签 */}
                <FormItem label="附加标签" hint="追加到风险标签，最多 10 个" className="mt-4">
                  <input className={inputBaseCls} value={form.tags.join('，')}
                    onChange={(e) => setF({ tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 10) })}
                    placeholder="多个标签用逗号分隔" />
                </FormItem>
              </>
            )}
          </SectionCard>

          {/* ⑤ 告警聚合 */}
          <SectionCard no="⑤" title="告警聚合" desc="告警生成侧去重：同键同窗的告警合并为一条，聚合计数累加（与统计触发不同）">
            {!aggEnabled ? (
              <button type="button"
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-[12.5px] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                onClick={() => { setAggEnabled(true); setF({ aggregation: form.aggregation || { window: { value: 30, unit: 'minute' }, keys: [] } }) }}>
                <Plus className="h-3.5 w-3.5" />启用告警聚合
              </button>
            ) : (
              <div className="space-y-4 rounded-lg border border-border bg-muted p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-foreground">满足以下条件的多条告警将聚合为一条，聚合计数在告警详情中展示</span>
                  <button type="button"
                    className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition hover:bg-accent hover:text-destructive"
                    onClick={() => confirm({
                      title: '停用告警聚合',
                      message: '停用后，同键同窗的告警将各自产生独立记录。确认停用？',
                      variant: 'warning',
                      confirmText: '停用',
                    }).then((ok) => { if (ok) { setAggEnabled(false); setF({ aggregation: null }) } })}>
                    <Trash2 className="h-3.5 w-3.5" />停用
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FormItem label="聚合时间窗口">
                    <div className="flex gap-2">
                      <input type="number" min="1" className={`${inputBaseCls} h-8 w-24`} value={form.aggregation.window.value}
                        onChange={(e) => setF({ aggregation: { ...form.aggregation, window: { ...form.aggregation.window, value: e.target.value } } })} />
                      <CompactSelect size="md" className="w-28" value={form.aggregation.window.unit}
                        onChange={(e) => setF({ aggregation: { ...form.aggregation, window: { ...form.aggregation.window, unit: e.target.value } } })}>
                        {WINDOW_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                      </CompactSelect>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1.5">
                      {QUICK_AGGS.map((q) => (
                        <button key={q.label} type="button"
                          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${Number(form.aggregation.window.value) === q.value && form.aggregation.window.unit === q.unit ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}
                          onClick={() => setF({ aggregation: { ...form.aggregation, window: { value: q.value, unit: q.unit } } })}>
                          {q.label}
                        </button>
                      ))}
                    </div>
                  </FormItem>
                  <FormItem label="聚合键字段" hint="常用项置顶，可多选">
                    <div className="flex flex-wrap gap-1.5">
                      {['src_ip', 'dst_ip', 'threat_type', 'account_name', 'alert_name', 'device_type', 'host_ip'].map((f) => {
                        const on = form.aggregation.keys.includes(f)
                        return (
                          <button key={f} type="button"
                            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${on ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'}`}
                            onClick={() => setF({
                              aggregation: { ...form.aggregation, keys: on ? form.aggregation.keys.filter((x) => x !== f) : [...form.aggregation.keys, f] },
                            })}>
                            {fieldLabel(f)}
                          </button>
                        )
                      })}
                    </div>
                    <div className="pt-1.5">
                      <FieldSelect className="w-full" value=""
                        onChange={(v) => {
                          if (v && !form.aggregation.keys.includes(v)) {
                            setF({ aggregation: { ...form.aggregation, keys: [...form.aggregation.keys, v] } })
                          }
                        }} />
                      <div className="text-[11px] text-muted-foreground">从全部标准字段中追加（已选 {form.aggregation.keys.length} 个）</div>
                    </div>
                  </FormItem>
                </div>
                {/* 实时人类可读预览 */}
                <div className="rounded-md bg-background px-3 py-2 text-[12px] text-muted-foreground">
                  {form.aggregation.keys.length
                    ? <>发生时间相差不超过 <span className="text-foreground">{form.aggregation.window.value} {unitName(form.aggregation.window.unit)}</span> 且 <span className="text-foreground">{form.aggregation.keys.map(fieldLabel).join('、')}</span> 均相同的告警，将会被聚合为一条</>
                    : <span className="text-warning">尚未选择聚合键字段</span>}
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        {/* ===== 右栏：sticky 摘要 + 测试面板 ===== */}
        <div className="w-full min-w-0 space-y-4 xl:flex-1">
          <div className="space-y-4 xl:sticky xl:top-[72px]">
            {/* 规则摘要 */}
            <div className="card border-primary/20 bg-primary/[0.04] p-5">
              <div className="mb-2 text-[13px] font-semibold text-foreground">规则摘要</div>
              <p className="text-[13px] leading-relaxed text-foreground">{humanSummary}</p>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border pt-3 text-[12px]">
                <SummaryRow k="类型" v={form.type === 'stats' ? (form.stats.method === 'count_distinct' ? '统计(去重)' : '统计(不去重)') : '匹配'} />
                <SummaryRow k="优先级" v={`${form.priority}（第 ${priorityPos.pos} 位）`} />
                <SummaryRow k="分组" v={form.group || '--'} />
                <SummaryRow k="作用范围" v={form.scope === 'global' ? '全部设备' : form.device_type || '未指定'} />
                <SummaryRow k="条件数" v={`${treeLeafCount(tree)} 条`} />
                <SummaryRow k="聚合" v={aggEnabled && form.aggregation?.keys?.length ? `${form.aggregation.window.value}${unitName(form.aggregation.window.unit)} / ${form.aggregation.keys.length} 键` : '未启用'} />
              </div>
            </div>

            {/* 测试面板 */}
            <div className="card p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                  <FlaskConical className="h-4 w-4 text-primary" />保存前测试
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { setLogsOpen((v) => !v); if (!logsOpen) loadRecentLogs() }}>
                    {logsOpen ? '收起日志' : '最近日志'}
                  </Button>
                  <Button size="sm" onClick={runTest} disabled={testing}>
                    <Play className="mr-1 h-3.5 w-3.5" />{testing ? '测试中…' : '运行测试'}
                  </Button>
                </div>
              </div>
              <p className="mb-2 text-[11.5px] leading-relaxed text-muted-foreground">
                只读预览：不落库、不产生真实告警与通知。当前编辑中的规则作为草稿按优先级参与匹配；
                {form.type === 'stats' && ' 统计规则多条样例默认视为同窗口事件（可用 occur_timestamp 标记时间）。'}
              </p>
              <textarea
                className={`${inputBaseCls} h-36 resize-none font-mono text-[12px] leading-relaxed`}
                value={testText} onChange={(e) => { setTestText(e.target.value); setTestResult(null) }} spellCheck={false}
              />
              {/* 最近日志挑选 */}
              {logsOpen && (
                <div className="mt-3 rounded-lg border border-border bg-muted p-2.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11.5px] text-muted-foreground">
                      最近解析成功的日志（勾选后导入其解析字段）{logsLoading && <span className="ml-1 text-primary">加载中…</span>}
                    </span>
                    <div className="flex gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => setPickedIds(recentLogs.map((l) => l.id))}>全选</Button>
                      <Button size="sm" onClick={importPickedLogs} disabled={!pickedIds.length}>
                        导入{pickedIds.length ? `（${pickedIds.length}）` : ''}
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {recentLogs.map((l) => {
                      const checked = pickedIds.includes(l.id)
                      return (
                        <button key={l.id} type="button"
                          className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition ${checked ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-accent'}`}
                          onClick={() => setPickedIds(checked ? pickedIds.filter((x) => x !== l.id) : [...pickedIds, l.id])}>
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-primary bg-primary text-white' : 'border-border'}`}>
                            {checked && <Check className="h-3 w-3" />}
                          </span>
                          <span className="w-[110px] shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">{l.source_ip || '--'}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={l.raw_data}>{l.raw_data}</span>
                        </button>
                      )
                    })}
                    {!logsLoading && !recentLogs.length && (
                      <div className="py-4 text-center text-[12px] text-muted-foreground">暂无解析成功的日志</div>
                    )}
                  </div>
                </div>
              )}
              {/* 测试结果 */}
              <div className="mt-3 max-h-[520px] space-y-2.5 overflow-y-auto">
                {!testResult ? (
                  <div className="rounded-lg border border-dashed border-border py-6 text-center text-[12px] text-muted-foreground">
                    填写样例后点击「运行测试」
                  </div>
                ) : (
                  (testResult.results || []).map((r, i) => <TestResultCard key={i} idx={i} r={r} />)
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}

// ===== 摘要行 =====
function SummaryRow({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="truncate text-right text-foreground" title={String(v)}>{v}</span>
    </div>
  )
}

// ===== 测试结果卡片（匹配链 / 统计模拟 / 最终动作）=====
function TestResultCard({ idx, r }) {
  const final = r.final || {}
  const outcomeMeta = {
    alert: { label: '产生告警', cls: 'bg-success/10 text-success border-success/30' },
    suppressed: { label: '被抑制', cls: 'bg-muted text-muted-foreground border-border' },
    stats_waiting: { label: '统计窗口累计中', cls: 'bg-warning/10 text-warning border-warning/30' },
    no_rule: { label: '不产生告警', cls: 'bg-muted text-muted-foreground border-border' },
  }[final.outcome] || { label: final.outcome, cls: 'bg-muted text-muted-foreground border-border' }
  const isDraft = final.rule_id === 0
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium">样例 #{idx + 1}</span>
        <span className={`rounded border px-2 py-0.5 text-[11px] ${outcomeMeta.cls}`}>
          {outcomeMeta.label}{isDraft && final.outcome !== 'no_rule' ? '（当前规则）' : ''}
        </span>
      </div>
      {/* 最终动作 */}
      <div className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {final.note}
        {final.alert_name != null && final.outcome === 'alert' && <> · 名称：<span className="font-medium text-foreground">{final.alert_name || '（空）'}</span></>}
        {final.risk_level != null && final.outcome === 'alert' && <> · 等级：<span className="font-medium text-foreground">{riskLevelName(final.risk_level)}</span></>}
        {final.tags && <> · 标签：<span className="font-medium text-foreground">{final.tags}</span></>}
      </div>
      {/* 匹配链 */}
      {(r.chain || []).length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border pt-1.5">
          {r.chain.map((c, ci) => (
            <div key={ci} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
              <span className={c.matched ? 'text-success' : 'text-muted-foreground'}>
                {c.matched ? '✓ 命中' : '✗ 未命中'}
              </span>
              <span className="font-medium text-foreground">{c.rule_name}{c.rule_id === 0 ? '（草稿）' : ''}</span>
              <Badge variant={ACTION_META[c.action]?.variant || 'neutral'}>{ACTION_META[c.action]?.label || c.action}</Badge>
              {c.reason && <span className="text-muted-foreground">{c.reason}</span>}
              {!c.matched && (c.details || []).length > 0 && (
                <span className="text-muted-foreground">
                  {condDetailsText(c.details)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {/* 统计模拟 */}
      {(r.stats_info || []).length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border pt-1.5">
          {r.stats_info.map((s, si) => (
            <div key={si} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
              <span className={s.triggered ? 'text-success' : s.matched ? 'text-warning' : 'text-muted-foreground'}>
                {s.triggered ? '✓ 达阈值触发' : s.matched ? '⏳ 窗口累计' : '— 未计入'}
              </span>
              <span className="font-medium text-foreground">{s.rule_name}{s.rule_id === 0 ? '（草稿）' : ''}</span>
              {s.matched && (
                <span className="text-muted-foreground">
                  分组「{s.group_key || '全部'}」：{s.count}/{s.threshold}{s.triggered ? ' 已触发' : ' 未达'}
                </span>
              )}
              {!s.matched && s.reason && <span className="text-muted-foreground">{s.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 嵌套条件明细文本（未命中的叶/组，标注 false 的条件）
function condDetailsText(details) {
  const parts = []
  const walk = (nodes) => {
    nodes.forEach?.((d) => {
      if (d?.type === 'group') {
        parts.push(`(${d.logic === 'any' ? '任一' : '全部'})`)
        walk(d.items || [])
      } else if (d && d.passed === false) {
        parts.push(`${fieldLabel(d.field)} ${opLabel(d.op)}${NO_VALUE_OPS.includes(d.op) ? '' : ` ${fmtCondValue(d.field, d.op, d.value)}`}✗`)
      }
    })
  }
  walk(details)
  return parts.join(' ')
}

// 统计配置人类可读预览
function statsPreviewText(stats) {
  const g = stats.group_by.length ? `按 ${stats.group_by.map(fieldLabel).join('+')} 分组，` : ''
  const m = stats.method === 'count_distinct' ? `「${fieldLabel(stats.distinct_field)}」去重计数` : '事件数'
  return `${g}${stats.window.value} ${unitName(stats.window.unit)}内 ${m} ≥ ${stats.threshold} 时触发`
}

// 条件树文本（右栏摘要用；组加括号）
function condTreeText(tree) {
  const joiner = tree.logic === 'any' ? ' 或 ' : ' 且 '
  const node = (n) => {
    if (n.type === 'group') {
      return `(${n.items.map(node).join(n.logic === 'any' ? ' 或 ' : ' 且 ')})`
    }
    return `${fieldLabel(n.field)} ${opLabel(n.op)}${NO_VALUE_OPS.includes(n.op) ? '' : ` ${fmtCondValue(n.field, n.op, n.value)}`}`
  }
  return (tree.items || []).map(node).join(joiner)
}
