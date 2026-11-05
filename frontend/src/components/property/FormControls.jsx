// 可复用的表单控件：所有输入框宽度 100% 填满父容器
// 深色主题，与现有 PropertyPanel 风格一致

import { useState, useMemo, useRef, useEffect } from 'react'
import { Paperclip, X } from 'lucide-react'
import { useWorkflowStore } from '../../store/workflowStore'
import InfoTip from '../InfoTip'
import {CompactSelect, AutoGrowTextarea } from '../ui'

// 基础样式（不含宽度），用于 flex 行内需要自定义宽度的元素
// 避免 w-full 与 flex-1 / w-24 同行时产生宽度冲突导致溢出
// 使用语义令牌（border-input / bg-background / text-foreground / focus:ring-primary）
// 明暗主题切换零改动，避免硬编码 gray-* 在亮色主题下不可见
export const inputBaseCls =
  'rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary'
// 完整样式：基础 + w-full，用于独立占满父容器宽度的输入框
export const inputCls = `${inputBaseCls} w-full`
export const textareaCls = `${inputCls} resize-y font-mono`
export const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground'
export const hintCls = 'mt-1 text-[11px] leading-relaxed text-muted-foreground'

// 带可选 InfoTip 的 label 渲染辅助函数
// 将原来的 label 下方小字 hint 改为 label 右侧圆圈感叹号 tooltip
function LabelWithTip({ label, hint, required }) {
  if (!label) return null
  const requiredMark = required ? <span className="text-destructive">*</span> : null
  if (!hint) return <label className={labelCls}>{label}{requiredMark}</label>
  return (
    <label className={`${labelCls} flex items-center gap-1.5`}>
      {label}
      {requiredMark}
      <InfoTip text={hint} />
    </label>
  )
}

// 上游节点输出字段映射（用于变量引用选择器）
const NODE_OUTPUT_FIELDS = {
  tool: [{ field: 'output', label: 'output' }],
  ai_agent: [
    { field: 'response', label: 'response' },
    { field: 'decision', label: 'decision' },
  ],
  http_request: [
    { field: 'response.body', label: 'response.body' },
    { field: 'response.status_code', label: 'response.status_code' },
  ],
  condition_branch: [{ field: '_route', label: '_route' }],
  send_notification: [{ field: 'sent', label: 'sent' }],
  block_ip: [{ field: 'output', label: 'output' }],
  device_action: [
    { field: 'output', label: 'output (设备响应)' },
    { field: 'status_code', label: 'status_code' },
    { field: 'success', label: 'success' },
  ],
  human_review: [{ field: 'status', label: 'status' }],
  code_execute: [{ field: 'output', label: 'output' }],
  loop: [{ field: 'loop_mode', label: 'loop_mode' }],
  iteration: [
    { field: 'iteration_count', label: 'iteration_count' },
    { field: 'items', label: 'items' },
  ],
  webhook_trigger: [{ field: 'payload', label: 'payload' }],
}
const NODE_TYPE_LABELS = {
  webhook_trigger: 'Webhook触发', tool: '工具', ai_agent: 'AI智能体',
  http_request: 'HTTP请求', condition_branch: '条件分支', block_ip: 'IP封禁',
  send_notification: '发送通知', human_review: '人工介入', device_action: '设备动作', code_execute: '代码执行',
  loop: '循环', iteration: '迭代', start: '开始', end: '结束',
}

// 递归查找节点的所有上游节点（BFS）
function getUpstreamNodes(nodeId, nodes, edges) {
  const visited = new Set()
  const result = []
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    const sources = edges.filter((e) => e.target === current).map((e) => e.source)
    for (const src of sources) {
      if (!visited.has(src)) {
        visited.add(src)
        const node = nodes.find((n) => n.id === src)
        if (node) result.push(node)
        queue.push(src)
      }
    }
  }
  return result
}

