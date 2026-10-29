import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import {
  Paperclip,
  Wrench,
  Webhook, Shuffle, Globe, Bot, MessageSquare, Ban, Shield, Megaphone,
  User, Code2, Repeat, RefreshCw, CircleStop,
  AlertTriangle,
  Play, Copy, Check, Plus, Trash2, ChevronDown, Variable, Braces, Settings,
} from 'lucide-react'
import { useWorkflowStore } from '../store/workflowStore'
import { getNodeDefinition } from '../constants/nodeCatalog'
import { workflows as workflowsApi, tools as toolsApi, llmConfigs as llmApi, devices as devicesApi, agents as agentsApi } from '../api/client'
import {
  Section,
  TextInput,
  NumberInput,
  SelectInput,
  TextArea,
  CheckRow,
  CheckboxGroup,
  KeyValueEditor,
  TypedParamEditor,
  ConditionEditor,
  SwitchEditor,
  VariableIOEditor,
  inputBaseCls,
  labelCls,
} from './property/FormControls'
import { JsonInputDialog, Modal } from './Dialog'
import { VariablePicker, VariableField } from './VariablePicker'
import ExpressionEditor from './ExpressionEditor'
import { CompactSelect } from './ui'

// 节点图标名 → lucide 组件映射（nodeCatalog.icon 存的是组件名字符串）
const ICON_MAP = {
  Webhook, Shuffle, Globe, Bot, MessageSquare, Ban, Shield, Megaphone,
  Wrench, User, Code2, Repeat, RefreshCw, CircleStop,
}

// 根据 icon 字段渲染 lucide 图标，未命中时回退到 Wrench
function renderNodeIcon(iconName, className = 'h-5 w-5') {
  const Icon = ICON_MAP[iconName] || Wrench
  return <Icon className={className} />
}

// ===== 节点输出引用选择器 =====
// 不同节点类型的常用输出字段映射
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
  start: '开始',
  end: '结束',
}

// 输出变量列表：每个变量独立卡片展示，便于区分
// vars: [{ name, desc }] 或字符串数组（自动按首个冒号拆分为 name/desc）
function OutputVarList({ vars, hint }) {
  const items = (vars || []).map((v) =>
    typeof v === 'string'
      ? (() => {
          const idx = v.indexOf(':')
          if (idx < 0) return { name: v, desc: '' }
          return { name: v.slice(0, idx).trim(), desc: v.slice(idx + 1).trim() }
        })()
      : v
  )
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((v, idx) => (
        <div
          key={idx}
          className="rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[11px]"
        >
          <span className="text-primary">{v.name}</span>
          {v.desc && (
            <>
              <span className="text-muted-foreground"> : </span>
              <span className="text-muted-foreground">{v.desc}</span>
            </>
          )}
        </div>
      ))}
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

// ===== 折叠面板（CollapsibleSection）=====
// 可复用的折叠区块，默认折叠，点击标题展开
function CollapsibleSection({ title, children, defaultOpen = false, hint }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border bg-muted">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground hover:bg-accent"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
        />
        <span>{title}</span>
        {hint && <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground">{hint}</span>}
      </button>
      {open && <div className="flex flex-col gap-2.5 border-t border-border p-3">{children}</div>}
    </div>
  )
}

// ===== 错误处理配置（共享组件）=====
// 用于动作节点：ai_agent / llm / http_request / device_action / block_ip / send_notification / tool / code_execute
// 字段：timeout / retry / retry_interval / on_failure / continue_on_error
function ErrorHandlingSection({ data, update }) {
  const setField = (field) => (value) => update({ [field]: value })
  return (
    <CollapsibleSection title="错误处理">
      <div className="grid grid-cols-3 gap-2">
        <NumberInput
          label="超时(秒)"
          value={data.timeout ?? 30}
          onChange={setField('timeout')}
          min={1}
          max={3600}
        />
        <NumberInput
          label="重试次数"
          value={data.retry ?? 0}
          onChange={setField('retry')}
          min={0}
          max={10}
        />
        <NumberInput
          label="重试间隔(秒)"
          value={data.retry_interval ?? 5}
          onChange={setField('retry_interval')}
          min={0}
          max={600}
        />
      </div>
      <SelectInput
        label="失败时"
        value={data.on_failure ?? 'continue'}
        onChange={setField('on_failure')}
        options={[
          { value: 'continue', label: '继续 (continue)' },
          { value: 'stop', label: '停止 (stop)' },
          { value: 'branch', label: '走失败分支 (branch)' },
        ]}
      />
      <CheckRow
        label="失败时是否继续执行下游节点"
        checked={!!data.continue_on_error}
        onChange={setField('continue_on_error')}
        hint="开启后即使本节点失败也会继续，失败信息可在下游通过 {{node_id.error}} 引用"
      />
    </CollapsibleSection>
  )
}

