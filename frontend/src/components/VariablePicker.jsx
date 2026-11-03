// 变量选择器：点击 { } 按钮弹出树形面板，展示可选变量并插入到输入框光标位置
//
// 变量来源：
//   1. 全局变量：useWorkflowStore.variables 数组
//   2. 触发器参数：第一个 webhook_trigger / manual_trigger 节点的参数
//   3. 上游节点输出：通过 edges 反向 BFS 找到上游节点，展示其 output_variables 或常用输出字段
//   4. payload：触发器入参
//
// 插入格式：
//   {{variables.变量名}}      全局变量
//   {{payload.field}}         触发器入参
//   {{node_id.output.field}}  上游节点输出
//
// 暗色主题，统一使用语义令牌（bg-secondary / border-border / text-foreground / text-primary）

import { useMemo, useState, useRef, useEffect } from 'react'
import { Braces, Search, ChevronRight, Variable as VariableIcon } from 'lucide-react'
import { useWorkflowStore } from '../store/workflowStore'
import { inputBaseCls } from './property/FormControls'
import { AutoGrowTextarea } from './ui'

// 上游节点常用输出字段映射（与 PropertyPanel 中保持一致）
const NODE_OUTPUT_FIELDS = {
  tool: [{ field: 'output', label: 'output (工具返回值)' }],
  ai_agent: [
    { field: 'response', label: 'response (LLM 响应)' },
    { field: 'decision', label: 'decision (决策)' },
  ],
  llm: [{ field: 'text', label: 'text (生成的文本)' }],
  http_request: [
    { field: 'response.body', label: 'response.body (响应体)' },
    { field: 'response.status_code', label: 'response.status_code (状态码)' },
    { field: 'response.headers', label: 'response.headers (响应头)' },
  ],
  condition_branch: [
    { field: '_route', label: '_route (分支路由)' },
    { field: '_satisfied', label: '_satisfied (条件是否满足)' },
  ],
  send_notification: [{ field: 'sent', label: 'sent (发送状态)' }],
  block_ip: [{ field: 'output', label: 'output (封禁结果)' }],
  device_action: [
    { field: 'output', label: 'output (设备响应)' },
    { field: 'status_code', label: 'status_code (HTTP 状态码)' },
    { field: 'success', label: 'success (是否成功)' },
  ],
  human_review: [{ field: 'status', label: 'status (审批状态)' }],
  code_execute: [{ field: 'output', label: 'output (代码执行结果)' }],
  loop: [{ field: 'loop_mode', label: 'loop_mode (循环模式)' }],
  iteration: [
    { field: 'iteration_count', label: 'iteration_count (迭代次数)' },
    { field: 'items', label: 'items (迭代数据)' },
  ],
  webhook_trigger: [{ field: 'payload', label: 'payload (触发数据)' }],
}

// 节点类型中文标签
const NODE_TYPE_LABELS = {
  webhook_trigger: 'Webhook触发',
  tool: '工具',
  ai_agent: 'AI智能体',
  llm: 'LLM',
  http_request: 'HTTP请求',
  condition_branch: '条件分支',
  block_ip: 'IP封禁',
  device_action: '设备动作',
  send_notification: '发送通知',
  human_review: '人工介入',
  code_execute: '代码执行',
  loop: '循环',
  iteration: '迭代',
  manual_trigger: '手动触发',
  schedule_trigger: '定时触发',
  event_trigger: '事件触发',
  start: '开始',
  end: '结束',
}

// 递归查找节点的所有上游节点（BFS，去重）
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

// 节点显示名
function getNodeLabel(node) {
  return (
    node?.data?.label ||
    node?.data?.name ||
    NODE_TYPE_LABELS[node?.type] ||
    node?.type ||
    node?.id
  )
}