// 变量引用按钮：点击展开上游节点输出列表，选择后插入变量引用
export function VariableRefButton({ currentNodeId, onPick }) {
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const upstreamNodes = useMemo(
    () => getUpstreamNodes(currentNodeId, nodes, edges),
    [currentNodeId, nodes, edges]
  )

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (upstreamNodes.length === 0) return null

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="引用上游节点输出变量"
        className="flex h-[34px] w-8 items-center justify-center rounded-md border border-border bg-secondary text-xs text-muted-foreground transition hover:bg-muted hover:text-primary"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-[300px] w-60 overflow-y-auto rounded-md border border-border bg-secondary shadow-xl">
          <div className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            选择上游节点输出
          </div>
          {upstreamNodes.map((n) => {
            const fields = NODE_OUTPUT_FIELDS[n.type] || [{ field: 'output', label: 'output' }]
            const label = n.data?.label || n.data?.name || NODE_TYPE_LABELS[n.type] || n.type
            return (
              <div key={n.id} className="border-b border-border last:border-0">
                <div className="truncate px-3 py-1.5 text-[11px] font-medium text-foreground">
                  {label}
                </div>
                {fields.map((f) => (
                  <button
                    key={f.field}
                    type="button"
                    onClick={() => {
                      onPick(`\${${n.id}.${f.field}}`)
                      setOpen(false)
                    }}
                    className="block w-full truncate px-4 py-1.5 text-left text-[11px] text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 带标题的分区块容器
export function Section({ title, children, hint }) {
  return (
    <div className="rounded-md border border-border bg-muted p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
        {hint && <InfoTip text={hint} />}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

// 文本输入
export function TextInput({ label, value, onChange, placeholder, hint, required, maxLength, disabled }) {
  const len = (value ?? '').length
  return (
    <div>
      <LabelWithTip label={label} hint={hint} required={required} />
      <input
        className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
        value={value ?? ''}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {maxLength && (
        <div className={`mt-1 text-right text-[11px] ${len >= maxLength ? 'text-destructive' : 'text-muted-foreground'}`}>
          {len}/{maxLength}
        </div>
      )}
    </div>
  )
}

// 数字输入
export function NumberInput({ label, value, onChange, min, max, step, hint }) {
  return (
    <div>
      <LabelWithTip label={label} hint={hint} />
      <input
        type="number"
        className={inputCls}
        value={value ?? 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// 下拉选择
export function SelectInput({ label, value, onChange, options, hint, disabled }) {
  return (
    <div>
      <LabelWithTip label={label} hint={hint} />
      <CompactSelect
        size="lg"
        block
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => {
          const val = typeof opt === 'string' ? opt : opt.value
          const text = typeof opt === 'string' ? opt : opt.label
          return (
            <option key={val} value={val}>
              {text}
            </option>
          )
        })}
      </CompactSelect>
    </div>
  )
}

// 多行文本
export function TextArea({ label, value, onChange, rows = 4, placeholder, hint, maxLength, required }) {
  const len = (value ?? '').length
  return (
    <div>
      <LabelWithTip label={label} hint={hint} required={required} />
      <AutoGrowTextarea
        className={textareaCls}
        rows={rows}
        placeholder={placeholder}
        value={value ?? ''}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {maxLength && (
        <div className={`mt-1 text-right text-[11px] ${len >= maxLength ? 'text-destructive' : 'text-muted-foreground'}`}>
          {len}/{maxLength}
        </div>
      )}
    </div>
  )
}

// 复选框行
export function CheckRow({ label, checked, onChange, hint }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-border bg-secondary text-primary focus:ring-primary"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex items-center gap-1 text-sm text-foreground">
        {label}
        {hint && <InfoTip text={hint} />}
      </span>
    </label>
  )
}

// 复选框组（多选工具等）
export function CheckboxGroup({ label, options, value, onChange, columns = 1 }) {
  const toggle = (v) => {
    const next = value?.includes(v)
      ? value.filter((x) => x !== v)
      : [...(value || []), v]
    onChange(next)
  }
  return (
    <div>
      {label && <label className={labelCls}>{label}</label>}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map((opt) => {
          const val = typeof opt === 'string' ? opt : opt.value
          const text = typeof opt === 'string' ? opt : opt.label
          return (
            <label
              key={val}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5 transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-border bg-secondary text-primary focus:ring-primary"
                checked={value?.includes(val) || false}
                onChange={() => toggle(val)}
              />
              <span className="truncate text-xs text-foreground">{text}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

// 通用键值对编辑器（Headers / Query Params / Form Data）
// value: [{ key, value }]
// 注意：flex 行内的输入框用 flex-1 min-w-0 而非 w-full，避免与 shrink-0
// 的按钮同行时总宽度超出父容器导致溢出。
export function KeyValueEditor({ label, value = [], onChange, keyPlaceholder = '字段名', valuePlaceholder = '值' }) {
  const update = (idx, patch) => {
    const next = value.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const add = () => onChange([...value, { key: '', value: '' }])
  const remove = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      {label && <label className={labelCls}>{label}</label>}
      <div className="flex flex-col gap-1.5">
        {value.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无配置项</p>
        )}
        {value.map((item, idx) => (
          <div key={idx} className="flex gap-1.5">
            <input
              className={`${inputCls} min-w-0 flex-1`}
              placeholder={keyPlaceholder}
              value={item.key}
              onChange={(e) => update(idx, { key: e.target.value })}
            />
            <input
              className={`${inputCls} min-w-0 flex-1`}
              placeholder={valuePlaceholder}
              value={item.value}
              onChange={(e) => update(idx, { value: e.target.value })}
            />
            <button
              type="button"
              onClick={() => remove(idx)}
              className="shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
              title="删除"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加一行
      </button>
    </div>
  )
}

// 带类型与必填的参数编辑器（Webhook Query/Body Params）
// value: [{ name, type, required }]
export function TypedParamEditor({ label, value = [], onChange }) {
  const typeOpts = ['String', 'Number', 'Boolean', 'Object', 'Array']
  const update = (idx, patch) => {
    const next = value.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const add = () => onChange([...value, { name: '', type: 'String', required: false }])
  const remove = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      {label && <label className={labelCls}>{label}</label>}
      <div className="flex flex-col gap-1.5">
        {value.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无参数</p>
        )}
        {value.map((item, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5"
          >
            {/* 第一行：变量名 + 删除按钮 */}
            <div className="flex gap-1.5">
              <input
                className={`${inputCls} min-w-0 flex-1`}
                placeholder="变量名"
                value={item.name}
                onChange={(e) => update(idx, { name: e.target.value })}
              />
              <button
                type="button"
                onClick={() => remove(idx)}
                className="shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                title="删除"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {/* 第二行：类型选择 + 必填复选框 */}
            <div className="flex items-center gap-1.5">
              <CompactSelect
                size="lg"
                block
                className="min-w-0 flex-1"
                value={item.type}
                onChange={(e) => update(idx, { type: e.target.value })}
              >
                {typeOpts.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </CompactSelect>
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1 px-1 text-[11px] text-muted-foreground"
                title="是否必填"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border bg-secondary text-primary focus:ring-primary"
                  checked={!!item.required}
                  onChange={(e) => update(idx, { required: e.target.checked })}
                />
                必填
              </label>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加参数
      </button>
    </div>
  )
}

// 条件列表编辑器（条件分支 IF/ELSE 模式）
// value: [{ variable, operator, value }]
export function ConditionEditor({ value = [], onChange, logic = 'AND', onLogicChange, currentNodeId }) {
  const operatorOpts = [
    { value: '==', label: '等于 ==' },
    { value: '!=', label: '不等于 !=' },
    { value: '>', label: '大于 >' },
    { value: '<', label: '小于 <' },
    { value: '>=', label: '大于等于 >=' },
    { value: '<=', label: '小于等于 <=' },
    { value: 'contains', label: '包含 contains' },
    { value: 'not_contains', label: '不包含 not_contains' },
    { value: 'starts_with', label: '以…开头 starts_with' },
    { value: 'ends_with', label: '以…结尾 ends_with' },
    { value: 'is_empty', label: '为空 is_empty' },
    { value: 'is_not_empty', label: '非空 is_not_empty' },
  ]
  const update = (idx, patch) => {
    const next = value.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const add = () => onChange([...value, { variable: '', operator: '==', value: '' }])
  const remove = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className={labelCls + ' mb-0'}>条件列表</label>
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">连接符：</span>
          {['AND', 'OR'].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onLogicChange(l)}
              className={`rounded px-1.5 py-0.5 ${
                logic === l
                  ? 'bg-primary text-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {value.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无条件，默认走「否」分支</p>
        )}
        {value.map((item, idx) => (
          <div key={idx} className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5">
            {/* 第一行：变量名 + 引用按钮 */}
            <div className="flex gap-1.5">
              <input
                className={`${inputBaseCls} min-w-0 flex-1`}
                placeholder="变量名 如 severity"
                value={item.variable}
                onChange={(e) => update(idx, { variable: e.target.value })}
              />
              {currentNodeId && (
                <VariableRefButton
                  currentNodeId={currentNodeId}
                  onPick={(ref) => update(idx, { variable: item.variable ? `${item.variable} ${ref}` : ref })}
                />
              )}
            </div>
            {/* 第二行：操作符 + 删除按钮 */}
            <div className="flex gap-1.5">
              <CompactSelect
                size="lg"
                block
                className="min-w-0 flex-1"
                value={item.operator}
                onChange={(e) => update(idx, { operator: e.target.value })}
              >
                {operatorOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </CompactSelect>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                title="删除"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {!['is_empty', 'is_not_empty'].includes(item.operator) && (
              <input
                className={inputCls}
                placeholder="比较值"
                value={item.value}
                onChange={(e) => update(idx, { value: e.target.value })}
              />
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加条件
      </button>
    </div>
  )
}

// SWITCH 多分支编辑器
// value: [{ label, logic, conditions: [{variable, operator, value}] }]
export function SwitchEditor({ value = [], onChange, currentNodeId }) {
  const updateCase = (idx, patch) => {
    const next = value.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const addCase = () =>
    onChange([...value, { label: `分支 ${value.length + 1}`, logic: 'AND', conditions: [] }])
  const removeCase = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      <label className={labelCls}>分支列表（每条匹配一个出口）</label>
      <div className="flex flex-col gap-2">
        {value.map((c, idx) => (
          <div key={idx} className="rounded-md border border-border bg-muted p-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              <input
                className={`${inputBaseCls} min-w-0 flex-1`}
                placeholder="分支标签"
                value={c.label}
                onChange={(e) => updateCase(idx, { label: e.target.value })}
              />
              <button
                type="button"
                onClick={() => removeCase(idx)}
                className="shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                title="删除分支"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <ConditionEditor
              value={c.conditions}
              onChange={(conditions) => updateCase(idx, { conditions })}
              logic={c.logic}
              onLogicChange={(logic) => updateCase(idx, { logic })}
              currentNodeId={currentNodeId}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addCase}
        className="mt-1.5 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加分支
      </button>
    </div>
  )
}

// 节点输入/输出变量定义器（对标 Dify）
// value: [{ name, type, description }]
// 用于声明节点的输入变量或输出变量，便于下游节点引用
export function VariableIOEditor({ value = [], onChange, direction = 'output' }) {
  const typeOpts = ['String', 'Number', 'Boolean', 'Object', 'Array']
  const update = (idx, patch) => {
    const next = value.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const add = () => onChange([...value, { name: '', type: 'String', description: '' }])
  const remove = (idx) => onChange(value.filter((_, i) => i !== idx))

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {value.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            暂无{direction === 'input' ? '输入' : '输出'}变量
          </p>
        )}
        {value.map((item, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5"
          >
            <div className="flex gap-1.5">
              <input
                className={`${inputBaseCls} min-w-0 flex-1`}
                placeholder="变量名"
                value={item.name}
                onChange={(e) => update(idx, { name: e.target.value })}
              />
              <CompactSelect
                size="md"
                className="shrink-0"
                value={item.type}
                onChange={(e) => update(idx, { type: e.target.value })}
              >
                {typeOpts.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </CompactSelect>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                title="删除"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <input
              className={inputCls}
              placeholder="描述（可选）"
              value={item.description || ''}
              onChange={(e) => update(idx, { description: e.target.value })}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1.5 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加{direction === 'input' ? '输入' : '输出'}变量
      </button>
    </div>
  )
}