// 递归查找节点的所有上游节点（通过 edges 连线关系）
// 返回去重后的上游节点列表（按拓扑顺序）
function getUpstreamNodes(nodeId, nodes, edges) {
  const visited = new Set()
  const result = []
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    // 找到所有指向 current 的边的 source
    const sources = edges
      .filter((e) => e.target === current)
      .map((e) => e.source)
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

// 节点输出引用选择器组件
function NodeOutputPicker({ currentNodeId, onPick }) {
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
        title="引用上游节点输出"
        className="flex h-[30px] w-7 items-center justify-center rounded-md border border-border bg-secondary text-xs text-muted-foreground transition hover:bg-secondary hover:text-primary"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-dropdown mt-1 max-h-[300px] w-64 overflow-y-auto rounded-md border border-border bg-secondary shadow-xl">
          <div className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            选择上游节点输出
          </div>
          {upstreamNodes.map((n) => {
            const fields = NODE_OUTPUT_FIELDS[n.type] || [{ field: 'output', label: 'output' }]
            const label = n.data.label || n.data.name || NODE_TYPE_LABELS[n.type] || n.type
            return (
              <div key={n.id} className="border-b border-border last:border-0">
                <div className="truncate px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                  {label} <span className="text-muted-foreground">({n.id})</span>
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

// ===== Webhook 触发器增强表单 =====
// 含：完整 URL 一键复制 / 签名验证配置 / 示例 Payload / 测试 Webhook / 失败重试
function WebhookTriggerForm({ node, update, workflowId }) {
  const setField = (field) => (value) => update(node.id, { [field]: value })
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { status, duration_ms, error }

  // 完整 Webhook URL：优先用 workflowId，否则回退到 node_id 派生
  const webhookUrl = useMemo(() => {
    const base = '/api/v1/webhooks'
    if (workflowId) return `${base}/${workflowId}/trigger`
    return `${base}/wf_${node.id.replace('node_', '')}`
  }, [workflowId, node.id])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 忽略剪贴板权限错误
    }
  }

  const handleTestWebhook = async () => {
    setTesting(true)
    setTestResult(null)
    const start = performance.now()
    try {
      const body =
        node.data.sample_payload ||
        JSON.stringify({ event: 'test', timestamp: new Date().toISOString() })
      const resp = await fetch(webhookUrl, {
        method: node.data.method || 'POST',
        headers: { 'Content-Type': node.data.content_type || 'application/json' },
        body,
      })
      const duration = Math.round(performance.now() - start)
      setTestResult({ status: resp.status, duration_ms: duration, ok: resp.ok })
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      setTestResult({ status: 0, duration_ms: duration, error: err.message || String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Section title="触发地址" hint="将此 URL 配置到外部系统，事件推送至此即可触发本工作流。">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-primary/20 px-2 py-1 text-[11px] font-semibold text-primary">
            {node.data.method || 'POST'}
          </span>
          <input
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
            readOnly
            value={webhookUrl}
          />
          <button
            type="button"
            onClick={handleCopy}
            title="复制 URL"
            className="flex h-[30px] w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition hover:bg-muted hover:text-primary"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </Section>

      <Section title="请求设置">
        <SelectInput
          label="HTTP Method"
          value={node.data.method}
          onChange={setField('method')}
          options={['POST', 'GET', 'PUT', 'DELETE']}
        />
        <SelectInput
          label="内容类型 Content-Type"
          value={node.data.content_type}
          onChange={setField('content_type')}
          options={[
            'application/json',
            'application/x-www-form-urlencoded',
            'text/plain',
            'multipart/form-data',
          ]}
        />
      </Section>

      <Section title="Query Parameters">
        <TypedParamEditor value={node.data.query_params} onChange={setField('query_params')} />
      </Section>

      <Section title="Header Parameters">
        <KeyValueEditor
          value={node.data.header_params}
          onChange={setField('header_params')}
          keyPlaceholder="Header 名"
          valuePlaceholder="是否必填（true/false）"
        />
      </Section>

      <Section title="Request Body Parameters">
        <TypedParamEditor value={node.data.body_params} onChange={setField('body_params')} />
      </Section>

      <Section title="响应设置">
        <NumberInput
          label="响应状态码"
          value={node.data.response_status}
          onChange={setField('response_status')}
          min={100}
          max={599}
        />
        <TextArea
          label="响应体"
          value={node.data.response_body}
          onChange={setField('response_body')}
          rows={4}
          placeholder='{"status": "received"}'
        />
      </Section>

      {/* 签名验证配置 */}
      <Section title="签名验证" hint="启用后，Webhook 请求需携带指定头的签名才能被接受">
        <CheckRow
          label="启用签名验证"
          checked={!!node.data.secret_verify}
          onChange={setField('secret_verify')}
        />
        {node.data.secret_verify && (
          <>
            <SelectInput
              label="签名算法"
              value={node.data.secret_algorithm || 'HMAC-SHA256'}
              onChange={setField('secret_algorithm')}
              options={['HMAC-SHA256', 'MD5', 'SHA1']}
            />
            <TextInput
              label="签名头名称"
              value={node.data.secret_header || ''}
              onChange={setField('secret_header')}
              placeholder="X-Webhook-Signature"
            />
            <TextInput
              label="签名密钥"
              value={node.data.secret_value || ''}
              onChange={setField('secret_value')}
              placeholder="用于校验请求体的密钥"
            />
          </>
        )}
      </Section>

      {/* 请求示例 Payload */}
      <Section title="请求示例 Payload">
        <TextArea
          label="示例 Payload"
          value={node.data.sample_payload || ''}
          onChange={setField('sample_payload')}
          rows={4}
          placeholder='{"event": "test", "data": {"key": "value"}}'
        />
      </Section>

      {/* 测试 Webhook */}
      <Section title="测试 Webhook">
        <button
          type="button"
          onClick={handleTestWebhook}
          disabled={testing}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-primary bg-primary/20 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {testing ? '测试中…' : '测试 Webhook'}
        </button>
        {testResult && (
          <div className="rounded-md border border-border bg-muted p-2 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">状态：</span>
              {testResult.error ? (
                <span className="text-destructive">失败</span>
              ) : (
                <span className={testResult.ok ? 'text-success' : 'text-warning'}>
                  {testResult.status}
                </span>
              )}
              <span className="ml-auto text-muted-foreground">
                耗时 {testResult.duration_ms}ms
              </span>
            </div>
            {testResult.error && (
              <div className="mt-1 break-all text-destructive">{testResult.error}</div>
            )}
          </div>
        )}
      </Section>

      {/* 失败重试配置 */}
      <Section title="失败重试">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="重试次数"
            value={node.data.retry_max ?? 0}
            onChange={setField('retry_max')}
            min={0}
            max={10}
          />
          <NumberInput
            label="重试间隔(秒)"
            value={node.data.retry_interval ?? 5}
            onChange={setField('retry_interval')}
            min={0}
            max={600}
          />
        </div>
      </Section>

      <Section title="输出变量" hint="触发后下游节点可用 payload._webhook_raw 获取原始请求体。">
        <OutputVarList vars={[
          'payload._webhook_raw : object',
          'payload.method : string',
          'payload.headers : object',
          'payload.query : object',
          'payload.body : object',
        ]} />
      </Section>
    </>
  )
}

// ===== 条件分支可视化增强表单 =====
// 规则积木 + AND/OR 切换 + 变量选择器 + 表达式预览
function ConditionBranchForm({ node, update }) {
  const setField = (field) => (value) => update(node.id, { [field]: value })
  const mode = node.data.mode
  const conditions = Array.isArray(node.data.conditions) ? node.data.conditions : []

  const operatorOpts = [
    { value: '==', label: '等于 ==' },
    { value: '!=', label: '不等于 !=' },
    { value: '>', label: '大于 >' },
    { value: '<', label: '小于 <' },
    { value: '>=', label: '大于等于 >=' },
    { value: '<=', label: '小于等于 <=' },
    { value: 'contains', label: '包含 contains' },
    { value: 'not_contains', label: '不包含 not_contains' },
    { value: 'regex', label: '正则匹配 regex' },
    { value: 'is_empty', label: '为空 is_empty' },
    { value: 'is_not_empty', label: '非空 is_not_empty' },
  ]

  const updateCondition = (idx, patch) => {
    const next = conditions.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    setField('conditions')(next)
  }
  const addCondition = () =>
    setField('conditions')([...conditions, { variable: '', operator: '==', value: '' }])
  const removeCondition = (idx) =>
    setField('conditions')(conditions.filter((_, i) => i !== idx))

  // 组装表达式预览文本
  const expressionPreview = useMemo(() => {
    if (conditions.length === 0) return '(无条件，默认走「否」分支)'
    const opLabel = (op) => {
      const found = operatorOpts.find((o) => o.value === op)
      return found ? found.value : op
    }
    const parts = conditions.map((c) => {
      const val = ['is_empty', 'is_not_empty'].includes(c.operator)
        ? ''
        : ` ${/^\d+(\.\d+)?$/.test(String(c.value)) ? c.value : `'${c.value}'`}`
      return `(${c.variable || '?'} ${opLabel(c.operator)}${val})`
    })
    return parts.join(` ${node.data.logic || 'AND'} `)
  }, [conditions, node.data.logic])

  if (mode === 'switch') {
    return (
      <Section title="分支配置">
        <SwitchEditor value={node.data.cases} onChange={setField('cases')} currentNodeId={node.id} />
      </Section>
    )
  }

  return (
    <>
      <Section title="分支模式">
        <SelectInput
          label="模式"
          value={mode}
          onChange={setField('mode')}
          options={[
            { value: 'if_else', label: 'IF / ELSE（二分支）' },
            { value: 'switch', label: 'SWITCH（多分支）' },
          ]}
          hint={mode === 'if_else' ? '条件满足走「是」分支，否则走「否」分支。' : '依次匹配每条 Case，命中即走对应出口；全部不命中走默认分支。'}
        />
      </Section>

      <Section title="条件配置">
        {/* AND / OR 切换 */}
        <div className="mb-2 flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">连接符：</span>
          {['AND', 'OR'].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setField('logic')(l)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                (node.data.logic || 'AND') === l
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* 条件规则积木列表 */}
        <div className="flex flex-col gap-1.5">
          {conditions.length === 0 && (
            <p className="text-[11px] text-muted-foreground">暂无条件，默认走「否」分支</p>
          )}
          {conditions.map((item, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-1 rounded-md border border-border bg-muted p-1.5"
            >
              {/* 变量选择器 + 操作符 + 删除 */}
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <input
                    className={`${inputBaseCls} w-full`}
                    placeholder="变量名 如 severity 或 {{payload.severity}}"
                    value={item.variable}
                    onChange={(e) => updateCondition(idx, { variable: e.target.value })}
                  />
                </div>
                <VariablePicker
                  currentNodeId={node.id}
                  onPick={(insert) =>
                    updateCondition(idx, {
                      variable: item.variable ? `${item.variable} ${insert}` : insert,
                    })
                  }
                />
                <button
                  type="button"
                  onClick={() => removeCondition(idx)}
                  className="flex h-[34px] w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-destructive hover:text-destructive"
                  title="删除条件"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* 操作符 + 值 */}
              <div className="flex items-center gap-1.5">
                <CompactSelect
                  size="lg"
                  block
                  className="min-w-0 flex-1"
                  value={item.operator}
                  onChange={(e) => updateCondition(idx, { operator: e.target.value })}
                >
                  {operatorOpts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </CompactSelect>
                {!['is_empty', 'is_not_empty'].includes(item.operator) && (
                  <input
                    className={`${inputBaseCls} min-w-0 flex-1`}
                    placeholder="比较值"
                    value={item.value}
                    onChange={(e) => updateCondition(idx, { value: e.target.value })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 添加条件按钮 */}
        <button
          type="button"
          onClick={addCondition}
          className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          添加条件
        </button>
      </Section>

      {/* 条件预览 */}
      <Section title="条件预览" hint="组装后的表达式（只读）">
        <pre className="overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground">
          {expressionPreview}
        </pre>
      </Section>

      {/* 分支出口说明 */}
      <Section title="分支出口">
        <div className="grid grid-cols-2 gap-2">
          <TextInput label="真分支标签" value={node.data.true_label} onChange={setField('true_label')} />
          <TextInput label="假分支标签" value={node.data.false_label} onChange={setField('false_label')} />
        </div>
        <div className="rounded-md border border-border bg-muted p-2 text-[11px] leading-relaxed text-muted-foreground">
          满足条件时走「{node.data.true_label || '是'}」分支，否则走「{node.data.false_label || '否'}」分支。
        </div>
      </Section>
    </>
  )
}

// ===== 代码执行节点增强表单 =====
// 语言单选 + 行号 + 语法高亮 + 输出变量列表
function CodeExecuteForm({ node, update }) {
  const setField = (field) => (value) => update(node.id, { [field]: value })
  const codeRef = useRef(null)
  const [codeScroll, setCodeScroll] = useState({ top: 0, left: 0 })

  // 关键字集合（按语言）
  const keywordSet = useMemo(() => {
    if (node.data.language === 'javascript') {
      return new Set(['function', 'const', 'let', 'var', 'if', 'else', 'return', 'for', 'while', 'import', 'export', 'class', 'try', 'catch', 'throw', 'typeof', 'new'])
    }
    return new Set(['def', 'if', 'for', 'return', 'import', 'from', 'while', 'class', 'try', 'except', 'finally', 'with', 'lambda', 'yield', 'raise', 'global', 'nonlocal', 'assert', 'del', 'pass', 'break', 'continue'])
  }, [node.data.language])

  // 行号列表
  const lines = useMemo(() => {
    const code = node.data.code || ''
    return code.split('\n').map((_, i) => i + 1)
  }, [node.data.code])

  // 简单语法高亮：返回带 className 的片段数组
  const tokens = useMemo(() => {
    const text = node.data.code || ''
    if (!text) return []
    // 顺序：注释、字符串、数字、关键字、内置对象
    const regex = /(#.*$|\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)/gm
    const result = []
    let lastIndex = 0
    let match
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ text: text.slice(lastIndex, match.index), className: '' })
      }
      if (match[1]) {
        result.push({ text: match[1], className: 'text-muted-foreground italic' })
      } else if (match[2]) {
        result.push({ text: match[2], className: 'text-success' })
      } else if (match[3]) {
        result.push({ text: match[3], className: 'text-info' })
      } else if (match[4]) {
        if (keywordSet.has(match[4])) {
          result.push({ text: match[4], className: 'text-warning font-semibold' })
        } else {
          result.push({ text: match[4], className: '' })
        }
      }
      lastIndex = regex.lastIndex
    }
    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex), className: '' })
    }
    return result
  }, [node.data.code, keywordSet])

  const handleScroll = () => {
    const el = codeRef.current
    if (!el) return
    setCodeScroll({ top: el.scrollTop, left: el.scrollLeft })
  }

  return (
    <>
      <Section title="语言与代码" hint="在受限环境中执行 Python3 / JavaScript 代码。可用变量：input_data（上游输入）、ctx（工作流上下文）。">
        {/* 语言单选 */}
        <div className="flex gap-2">
          {['python', 'javascript'].map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => setField('language')(lang)}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                (node.data.language || 'python') === lang
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-secondary text-muted-foreground hover:bg-muted'
              }`}
            >
              {lang === 'python' ? 'Python' : 'JavaScript'}
            </button>
          ))}
        </div>

        {/* 代码编辑器：行号 + textarea + 高亮覆盖层 */}
        <div className="relative overflow-hidden rounded-md border border-border bg-background">
          <div className="flex">
            {/* 行号列 */}
            <div
              className="select-none overflow-hidden border-r border-border bg-muted px-2 py-2 text-right font-mono text-[11px] leading-[1.5] text-muted-foreground"
              style={{ minWidth: '2.5rem' }}
            >
              {lines.map((n) => (
                <div key={n}>{n}</div>
              ))}
            </div>
            {/* 代码区：高亮覆盖层 + 透明 textarea */}
            <div className="relative min-w-0 flex-1">
              <pre
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre px-2.5 py-2 font-mono text-[11px] leading-[1.5]"
                style={{ transform: `translate(${-codeScroll.left}px, ${-codeScroll.top}px)` }}
              >
                {tokens.map((t, idx) => (
                  <span key={idx} className={t.className}>
                    {t.text}
                  </span>
                ))}
                {'\n'}
              </pre>
              <textarea
                ref={codeRef}
                onScroll={handleScroll}
                className="relative w-full resize-y bg-transparent px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-transparent caret-foreground outline-none"
                style={{ caretColor: 'var(--foreground)', minHeight: '200px' }}
                rows={12}
                value={node.data.code}
                onChange={(e) => setField('code')(e.target.value)}
                spellCheck={false}
                placeholder={
                  node.data.language === 'javascript'
                    ? '// 可用变量：input_data、ctx\n// 将结果赋值给 result\nresult = { echo: input_data };'
                    : '# 可用变量：input_data、ctx\n# 将结果赋值给 result\nresult = {"echo": input_data}'
                }
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="可用模块" hint="已内置以下模块，可直接 import 使用。">
        <div className="rounded-md border border-border bg-muted p-2 font-mono text-[11px] text-muted-foreground">
          {node.data.language === 'javascript'
            ? 'JSON · Math · Date · Object · Array · String · Number · Boolean'
            : 'json · re · math · datetime · hashlib · base64'}
        </div>
      </Section>

      {/* 输出变量定义列表 */}
      <Section title="输出变量定义" hint="声明本节点执行后的输出变量，供下游节点通过 {{node_id.output.变量名}} 引用">
        <VariableIOEditor
          value={node.data.output_variables || []}
          onChange={setField('output_variables')}
          direction="output"
        />
      </Section>

      <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
    </>
  )
}

// 根据节点类型渲染对应表单（所有输入框宽度 100% 填满面板）
// toolOptions：动态加载的 DB 工具列表 {value:name, label}，供 ai_agent 节点选择
// toolsList：完整工具对象列表（含 id），供 tool 节点查找 id 并推断 schema
// agentOptions：动态加载的智能体列表 {value:id, label}，供 ai_agent 节点选择
// workflowId：当前工作流 ID（webhook URL 用）
function renderForm(node, update, toolOptions, toolsList, llmOptions, agentOptions, workflowId) {
  // setField：更新节点 data 上的某个字段
  const setField = (field) => (value) => update(node.id, { [field]: value })
  // setAuth：更新 http_request 的 auth 子对象
  const setAuth = (field) => (value) =>
    update(node.id, { auth: { ...node.data.auth, [field]: value } })

  switch (node.type) {
    // ============ Webhook 触发器（增强：URL 复制 / 签名验证 / 示例 Payload / 测试 Webhook / 失败重试）============
    case 'webhook_trigger': {
      return <WebhookTriggerForm node={node} update={update} workflowId={workflowId} />
    }

    // ============ HTTP 请求 ============
    case 'http_request': {
      const authType = node.data.auth_type
      return (
        <>
          <Section title="请求设置">
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <SelectInput
                label="Method"
                value={node.data.method}
                onChange={setField('method')}
                options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']}
              />
              <TextInput
                label="URL"
                value={node.data.url}
                onChange={setField('url')}
                placeholder="https://api.example.com/endpoint"
              />
            </div>
          </Section>

          <Section title="认证 Authentication">
            <SelectInput
              label="认证方式"
              value={authType}
              onChange={setField('auth_type')}
              options={[
                { value: 'none', label: '无' },
                { value: 'basic', label: 'Basic Auth' },
                { value: 'api_key', label: 'API Key (Header)' },
                { value: 'bearer', label: 'Bearer Token' },
              ]}
            />
            {authType === 'basic' && (
              <div className="grid grid-cols-2 gap-2">
                <TextInput label="用户名" value={node.data.auth.username} onChange={setAuth('username')} />
                <TextInput label="密码" value={node.data.auth.password} onChange={setAuth('password')} />
              </div>
            )}
            {authType === 'api_key' && (
              <div className="grid grid-cols-2 gap-2">
                <TextInput label="Header 名" value={node.data.auth.key_name} onChange={setAuth('key_name')} placeholder="X-API-Key" />
                <TextInput label="Key 值" value={node.data.auth.key_value} onChange={setAuth('key_value')} />
              </div>
            )}
            {authType === 'bearer' && (
              <TextInput label="Token" value={node.data.auth.token} onChange={setAuth('token')} placeholder="Bearer token" />
            )}
          </Section>

          <Section title="Headers">
            <KeyValueEditor value={node.data.headers} onChange={setField('headers')} keyPlaceholder="Header 名" valuePlaceholder="Header 值" />
          </Section>

          <Section title="Query Parameters">
            <KeyValueEditor value={node.data.query_params} onChange={setField('query_params')} keyPlaceholder="参数名" valuePlaceholder="参数值" />
          </Section>

          <Section title="请求体 Body">
            <SelectInput
              label="Body 类型"
              value={node.data.body_type}
              onChange={setField('body_type')}
              options={[
                { value: 'none', label: '无' },
                { value: 'json', label: 'JSON' },
                { value: 'form', label: 'Form-Data' },
                { value: 'urlencoded', label: 'x-www-form-urlencoded' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
            {(node.data.body_type === 'json' || node.data.body_type === 'raw') && (
              <TextArea
                label="Body 内容"
                value={node.data.body_content}
                onChange={setField('body_content')}
                rows={6}
                placeholder='{"key": "value"}'
              />
            )}
            {(node.data.body_type === 'form' || node.data.body_type === 'urlencoded') && (
              <KeyValueEditor value={node.data.body_form} onChange={setField('body_form')} keyPlaceholder="字段名" valuePlaceholder="字段值" />
            )}
          </Section>

          <Section title="高级选项">
            <SelectInput
              label="响应格式"
              value={node.data.response_format}
              onChange={setField('response_format')}
              options={[
                { value: 'json', label: 'JSON' },
                { value: 'text', label: 'Text' },
                { value: 'base64', label: 'Base64' },
              ]}
            />
          </Section>

          <Section title="输出变量">
            <OutputVarList vars={[
              'response.status : number',
              'response.headers : object',
              'response.body : object',
            ]} />
          </Section>

          {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
          <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
        </>
      )
    }

    // ============ AI 智能体（选择已创建的智能体，复用其完整配置） ============
    case 'ai_agent': {
      const selectedAgentOpt = (agentOptions || []).find(
        (o) => o.value === String(node.data.agent_id ?? '')
      )
      return (
        <>
          <Section
            title="选择智能体"
            hint="从「智能体管理」中已创建的智能体里选择一个。节点的模型、系统提示词、工具、知识库、技能等配置全部复用该智能体，无需在此重复配置。"
          >
            <SelectInput
              label="智能体"
              value={node.data.agent_id ? String(node.data.agent_id) : ''}
              onChange={(v) => setField('agent_id')(v ? Number(v) : null)}
              options={[{ value: '', label: '— 请选择智能体 —' }, ...(agentOptions || [])]}
            />
            {selectedAgentOpt && (
              <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                已选：{selectedAgentOpt.label}
                <div className="mt-1 text-[11px] text-muted-foreground">
                  该智能体的模型 / 提示词 / 工具 / 知识库配置将被原样复用。
                </div>
              </div>
            )}
            {!node.data.agent_id && (
              <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>未选择智能体。请先选择一个已创建的智能体；留空将回退到旧的安全决策逻辑。</span>
              </div>
            )}
          </Section>

          <Section
            title="输入 Prompt"
            hint="作为所选智能体的用户输入。支持用 ${node_id.field} 引用上游节点输出，点击右侧按钮选择变量。留空则用上游节点的原始输入。"
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <TextArea
                  label="User Prompt"
                  value={node.data.user_prompt}
                  onChange={setField('user_prompt')}
                  rows={5}
                  placeholder="例如：请分析以下告警数据并给出处置建议：${webhook_xxx.payload}"
                  hint="支持 ${node_id.field} 引用上游节点输出；留空则透传上游输入。"
                />
              </div>
              <div className="pt-[22px]">
                <NodeOutputPicker
                  currentNodeId={node.id}
                  onPick={(ref) => setField('user_prompt')(node.data.user_prompt ? `${node.data.user_prompt} ${ref}` : ref)}
                />
              </div>
            </div>
          </Section>

          <Section title="输出变量" hint="智能体执行后输出以下变量，可供下游节点通过 ${本节点ID.变量名} 引用。">
            <OutputVarList vars={[
              'response : string（智能体的最终回复文本）',
              'decision : string（SOC 决策模式输出的决策结果，如 block_ip/ignore）',
              'messages : array（推理过程消息列表）',
            ]} />
          </Section>

          {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
          <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
        </>
      )
    }

    // ============ LLM（纯文本生成，对标 Dify） ============
    case 'llm': {
      return (
        <>
          <Section title="模型设置" hint="从「模型设置」页面配置的 LLM 中选择，或手动指定模型名覆盖。">
            <SelectInput
              label="LLM 配置"
              value={node.data.model_config_id ? String(node.data.model_config_id) : ''}
              onChange={(v) => setField('model_config_id')(v ? Number(v) : null)}
              options={[{ value: '', label: '使用默认配置' }, ...(llmOptions || [])]}
            />
            <TextInput
              label="模型名（覆盖，可选）"
              value={node.data.model}
              onChange={setField('model')}
              placeholder="留空则用 LLM 配置中的模型名"
            />
            <div className="grid grid-cols-2 gap-2">
              <NumberInput label="温度 Temperature" value={node.data.temperature} onChange={setField('temperature')} min={0} max={2} step={0.1} hint="0=确定，2=发散" />
              <NumberInput label="Max Tokens" value={node.data.max_tokens} onChange={setField('max_tokens')} min={1} max={8192} />
            </div>
          </Section>

          <Section title="提示词 Prompt" hint="支持用 ${node_id.field} 引用上游节点输出，点击右侧按钮选择变量。">
            <TextArea
              label="System Prompt"
              value={node.data.system_prompt}
              onChange={setField('system_prompt')}
              rows={4}
              placeholder="例如：你是一名翻译专家，请将输入文本翻译为英文。"
            />
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <TextArea
                  label="User Prompt"
                  value={node.data.user_prompt}
                  onChange={setField('user_prompt')}
                  rows={6}
                  placeholder="输入需要处理的文本：${node_xxx.output}"
                  hint="支持用 ${node_id.field} 引用上游节点输出"
                />
              </div>
              <div className="pt-[22px]">
                <NodeOutputPicker
                  currentNodeId={node.id}
                  onPick={(ref) => setField('user_prompt')(node.data.user_prompt ? `${node.data.user_prompt} ${ref}` : ref)}
                />
              </div>
            </div>
          </Section>

          <Section title="输出变量">
            <OutputVarList vars={[
              'text : string（大模型生成的文本内容）',
            ]} />
          </Section>

          {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
          <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
        </>
      )
    }

    // ============ 条件分支（可视化增强：规则积木 + AND/OR + 变量选择器 + 表达式预览）============
    case 'condition_branch': {
      return <ConditionBranchForm node={node} update={update} />
    }

    // ============ 下发封禁指令 ============
    case 'block_ip': {
      return (
        <>
          <Section title="处置动作">
            <SelectInput
              label="动作类型"
              value={node.data.action}
              onChange={setField('action')}
              options={[
                { value: 'block', label: '封禁 (block)' },
                { value: 'unblock', label: '解封 (unblock)' },
              ]}
            />
            <TextInput
              label="目标 IP"
              value={node.data.target_ip}
              onChange={setField('target_ip')}
              placeholder="{{alert_data.src_ip}}"
              hint="支持变量引用，如 {{alert_data.src_ip}} 或固定 IP。"
            />
          </Section>

          <Section title="封禁参数">
            <div className="grid grid-cols-[1fr_110px] gap-2">
              <NumberInput label="封禁时长" value={node.data.duration_value} onChange={setField('duration_value')} min={1} />
              <SelectInput
                label="单位"
                value={node.data.duration_unit}
                onChange={setField('duration_unit')}
                options={['分钟', '小时', '天']}
              />
            </div>
            <TextArea
              label="封禁原因"
              value={node.data.reason}
              onChange={setField('reason')}
              rows={3}
              placeholder="处置原因（可引用上游节点输出）"
            />
          </Section>

          <Section title="设备与策略">
            <div className="grid grid-cols-2 gap-2">
              <SelectInput
                label="目标设备"
                value={node.data.device}
                onChange={setField('device')}
                options={[
                  { value: 'firewall-A', label: '防火墙-A' },
                  { value: 'firewall-B', label: '防火墙-B' },
                  { value: 'ids', label: 'IDS' },
                ]}
              />
              <SelectInput
                label="优先级"
                value={node.data.priority}
                onChange={setField('priority')}
                options={['低', '中', '高', '紧急']}
              />
            </div>
            <TextInput label="备注" value={node.data.remark} onChange={setField('remark')} placeholder="可选备注信息" />
            <CheckRow
              label="封禁成功后触发通知"
              checked={node.data.notify_on_success}
              onChange={setField('notify_on_success')}
            />
          </Section>

          {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
          <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
        </>
      )
    }

    // ============ 发送通知 ============
    case 'send_notification': {
      const channel = node.data.channel
      return (
        <>
          <Section title="通知渠道">
            <SelectInput
              label="渠道"
              value={channel}
              onChange={setField('channel')}
              options={[
                { value: 'email', label: '邮件 (Email)' },
                { value: 'webhook', label: 'Webhook' },
                { value: 'im', label: '即时通讯 (IM)' },
                { value: 'sms', label: '短信 (SMS)' },
              ]}
            />
            <SelectInput
              label="严重级别"
              value={node.data.severity}
              onChange={setField('severity')}
              options={[
                { value: 'info', label: 'Info 提示' },
                { value: 'warning', label: 'Warning 警告' },
                { value: 'error', label: 'Error 错误' },
                { value: 'critical', label: 'Critical 严重' },
              ]}
            />
          </Section>

          {channel === 'email' && (
            <>
              <Section
                title="SMTP 服务器"
                hint="QQ 邮箱：smtp.qq.com / 465 / SSL / 密码填授权码；163 邮箱：smtp.163.com / 465 / SSL；Gmail：smtp.gmail.com / 587 / STARTTLS。"
              >
                <div className="grid grid-cols-[1fr_90px] gap-2">
                  <TextInput
                    label="SMTP 服务器"
                    value={node.data.smtp_host}
                    onChange={setField('smtp_host')}
                    placeholder="smtp.qq.com"
                  />
                  <NumberInput
                    label="端口"
                    value={node.data.smtp_port}
                    onChange={setField('smtp_port')}
                    min={1}
                    max={65535}
                  />
                </div>
                <SelectInput
                  label="加密方式"
                  value={node.data.use_ssl ? 'ssl' : 'starttls'}
                  onChange={(v) => setField('use_ssl')(v === 'ssl')}
                  options={[
                    { value: 'ssl', label: 'SSL（端口 465）' },
                    { value: 'starttls', label: 'STARTTLS（端口 587）' },
                  ]}
                />
              </Section>

              <Section
                title="发件人认证"
                hint="QQ 邮箱的密码不是登录密码，而是「设置 → 账户 → SMTP 服务」生成的授权码。"
              >
                <TextInput
                  label="发件邮箱"
                  value={node.data.smtp_username}
                  onChange={setField('smtp_username')}
                  placeholder="请输入发件邮箱地址"
                />
                <TextInput
                  label="密码 / 授权码"
                  value={node.data.smtp_password}
                  onChange={setField('smtp_password')}
                  placeholder="QQ 邮箱填授权码"
                />
                <TextInput
                  label="发件人地址（可选）"
                  value={node.data.from_email}
                  onChange={setField('from_email')}
                  placeholder="留空则用发件邮箱"
                />
              </Section>

              <Section title="收件人">
                <TextInput
                  label="收件人（逗号分隔）"
                  value={node.data.recipients}
                  onChange={setField('recipients')}
                  placeholder="多个收件邮箱，逗号分隔"
                />
                <TextInput
                  label="抄送（可选）"
                  value={node.data.cc}
                  onChange={setField('cc')}
                  placeholder="多个抄送邮箱，逗号分隔"
                />
              </Section>
            </>
          )}
          {channel === 'webhook' && (
            <Section title="Webhook 配置">
              <TextInput
                label="Webhook URL"
                value={node.data.webhook_url}
                onChange={setField('webhook_url')}
                placeholder="https://hooks.example.com/notify"
              />
            </Section>
          )}
          {(channel === 'im' || channel === 'sms') && (
            <Section title="接收目标">
              <TextInput
                label="接收人/群（逗号分隔）"
                value={node.data.recipients}
                onChange={setField('recipients')}
                placeholder="群ID / 手机号"
              />
            </Section>
          )}

          <Section title="通知内容">
            <div className="flex items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <TextInput label="主题" value={node.data.subject} onChange={setField('subject')} placeholder="【安全告警】检测到恶意 IP 活动" />
              </div>
              <NodeOutputPicker
                currentNodeId={node.id}
                onPick={(ref) => setField('subject')(node.data.subject ? `${node.data.subject}${ref}` : ref)}
              />
            </div>
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <TextArea
                  label="正文"
                  value={node.data.body}
                  onChange={setField('body')}
                  rows={6}
                  placeholder={'检测到来自 ${node_xxx.output} 的攻击行为，已自动封禁。\n点击右侧按钮可选择上游节点输出。'}
                  hint="支持用 ${node_id.field} 引用上游节点输出，点击右侧按钮快速选择。"
                />
              </div>
              <div className="pt-[22px]">
                <NodeOutputPicker
                  currentNodeId={node.id}
                  onPick={(ref) => setField('body')(node.data.body ? `${node.data.body}\n${ref}` : ref)}
                />
              </div>
            </div>
            <TextInput label="附件（可选）" value={node.data.attachments} onChange={setField('attachments')} placeholder="附件URL，多个用逗号分隔" />
          </Section>

          {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
          <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
        </>
      )
    }

    // ============ 工具调用 ============
    case 'tool': {
      return (
        <ToolNodeForm
          node={node}
          update={update}
          toolOptions={toolOptions}
          toolsList={toolsList}
        />
      )
    }

    // ============ 设备动作（SOAR 设备对接）============
    case 'device_action': {
      return <DeviceActionForm node={node} update={update} />
    }

    // ============ 人工介入 ============
    case 'human_review': {
      return (
        <>
          <Section title="工单标题">
            <TextInput
              label="标题"
              value={node.data.title}
              onChange={setField('title')}
              placeholder="人工审批工单"
            />
          </Section>

          <Section
            title="审批说明"
            hint="展示给工作人员的指引，说明判断依据与可执行操作。"
          >
            <TextArea
              label="审批指引"
              value={node.data.instructions}
              onChange={setField('instructions')}
              rows={6}
              placeholder="审批指引说明（可引用上游节点输出）"
            />
          </Section>

          <Section title="行为说明">
            <div className="rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
              <div className="mb-1 text-muted-foreground">运行时行为：</div>
              <div>· 线上 Celery 执行时走到此节点会生成工单并阻塞等待</div>
              <div>· 工作人员在「工作台」选择「同意」或「忽略」</div>
              <div>· 同意 → 继续执行下游节点</div>
              <div>· 忽略 → 终止工作流，不再执行后续节点</div>
              <div className="mt-1 text-warning">提示：测试运行（test-run）模式下不会阻塞，仅返回 waiting_for_approval 标记。</div>
            </div>
          </Section>

          <Section title="输出变量">
            <OutputVarList vars={[
              'human_review_decision : string (approve/reject)',
            ]} />
          </Section>
        </>
      )
    }

    // ============ 代码执行（增强：语言单选 / 行号 / 语法高亮 / 输出变量列表）============
    case 'code_execute': {
      return <CodeExecuteForm node={node} update={update} />
    }

    // ============ 循环 ============
    case 'loop': {
      const loopMode = node.data.loop_mode
      return (
        <>
          <Section title="循环设置">
            <SelectInput
              label="循环模式"
              value={loopMode}
              onChange={setField('loop_mode')}
              options={[
                { value: 'count', label: '固定次数 (count)' },
                { value: 'while', label: '条件循环 (while)' },
              ]}
            />
            {loopMode === 'count' ? (
              <NumberInput
                label="循环次数"
                value={node.data.count}
                onChange={setField('count')}
                min={1}
                max={1000}
              />
            ) : (
              <>
                <ExpressionEditor
                  label="条件表达式"
                  value={node.data.loop_condition}
                  onChange={setField('loop_condition')}
                  rows={3}
                  placeholder="如 {{variables.should_continue}} == true 或 contains({{payload.event}}, 'alert')"
                  hint="每轮循环前评估，为 True 继续，为 False 停止。支持 {{变量}} 引用与 contains/length/now 等函数。"
                  currentNodeId={node.id}
                />
                <NumberInput
                  label="最大循环次数"
                  value={node.data.max_iterations}
                  onChange={setField('max_iterations')}
                  min={1}
                  max={10000}
                  hint="防止死循环的兜底上限"
                />
              </>
            )}
          </Section>

          <Section title="输出变量">
            <OutputVarList vars={[
              'loop_mode : string (count/while)',
              'count : number (count 模式的次数)',
            ]} />
          </Section>
        </>
      )
    }

    // ============ 迭代 ============
    case 'iteration': {
      const dataSource = node.data.data_source
      return (
        <>
          <Section title="数据源设置">
            <SelectInput
              label="数据源"
              value={dataSource}
              onChange={setField('data_source')}
              options={[
                { value: 'input', label: '上游节点输入 (input)' },
                { value: 'ctx', label: '上下文变量 (ctx)' },
                { value: 'custom', label: '自定义 JSON 数组 (custom)' },
              ]}
            />
            {dataSource === 'ctx' && (
              <TextInput
                label="变量路径"
                value={node.data.ctx_var}
                onChange={setField('ctx_var')}
                placeholder="如 agent_decision.messages 或 ctx 中的列表变量"
                hint="引用工作流上下文中的数组变量"
              />
            )}
            {dataSource === 'custom' && (
              <TextArea
                label="JSON 数组"
                value={node.data.custom_data}
                onChange={setField('custom_data')}
                rows={5}
                placeholder='["item1", "item2", "item3"]'
              />
            )}
          </Section>

          <Section title="输出变量">
            <OutputVarList
              vars={[
                'iteration_count : number (元素总数)',
                'items : array (待迭代数据)',
              ]}
              hint="子流程中可用 ${item} 引用当前元素"
            />
          </Section>
        </>
      )
    }

    // ============ 结束节点 ============
    case 'end': {
      return (
        <>
          <Section title="结束类型">
            <SelectInput
              label="结束类型"
              value={node.data.end_type}
              onChange={setField('end_type')}
              options={[
                { value: 'success', label: '成功 (success)' },
                { value: 'failed', label: '失败 (failed)' },
                { value: 'cancelled', label: '取消 (cancelled)' },
              ]}
              hint="标记工作流的最终结局，用于执行追溯与统计。"
            />
            <TextInput
              label="备注"
              value={node.data.remark}
              onChange={setField('remark')}
              placeholder="可选备注"
            />
          </Section>

          <Section title="行为说明">
            <div className="rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
              <div className="mb-1 text-muted-foreground">运行时行为：</div>
              <div>· 结束节点无出口，工作流走到此节点即终止</div>
              <div>· 用于显式标识流程终点，便于可视化与执行追溯</div>
            </div>
          </Section>
        </>
      )
    }

    default:
      return (
        <p className="text-sm text-muted-foreground">未识别的节点类型：{node.type}</p>
      )
  }
}

// 工具节点表单：选择工具后异步拉取 inferredSchema，按 input 类型渲染参数输入
// outputs 只读展示
function ToolNodeForm({ node, update, toolOptions, toolsList }) {
  const [schema, setSchema] = useState(null) // { inputs: [], outputs: [] }
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const toolName = node.data.tool_name || ''
  // 根据 tool_name 在完整列表中找到工具对象，取其 id
  const toolObj = (Array.isArray(toolsList) ? toolsList : []).find(
    (t) => t.name === toolName
  )
  const toolId = toolObj?.id

  // 选中工具变化时拉取 schema
  useEffect(() => {
    let alive = true
    if (!toolId) {
      setSchema(null)
      setErr('')
      return
    }
    setLoading(true)
    setErr('')
    ;(async () => {
      try {
        const res = await toolsApi.inferredSchema(toolId)
        if (!alive) return
        setSchema({
          inputs: Array.isArray(res?.inputs) ? res.inputs : [],
          outputs: Array.isArray(res?.outputs) ? res.outputs : [],
        })
      } catch (e) {
        if (!alive) return
        setErr(e.message || '拉取工具 schema 失败')
        setSchema(null)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [toolId])

  // 更新 parameters[name] = value（保留其它参数）
  const setParam = (name, value) =>
    update(node.id, {
      parameters: { ...(node.data.parameters || {}), [name]: value },
    })

  const inputs = schema?.inputs || []
  const outputs = schema?.outputs || []

  return (
    <>
      <Section title="工具选择" hint="选择已注册工具后，将自动拉取其输入输出参数 schema。">
        <SelectInput
          label="工具"
          value={toolName}
          onChange={(name) => update(node.id, { tool_name: name, parameters: {} })}
          options={[
            { value: '', label: '请选择…' },
            ...(Array.isArray(toolOptions) ? toolOptions : []),
          ]}
        />
        {toolName && toolId == null && (
          <p className="text-[11px] text-warning">
            未在工具列表中找到该工具的 id，无法推断参数 schema。
          </p>
        )}
      </Section>

      {loading && (
        <div className="rounded-md border border-border bg-card p-3 text-center text-[11px] text-muted-foreground">
          正在拉取工具参数…
        </div>
      )}
      {err && (
        <div className="rounded-md border border-danger-700/40 bg-danger-900/20 p-3 text-[11px] text-destructive">
          {err}
        </div>
      )}

      {/* 输入参数表单 */}
      {!loading && !err && inputs.length > 0 && (
        <Section title="输入参数" hint="按工具 schema 渲染；支持 {{变量名}} 引用上游输出。">
          {inputs.map((inp) => {
            const name = inp.name
            const type = (inp.type || 'string').toLowerCase()
            const cur = (node.data.parameters || {})[name] ?? ''
            // Boolean → 下拉 true/false
            if (type === 'boolean' || type === 'bool') {
              return (
                <SelectInput
                  key={name}
                  label={`${name} (${inp.type || 'boolean'}${inp.required ? ' *' : ''})`}
                  value={String(cur === '' ? '' : cur)}
                  onChange={(v) => setParam(name, v === 'true')}
                  options={[
                    { value: '', label: '未设置' },
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' },
                  ]}
                />
              )
            }
            // Number → 数字输入
            if (type === 'number' || type === 'int' || type === 'integer' || type === 'float' || type === 'double') {
              return (
                <NumberInput
                  key={name}
                  label={`${name} (${inp.type || 'number'}${inp.required ? ' *' : ''})`}
                  value={cur === '' ? 0 : Number(cur)}
                  onChange={(v) => setParam(name, v)}
                />
              )
            }
            // Object / Array → textarea（JSON）
            if (type === 'object' || type === 'array') {
              return (
                <div key={name} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <TextArea
                      label={`${name} (${inp.type || type}${inp.required ? ' *' : ''})`}
                      value={
                        typeof cur === 'string'
                          ? cur
                          : (() => {
                              try {
                                return JSON.stringify(cur, null, 2)
                              } catch {
                                return ''
                              }
                            })()
                      }
                      onChange={(v) => {
                        // 尝试解析 JSON，失败则保留原始字符串
                        let parsed
                        try {
                          parsed = v.trim() ? JSON.parse(v) : ''
                        } catch {
                          parsed = v
                        }
                        setParam(name, parsed)
                      }}
                      rows={4}
                      placeholder={type === 'array' ? '[\n  "item1"\n]' : '{\n  "key": "value"\n}'}
                    />
                  </div>
                  <div className="pt-[22px]">
                    <NodeOutputPicker
                      currentNodeId={node.id}
                      onPick={(ref) => {
                        const curStr = typeof cur === 'string' ? cur : JSON.stringify(cur || '', null, 2)
                        setParam(name, curStr ? `${curStr}\n${ref}` : ref)
                      }}
                    />
                  </div>
                </div>
              )
            }
            // 其它（string 等）→ 文本输入
            return (
              <div key={name} className="flex items-end gap-1.5">
                <div className="min-w-0 flex-1">
                  <TextInput
                    label={`${name} (${inp.type || 'string'}${inp.required ? ' *' : ''})`}
                    value={cur}
                    onChange={(v) => setParam(name, v)}
                    placeholder={inp.description || ''}
                  />
                </div>
                <NodeOutputPicker
                  currentNodeId={node.id}
                  onPick={(ref) => setParam(name, cur ? `${cur}${ref}` : ref)}
                />
              </div>
            )
          })}
          {inputs.some((i) => i.description) && (
            <div className="rounded-md border border-border bg-muted p-2 text-[11px] text-muted-foreground">
              {inputs
                .filter((i) => i.description)
                .map((i) => (
                  <div key={i.name}>
                    <span className="text-muted-foreground">{i.name}</span>：{i.description}
                  </div>
                ))}
            </div>
          )}
        </Section>
      )}

      {/* 输出（只读） */}
      {!loading && !err && outputs.length > 0 && (
        <Section title="输出（只读）" hint="工具执行后下游节点可通过这些字段引用结果。">
          <div className="rounded-md border border-border bg-muted p-2 font-mono text-[11px] text-muted-foreground">
            {outputs.map((o, idx) => (
              <div key={idx}>
                <span className="text-primary">{o.name}</span>
                <span className="text-muted-foreground"> : {o.type || 'any'}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {!loading && !err && toolId != null && inputs.length === 0 && outputs.length === 0 && (
        <div className="rounded-md border border-border bg-card p-3 text-center text-[11px] text-muted-foreground">
          该工具未提供参数 schema。
        </div>
      )}

      {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
      <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
    </>
  )
}

// 设备动作节点表单：选择设备 → 加载该设备的动作 → 选择动作 → 渲染参数 schema
// 选择设备后异步拉取其动作列表；选择动作后解析 params_schema 渲染参数输入
function DeviceActionForm({ node, update }) {
  const [devicesList, setDevicesList] = useState([])
  const [actionsList, setActionsList] = useState([])
  const [loadingDevices, setLoadingDevices] = useState(true)
  const [loadingActions, setLoadingActions] = useState(false)
  const [actionsErr, setActionsErr] = useState('')

  const deviceId = node.data.device_id
  const actionId = node.data.action_id

  // 初次加载设备列表
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const data = await devicesApi.list()
        if (!alive) return
        setDevicesList(Array.isArray(data) ? data : [])
      } catch {
        // 静默失败
      } finally {
        if (alive) setLoadingDevices(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 设备变化时拉取其动作列表
  useEffect(() => {
    let alive = true
    if (!deviceId) {
      setActionsList([])
      setActionsErr('')
      return
    }
    setLoadingActions(true)
    setActionsErr('')
    ;(async () => {
      try {
        const data = await devicesApi.listActions(deviceId)
        if (!alive) return
        setActionsList(Array.isArray(data) ? data : [])
      } catch (e) {
        if (!alive) return
        setActionsErr(e.message || '加载动作失败')
        setActionsList([])
      } finally {
        if (alive) setLoadingActions(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [deviceId])

  // 当前选中的动作对象
  const selectedAction = actionsList.find((a) => a.id === actionId) || null

  // 解析动作的 params_schema
  let paramSchema = []
  if (selectedAction) {
    try {
      paramSchema = JSON.parse(selectedAction.params_schema || '[]')
    } catch {
      paramSchema = []
    }
  }

  const setParam = (name, value) =>
    update(node.id, {
      params: { ...(node.data.params || {}), [name]: value },
    })

  return (
    <>
      <Section
        title="设备选择"
        hint="从「设备对接」页面已配置的设备中选择。仅展示已启用的设备。"
      >
        {loadingDevices ? (
          <div className="rounded-md border border-border bg-card p-3 text-center text-[11px] text-muted-foreground">
            加载设备列表…
          </div>
        ) : devicesList.length === 0 ? (
          <div className="rounded-md border border-warning-700/40 bg-warning-900/10 p-3 text-[11px] text-warning">
            暂无可用设备，请先到「设备对接」页面添加设备并配置动作。
          </div>
        ) : (
          <SelectInput
            label="目标设备"
            value={deviceId ? String(deviceId) : ''}
            onChange={(v) => {
              const id = v ? Number(v) : null
              update(node.id, { device_id: id, action_id: null, params: {} })
            }}
            options={[
              { value: '', label: '请选择…' },
              ...devicesList
                .filter((d) => d.enabled)
                .map((d) => ({
                  value: String(d.id),
                  label: `${d.name} (${d.type}${d.vendor ? ` · ${d.vendor}` : ''})`,
                })),
            ]}
          />
        )}
      </Section>

      {deviceId != null && (
        <Section
          title="动作选择"
          hint="选择设备已配置的动作。动作类型对应 SOAR 处置动作（封禁/解封/隔离/IOC 等）。"
        >
          {loadingActions ? (
            <div className="rounded-md border border-border bg-card p-3 text-center text-[11px] text-muted-foreground">
              加载动作列表…
            </div>
          ) : actionsErr ? (
            <div className="rounded-md border border-danger-700/40 bg-danger-900/20 p-3 text-[11px] text-destructive">
              {actionsErr}
            </div>
          ) : actionsList.length === 0 ? (
            <div className="rounded-md border border-warning-700/40 bg-warning-900/10 p-3 text-[11px] text-warning">
              该设备暂无动作配置，请到「设备对接」页面为该设备添加动作。
            </div>
          ) : (
            <SelectInput
              label="动作"
              value={actionId ? String(actionId) : ''}
              onChange={(v) => {
                const id = v ? Number(v) : null
                update(node.id, { action_id: id, params: {} })
              }}
              options={[
                { value: '', label: '请选择…' },
                ...actionsList
                  .filter((a) => a.enabled)
                  .map((a) => ({
                    value: String(a.id),
                    label: `${a.name} (${a.action_type})`,
                  })),
              ]}
            />
          )}
          {selectedAction && (
            <div className="rounded-md border border-border bg-muted p-2 text-[11px] text-muted-foreground">
              <div>
                <span className="text-muted-foreground">HTTP 方法：</span>
                <span className="font-mono text-primary">
                  {selectedAction.http_method}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">API 路径：</span>
                <span className="font-mono text-primary">
                  {selectedAction.api_path || '(空)'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">认证方式：</span>
                <span className="font-mono text-primary">
                  {selectedAction.auth_type}
                </span>
              </div>
              {selectedAction.description && (
                <div className="mt-1 text-muted-foreground">
                  {selectedAction.description}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {selectedAction && paramSchema.length > 0 && (
        <Section
          title="动作参数"
          hint="按动作 schema 渲染；支持用 ${node_id.field} 引用上游节点输出。"
        >
          {paramSchema.map((inp) => {
            const name = inp.name
            const type = (inp.type || 'string').toLowerCase()
            const cur = (node.data.params || {})[name] ?? ''
            // Boolean → 下拉 true/false
            if (type === 'boolean' || type === 'bool') {
              return (
                <SelectInput
                  key={name}
                  label={`${name} (${inp.type || 'boolean'}${inp.required ? ' *' : ''})`}
                  value={String(cur === '' ? '' : cur)}
                  onChange={(v) => setParam(name, v === 'true')}
                  options={[
                    { value: '', label: '未设置' },
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' },
                  ]}
                />
              )
            }
            // Number → 数字输入
            if (type === 'number' || type === 'int' || type === 'integer' || type === 'float' || type === 'double') {
              return (
                <div key={name} className="flex items-end gap-1.5">
                  <div className="min-w-0 flex-1">
                    <NumberInput
                      label={`${name} (${inp.type || 'number'}${inp.required ? ' *' : ''})`}
                      value={cur === '' ? 0 : Number(cur)}
                      onChange={(v) => setParam(name, v)}
                    />
                  </div>
                  <NodeOutputPicker
                    currentNodeId={node.id}
                    onPick={(ref) => setParam(name, cur ? `${cur}${ref}` : ref)}
                  />
                </div>
              )
            }
            // Object / Array → textarea
            if (type === 'object' || type === 'array') {
              return (
                <div key={name} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <TextArea
                      label={`${name} (${inp.type || type}${inp.required ? ' *' : ''})`}
                      value={
                        typeof cur === 'string'
                          ? cur
                          : (() => {
                              try {
                                return JSON.stringify(cur, null, 2)
                              } catch {
                                return ''
                              }
                            })()
                      }
                      onChange={(v) => {
                        let parsed
                        try {
                          parsed = v.trim() ? JSON.parse(v) : ''
                        } catch {
                          parsed = v
                        }
                        setParam(name, parsed)
                      }}
                      rows={4}
                      placeholder={type === 'array' ? '["a","b"]' : '{"key":"value"}'}
                    />
                  </div>
                  <div className="pt-[22px]">
                    <NodeOutputPicker
                      currentNodeId={node.id}
                      onPick={(ref) => {
                        const curStr = typeof cur === 'string' ? cur : JSON.stringify(cur || '', null, 2)
                        setParam(name, curStr ? `${curStr}\n${ref}` : ref)
                      }}
                    />
                  </div>
                </div>
              )
            }
            // 其它（string 等）→ 文本输入
            return (
              <div key={name} className="flex items-end gap-1.5">
                <div className="min-w-0 flex-1">
                  <TextInput
                    label={`${name} (${inp.type || 'string'}${inp.required ? ' *' : ''})`}
                    value={cur}
                    onChange={(v) => setParam(name, v)}
                    placeholder={inp.description || ''}
                  />
                </div>
                <NodeOutputPicker
                  currentNodeId={node.id}
                  onPick={(ref) => setParam(name, cur ? `${cur}${ref}` : ref)}
                />
              </div>
            )
          })}
          {paramSchema.some((i) => i.description) && (
            <div className="rounded-md border border-border bg-muted p-2 text-[11px] text-muted-foreground">
              {paramSchema
                .filter((i) => i.description)
                .map((i) => (
                  <div key={i.name}>
                    <span className="text-muted-foreground">{i.name}</span>：{i.description}
                  </div>
                ))}
            </div>
          )}
        </Section>
      )}

      <Section title="输出变量">
        <OutputVarList vars={[
          'output : 设备 API 的响应体',
          'status_code : HTTP 状态码',
          'success : 是否成功（status < 400）',
        ]} />
      </Section>

      {/* 错误处理折叠面板：超时 / 重试 / 失败策略 */}
      <ErrorHandlingSection data={node.data} update={(patch) => update(node.id, patch)} />
    </>
  )
}

// 日志条目颜色
function logLevelColor(level) {
  switch ((level || '').toLowerCase()) {
    case 'error':
      return 'text-destructive'
    case 'warn':
    case 'warning':
      return 'text-warning'
    default:
      return 'text-muted-foreground'
  }
}

// 单节点试运行结果展示弹窗
function TestNodeResultModal({ open, result, error, onClose }) {
  return (
    <Modal
      open={open}
      title="单节点试运行结果"
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-foreground hover:bg-primary"
        >
          关闭
        </button>
      }
    >
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Output</div>
            <pre className="max-h-64 w-full overflow-auto rounded-md bg-background p-3 font-mono text-xs text-foreground ring-1 ring-border">
              {result?.output == null
                ? '(空)'
                : typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output, null, 2)}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Logs（{(result?.logs || []).length} 条）
            </div>
            <div className="max-h-64 w-full overflow-auto rounded-md bg-background p-3 ring-1 ring-border">
              {(result?.logs || []).length === 0 ? (
                <div className="text-xs text-muted-foreground">暂无日志</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {(result.logs || []).map((log, idx) => (
                    <div key={idx} className="font-mono text-xs">
                      <span className={`mr-2 ${logLevelColor(log.level)}`}>
                        [{(log.level || 'info').toUpperCase()}]
                      </span>
                      {log.node_id && (
                        <span className="mr-2 text-primary">[{log.node_id}]</span>
                      )}
                      <span className="text-muted-foreground">{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

// 右侧属性面板
function PropertyPanel() {
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const workflowId = useWorkflowStore((s) => s.workflowId)
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData)
  const removeNode = useWorkflowStore((s) => s.removeNode)
  const setRunLogs = useWorkflowStore((s) => s.setRunLogs)

  const [testOpen, setTestOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [resultErr, setResultErr] = useState('')
  const [resultOpen, setResultOpen] = useState(false)
  // 试运行结果可折叠面板（内嵌在按钮下方）
  const [inlineResult, setInlineResult] = useState(null) // { input, output, logs, duration_ms, status, error, ts }
  const [inlineResultOpen, setInlineResultOpen] = useState(true)

  // 动态加载 DB 工具列表，供 ai_agent / tool 节点使用（新建工具也会出现）
  // toolOptions: {value:name, label} 供选择控件
  // toolsList: 完整对象（含 id），供 tool 节点查找 id 调 inferredSchema
  const [toolOptions, setToolOptions] = useState([])
  const [toolsList, setToolsList] = useState([])
  // LLM 配置列表，供 ai_agent 节点选择模型
  const [llmOptions, setLlmOptions] = useState([])
  // 智能体列表，供 ai_agent 节点选择已创建的智能体
  const [agentOptions, setAgentOptions] = useState([])
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const tls = await toolsApi.list()
        if (!alive) return
        const arr = Array.isArray(tls) ? tls : []
        setToolsList(arr)
        setToolOptions(
          arr.map((t) => ({
            value: t.name,
            label: `${t.name || `工具 ${t.id}`}${t.enabled === false ? '（已禁用）' : ''}`,
          }))
        )
      } catch {
        // 加载失败时保留空列表，不影响其它节点配置
      }
      // 加载 LLM 配置列表
      try {
        const cfgs = await llmApi.list()
        if (!alive) return
        const arr = Array.isArray(cfgs) ? cfgs : []
        setLlmOptions(
          arr.map((c) => ({
            value: String(c.id),
            label: `${c.name || '未命名'} (${c.provider || '?'}/${c.model_name || '默认'})${c.is_default ? ' ★默认' : ''}`,
          }))
        )
      } catch {
        // 加载失败时保留空列表
      }
      // 加载智能体列表，供 ai_agent 节点选择（复用已创建智能体的完整配置）
      try {
        const ags = await agentsApi.list()
        if (!alive) return
        const arr = Array.isArray(ags) ? ags : []
        setAgentOptions(
          arr.map((a) => ({
            value: String(a.id),
            label: `${a.name || `智能体 ${a.id}`} (${(a.engine || 'hermes') === 'hermes' ? 'Hermes' : 'Legacy'})`,
          }))
        )
      } catch {
        // 加载失败时保留空列表
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null

  // 自动构造模拟输入数据：从上游节点的 output_variables 或默认值生成
  const buildMockInput = useCallback(
    (node) => {
      if (!node) return {}
      const upstream = getUpstreamNodes(node.id, nodes, edges)
      const input = {}
      upstream.forEach((n) => {
        const outputs = Array.isArray(n.data?.output_variables) ? n.data.output_variables : []
        if (outputs.length > 0) {
          const nodeOutput = {}
          outputs.forEach((v) => {
            const name = typeof v === 'string' ? v : v?.name
            if (name) nodeOutput[name] = null
          })
          input[n.id] = { output: nodeOutput }
        } else {
          // 回退：按节点类型给常用默认输出
          input[n.id] = { output: null }
        }
      })
      // 没有上游节点时提供默认 payload
      if (Object.keys(input).length === 0) {
        input.payload = { event: 'test', data: { key: 'value' } }
      }
      return input
    },
    [nodes, edges]
  )

  // 单节点试运行：弹出 JSON 输入弹窗 -> 调 POST /workflows/test-node -> 展示 output + logs
  const handleTestNode = async (inputData) => {
    setTestOpen(false)
    if (!selectedNode) return
    setRunning(true)
    setResultErr('')
    const start = performance.now()
    try {
      // 传给后端的 node 对象只包含干净字段
      const nodePayload = {
        id: selectedNode.id,
        type: selectedNode.type,
        data: selectedNode.data,
      }
      const res = await workflowsApi.testNode(nodePayload, inputData)
      setResult(res)
      setResultOpen(true)
      // 同时把日志灌入全局 runLogs，便于底部抽屉查看
      const logs = (res?.logs || []).map((l) => ({
        ...l,
        node_id: l.node_id || selectedNode.id,
        timestamp: l.timestamp || new Date().toISOString(),
      }))
      setRunLogs(logs)
      // 写入内嵌结果面板
      setInlineResult({
        input: inputData,
        output: res?.output,
        logs,
        duration_ms: Math.round(performance.now() - start),
        status: 'success',
        ts: new Date().toISOString(),
      })
      setInlineResultOpen(true)
    } catch (err) {
      setResultErr(err.message || String(err))
      setResultOpen(true)
      setRunLogs([
        {
          level: 'error',
          node_id: selectedNode.id,
          message: `单节点试运行失败：${err.message || err}`,
          timestamp: new Date().toISOString(),
        },
      ])
      setInlineResult({
        input: inputData,
        output: null,
        logs: [],
        duration_ms: Math.round(performance.now() - start),
        status: 'error',
        error: err.message || String(err),
        ts: new Date().toISOString(),
      })
      setInlineResultOpen(true)
    } finally {
      setRunning(false)
    }
  }

  // 快速试运行：自动构造模拟输入，无需手动填写 JSON
  const handleQuickTest = () => {
    if (!selectedNode || running) return
    const mockInput = buildMockInput(selectedNode)
    handleTestNode(mockInput)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3">
        {!selectedNode ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-4 text-center">
            <Settings className="h-8 w-8 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              点击画布上的节点查看配置
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 节点概要 */}
            <div className="rounded-md border border-border bg-muted p-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground">
                  {renderNodeIcon(getNodeDefinition(selectedNode.type)?.icon)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {selectedNode.data?.label ||
                      getNodeDefinition(selectedNode.type)?.label}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    ID: {selectedNode.id} · {selectedNode.type}
                  </div>
                </div>
              </div>
            </div>

            {/* 节点名称与描述（统一编辑区，位于表单顶部） */}
            <Section
              title="节点名称与描述"
              hint="双击节点也可快速改名"
            >
              <TextInput
                label="节点名称"
                value={selectedNode.data?.label || ''}
                onChange={(v) => updateNodeData(selectedNode.id, { label: v })}
                placeholder={`默认：${getNodeDefinition(selectedNode.type)?.label || ''}`}
              />
              <TextInput
                label="节点描述"
                value={selectedNode.data?.description || ''}
                onChange={(v) =>
                  updateNodeData(selectedNode.id, { description: v })
                }
                placeholder="可选，备注此节点的用途"
              />
            </Section>

            {/* 类型对应表单（含各节点专属的输入/输出变量说明） */}
            {renderForm(selectedNode, updateNodeData, toolOptions, toolsList, llmOptions, agentOptions, workflowId)}

            {/* 试运行此节点按钮 + 自定义输入入口 */}
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={handleQuickTest}
                disabled={running}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-primary bg-primary/30 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {running ? '运行中…' : '试运行此节点'}
              </button>
              <button
                type="button"
                onClick={() => setTestOpen(true)}
                disabled={running}
                title="自定义输入 JSON 后试运行"
                className="rounded-md border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                自定义输入
              </button>
            </div>

            {/* 试运行结果可折叠面板 */}
            {inlineResult && (
              <div className="rounded-md border border-border bg-muted">
                <button
                  type="button"
                  onClick={() => setInlineResultOpen((o) => !o)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-foreground hover:bg-accent"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${inlineResultOpen ? 'rotate-0' : '-rotate-90'}`}
                  />
                  <span>试运行结果</span>
                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      inlineResult.status === 'success'
                        ? 'bg-success/15 text-success'
                        : 'bg-destructive/15 text-destructive'
                    }`}
                  >
                    {inlineResult.status === 'success' ? '成功' : '失败'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {inlineResult.duration_ms}ms
                  </span>
                </button>
                {inlineResultOpen && (
                  <div className="flex flex-col gap-2 border-t border-border p-3">
                    {/* 输入 */}
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">输入</div>
                      <pre className="max-h-32 w-full overflow-auto rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                        {JSON.stringify(inlineResult.input, null, 2)}
                      </pre>
                    </div>
                    {/* 输出 */}
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">输出</div>
                      {inlineResult.error ? (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                          {inlineResult.error}
                        </div>
                      ) : (
                        <pre className="max-h-48 w-full overflow-auto rounded-md bg-background p-2 font-mono text-[11px] text-foreground ring-1 ring-border">
                          {inlineResult.output == null
                            ? '(空)'
                            : typeof inlineResult.output === 'string'
                            ? inlineResult.output
                            : JSON.stringify(inlineResult.output, null, 2)}
                        </pre>
                      )}
                    </div>
                    {/* 日志 */}
                    {inlineResult.logs && inlineResult.logs.length > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                          日志（{inlineResult.logs.length} 条）
                        </div>
                        <div className="max-h-32 w-full overflow-auto rounded-md bg-background p-2 ring-1 ring-border">
                          {inlineResult.logs.map((log, idx) => (
                            <div key={idx} className="font-mono text-[11px]">
                              <span className={`mr-2 ${logLevelColor(log.level)}`}>
                                [{(log.level || 'info').toUpperCase()}]
                              </span>
                              <span className="text-muted-foreground">{log.message}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部删除按钮 */}
      {selectedNode && (
        <div className="shrink-0 border-t border-border p-3">
          <button
            type="button"
            onClick={() => removeNode(selectedNode.id)}
            className="w-full rounded-md border border-danger-800/60 bg-danger-900/20 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-danger-900/40 hover:text-destructive"
          >
            删除节点
          </button>
        </div>
      )}

      {/* 单节点试运行输入弹窗 */}
      <JsonInputDialog
        open={testOpen}
        title={`试运行节点：${selectedNode ? selectedNode.id : ''} · 输入 input_data（JSON）`}
        defaultValue="{}"
        onClose={() => setTestOpen(false)}
        onSubmit={handleTestNode}
        submitText="开始运行"
      />

      {/* 试运行结果弹窗 */}
      <TestNodeResultModal
        open={resultOpen}
        result={result}
        error={resultErr}
        onClose={() => setResultOpen(false)}
      />
    </div>
  )
}

export default PropertyPanel