// 收集所有可用的变量树根节点
// 返回 [{ key, label, icon, children: [{ label, insert }] }]
function buildVariableTree(currentNodeId, nodes, edges, variables) {
  const tree = []

  // 1. 全局变量
  const globalVars = Array.isArray(variables) ? variables : []
  if (globalVars.length > 0) {
    tree.push({
      key: 'variables',
      label: '全局变量',
      children: globalVars
        .filter((v) => v && v.name)
        .map((v) => ({
          label: `${v.name}${v.description ? ` — ${v.description}` : ''}`,
          insert: `{{variables.${v.name}}}`,
        })),
    })
  }

  // 2. 触发器入参 payload：找第一个触发器节点
  const triggerNode = nodes.find(
    (n) => n.type === 'webhook_trigger' || n.type === 'manual_trigger' || n.type === 'event_trigger' || n.type === 'schedule_trigger'
  )
  if (triggerNode) {
    const payloadChildren = []
    // webhook 触发器：参数和 payload 字段
    if (triggerNode.type === 'webhook_trigger') {
      const bodyParams = (triggerNode.data?.body_params || []).filter((p) => p.name)
      const queryParams = (triggerNode.data?.query_params || []).filter((p) => p.name)
      payloadChildren.push(
        { label: 'payload._webhook_raw (原始请求体)', insert: '{{payload._webhook_raw}}' },
        { label: 'payload.method (HTTP 方法)', insert: '{{payload.method}}' },
        { label: 'payload.headers (请求头)', insert: '{{payload.headers}}' },
        { label: 'payload.query (查询参数)', insert: '{{payload.query}}' },
        { label: 'payload.body (请求体)', insert: '{{payload.body}}' }
      )
      bodyParams.forEach((p) => {
        payloadChildren.push({
          label: `payload.body.${p.name} (${p.type || 'string'})`,
          insert: `{{payload.body.${p.name}}}`,
        })
      })
      queryParams.forEach((p) => {
        payloadChildren.push({
          label: `payload.query.${p.name} (${p.type || 'string'})`,
          insert: `{{payload.query.${p.name}}}`,
        })
      })
    } else if (triggerNode.type === 'manual_trigger') {
      const entryForm = (triggerNode.data?.entry_form || []).filter((p) => p.name)
      payloadChildren.push(
        { label: 'payload._manual_raw (原始表单)', insert: '{{payload._manual_raw}}' }
      )
      entryForm.forEach((p) => {
        payloadChildren.push({
          label: `payload.${p.name} (${p.type || 'string'})`,
          insert: `{{payload.${p.name}}}`,
        })
      })
    } else {
      payloadChildren.push(
        { label: 'payload (触发器入参)', insert: '{{payload}}' }
      )
    }
    if (payloadChildren.length > 0) {
      tree.push({
        key: 'payload',
        label: `触发器入参 (${getNodeLabel(triggerNode)})`,
        children: payloadChildren,
      })
    }
  }

  // 3. 上游节点输出
  if (currentNodeId) {
    const upstreamNodes = getUpstreamNodes(currentNodeId, nodes, edges)
    upstreamNodes.forEach((n) => {
      // 优先用节点声明的 output_variables
      const declaredOutputs = Array.isArray(n.data?.output_variables)
        ? n.data.output_variables
        : []
      let children
      if (declaredOutputs.length > 0) {
        children = declaredOutputs
          .filter((v) => v && (v.name || (typeof v === 'string' && v)))
          .map((v) => {
            const name = typeof v === 'string' ? v : v.name
            const desc = typeof v === 'string' ? '' : v.description || ''
            return {
              label: `${name}${desc ? ` — ${desc}` : ''}`,
              insert: `{{${n.id}.output.${name}}}`,
            }
          })
      } else {
        // 回退到常用字段映射
        const fields = NODE_OUTPUT_FIELDS[n.type] || [{ field: 'output', label: 'output' }]
        children = fields.map((f) => ({
          label: f.label,
          insert: `{{${n.id}.${f.field}}}`,
        }))
      }
      if (children.length > 0) {
        tree.push({
          key: n.id,
          label: `${getNodeLabel(n)} (${n.id})`,
          children,
        })
      }
    })
  }

  return tree
}

// 树节点：可展开/折叠，子项点击插入变量引用
function TreeNode({ node, onPick, filter }) {
  const [open, setOpen] = useState(false)
  const filterLower = (filter || '').toLowerCase()
  const matchFilter = (text) =>
    !filterLower || String(text).toLowerCase().includes(filterLower)

  // 过滤子项；若过滤后为空则不渲染
  const visibleChildren = node.children.filter((c) => matchFilter(c.label) || matchFilter(c.insert))
  if (filterLower && visibleChildren.length === 0 && !matchFilter(node.label)) return null

  // 过滤模式下默认展开
  const expanded = open || !!filterLower

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] font-semibold text-foreground hover:bg-accent"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <VariableIcon className="h-3 w-3 shrink-0 text-primary" />
        <span className="truncate">{node.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {visibleChildren.length}
        </span>
      </button>
      {expanded && visibleChildren.length > 0 && (
        <div className="pb-1">
          {visibleChildren.map((child, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => onPick(child.insert)}
              className="block w-full truncate px-7 py-1 text-left text-[11px] text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
              title={child.insert}
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 变量选择器弹层
export function VariablePicker({ currentNodeId, onPick, align = 'right' }) {
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const variables = useWorkflowStore((s) => s.variables)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef(null)

  const tree = useMemo(
    () => buildVariableTree(currentNodeId, nodes, edges, variables),
    [currentNodeId, nodes, edges, variables]
  )

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 关闭时重置搜索
  useEffect(() => {
    if (!open) setFilter('')
  }, [open])

  const handlePick = (insert) => {
    onPick(insert)
    setOpen(false)
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="插入变量 {{...}}"
        className="flex h-[34px] w-8 items-center justify-center rounded-md border border-border bg-secondary text-xs text-muted-foreground transition hover:bg-muted hover:text-primary"
      >
        <Braces className="h-4 w-4" />
      </button>
      {open && (
        <div
          className={`absolute top-full z-dropdown mt-1 max-h-[340px] w-72 overflow-hidden rounded-md border border-border bg-popover shadow-xl ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
        >
          {/* 搜索框 */}
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索变量…"
                className={`${inputBaseCls} pl-7`}
              />
            </div>
          </div>
          {/* 树形列表 */}
          <div className="max-h-[280px] overflow-y-auto">
            {tree.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                暂无可用变量
              </div>
            ) : (
              tree.map((n) => (
                <TreeNode key={n.key} node={n} onPick={handlePick} filter={filter} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 变量字段包装组件：input + 变量按钮，点击变量插入到光标位置
// 用于所有需要支持 {{变量}} 引用的输入框
export function VariableField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows,
  currentNodeId,
  multiline = false,
}) {
  const inputRef = useRef(null)
  const isMultiline = multiline || (rows && rows > 1)

  // 在光标位置插入变量引用；如无法获取光标位置则追加到末尾
  const insertVariable = (insert) => {
    const el = inputRef.current
    if (!el) {
      onChange(value ? `${value} ${insert}` : insert)
      return
    }
    const start = el.selectionStart ?? value?.length ?? 0
    const end = el.selectionEnd ?? value?.length ?? 0
    const newValue =
      (value || '').slice(0, start) + insert + (value || '').slice(end)
    onChange(newValue)
    // 恢复光标到插入文本之后
    requestAnimationFrame(() => {
      try {
        el.focus()
        el.setSelectionRange(start + insert.length, start + insert.length)
      } catch {
        /* 忽略 */
      }
    })
  }

  return (
    <div>
      {label && (
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {label}
        </label>
      )}
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {isMultiline ? (
            <AutoGrowTextarea
              ref={inputRef}
              className={`${inputBaseCls} w-full resize-y font-mono`}
              rows={rows || 4}
              placeholder={placeholder}
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              ref={inputRef}
              className={`${inputBaseCls} w-full`}
              placeholder={placeholder}
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
        <div className={isMultiline ? 'pt-[2px]' : ''}>
          <VariablePicker currentNodeId={currentNodeId} onPick={insertVariable} />
        </div>
      </div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

export default VariablePicker
