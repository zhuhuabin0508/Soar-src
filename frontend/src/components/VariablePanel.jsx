import { useState, useEffect, useMemo, useRef } from 'react'
import { useWorkflowStore } from '../store/workflowStore'
import { workflows } from '../api/client'
import { toast } from '../store/toastStore'
import {
  Check, ChevronDown, ChevronRight, Eye, EyeOff, Trash2, Save,
  Variable, Key, Boxes, GitBranch, ArrowRight, Shield, Copy, RefreshCw,
} from 'lucide-react'
import { inputCls } from './property/FormControls'
import { PillTabs } from './ui'

// 内置上下文变量列表（执行时自动注入，不可编辑）
const BUILTIN_VARS = [
  { name: 'payload', desc: '触发 payload 对象，如 ${payload.src_ip}', path: 'payload' },
  { name: 'execution_id', desc: '当前执行 ID', path: 'execution_id' },
  { name: 'workflow_id', desc: '工作流 ID', path: 'workflow_id' },
  { name: 'timestamp', desc: '执行时间戳（ISO 格式）', path: 'timestamp' },
]

// 节点类型 → 输出字段映射（用于数据流视图推断输入来源）
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
    { field: 'output', label: 'output' },
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
  schedule_trigger: '定时触发', event_trigger: '事件触发', manual_trigger: '手动触发',
  variable_assign: '变量赋值', wait: '等待', extract_data: '数据提取', llm_extract: 'AI抽取',
}

// 提取节点局部变量（运行时由节点产生）
// variable_assign: data.assignments = [{ name, value }]
// code_execute / ai_agent: data.output_variables = [{ name, description }]
function extractLocalVars(nodes) {
  const result = []
  nodes.forEach((n) => {
    const label = n.data?.label || n.data?.name || NODE_TYPE_LABELS[n.type] || n.type
    if (n.type === 'variable_assign' && Array.isArray(n.data?.assignments)) {
      n.data.assignments.forEach((a) => {
        if (a && a.name) {
          result.push({
            name: a.name,
            source: label,
            sourceType: '变量赋值',
            desc: a.value != null ? `值: ${String(a.value).slice(0, 40)}` : '',
          })
        }
      })
    }
    if ((n.type === 'code_execute' || n.type === 'ai_agent') && Array.isArray(n.data?.output_variables)) {
      n.data.output_variables.forEach((v) => {
        if (v && v.name) {
          result.push({
            name: v.name,
            source: label,
            sourceType: n.type === 'code_execute' ? '代码执行输出' : 'AI智能体输出',
            desc: v.description || '',
          })
        }
      })
    }
  })
  return result
}

// 递归扫描对象/数组中的字符串，匹配 {{var}} 或 ${var} 引用
const REF_RE = /\{\{\s*([^}\s]+)\s*\}\}|\$\{\s*([^}\s]+)\s*\}/g
function scanValue(value, found) {
  if (value == null) return
  if (typeof value === 'string') {
    let m
    REF_RE.lastIndex = 0
    while ((m = REF_RE.exec(value)) !== null) {
      const name = m[1] || m[2]
      if (name) found.add(name)
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => scanValue(v, found))
  } else if (typeof value === 'object') {
    Object.values(value).forEach((v) => scanValue(v, found))
  }
}

// 构建变量引用关系图：{ 变量名: [节点标签数组] }
function buildVarReferenceMap(nodes) {
  const map = {}
  nodes.forEach((n) => {
    const found = new Set()
    // 扫描节点 data 中除 label/description 外的字段（label/description 可能含示例文本）
    const data = n.data || {}
    Object.entries(data).forEach(([k, v]) => {
      if (k === 'label') return
      scanValue(v, found)
    })
    if (found.size === 0) return
    const label = data.label || data.name || NODE_TYPE_LABELS[n.type] || n.type
    found.forEach((varName) => {
      if (!map[varName]) map[varName] = []
      if (!map[varName].includes(label)) map[varName].push(label)
    })
  })
  return map
}

// ============ 折叠区块 ============
function CollapsibleSection({ title, icon: Icon, defaultOpen = true, count, children, hint }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-foreground transition hover:bg-accent"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count != null && (
          <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{count}</span>
        )}
      </button>
      {open && <div className="border-t border-border p-3">{children}</div>}
    </div>
  )
}

// ============ 全局变量区块 ============
function GlobalVarsSection() {
  const variables = useWorkflowStore((s) => s.variables)
  const addVariable = useWorkflowStore((s) => s.addVariable)
  const updateVariable = useWorkflowStore((s) => s.updateVariable)
  const removeVariable = useWorkflowStore((s) => s.removeVariable)
  const [copied, setCopied] = useState('')

  const copyVar = async (path) => {
    const ref = `\${${path}}`
    try {
      await navigator.clipboard.writeText(ref)
      setCopied(path)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      window.prompt('复制变量引用：', ref)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          工作流级自定义变量，节点参数中用{' '}
          <code className="rounded bg-secondary px-1 text-primary">{'${variables.名称}'}</code>{' '}
          引用
        </p>
        <button
          type="button"
          onClick={() => addVariable()}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          + 新增
        </button>
      </div>

      {variables.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          暂无自定义变量
          <br />
          点击右上角「新增」创建
        </div>
      ) : (
        variables.map((v, i) => (
          <div key={i} className="rounded-md border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <input
                className={`${inputCls} min-w-0 flex-1 font-mono text-xs`}
                placeholder="变量名（如 alert_threshold）"
                value={v.name}
                onChange={(e) => updateVariable(i, { name: e.target.value })}
              />
              {v.name && (
                <button
                  type="button"
                  onClick={() => copyVar(`variables.${v.name}`)}
                  title="复制引用语法"
                  className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-primary hover:bg-secondary"
                >
                  {copied === `variables.${v.name}` ? <><Check className="h-3 w-3" /> 已复制</> : <Copy className="h-3 w-3" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeVariable(i)}
                title="删除变量"
                className="flex shrink-0 items-center rounded border border-danger-700/60 px-2 py-1 text-destructive hover:bg-danger-900/40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <input
              className={`${inputCls} mt-1.5 text-xs`}
              placeholder="描述（可选）"
              value={v.description}
              onChange={(e) => updateVariable(i, { description: e.target.value })}
            />
            <input
              className={`${inputCls} mt-1.5 text-xs`}
              placeholder="默认值（留空为 null）"
              value={v.default_value ?? ''}
              onChange={(e) => updateVariable(i, { default_value: e.target.value })}
            />
          </div>
        ))
      )}

      {/* 内置上下文变量（只读） */}
      <div className="mt-1 rounded-md border border-border bg-card p-2.5">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          内置上下文变量
        </h4>
        <div className="flex flex-col gap-1.5">
          {BUILTIN_VARS.map((bv) => (
            <div
              key={bv.path}
              className="flex items-center justify-between rounded border border-border bg-card px-2 py-1"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-primary">
                  {'${'}{bv.path}{'}'}
                </div>
                <div className="truncate text-xs text-muted-foreground">{bv.desc}</div>
              </div>
              <button
                type="button"
                onClick={() => copyVar(bv.path)}
                className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {copied === bv.path ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 rounded bg-secondary p-1.5 text-xs text-muted-foreground">
          引用上游节点输出：用{' '}
          <code className="rounded bg-background px-1 text-primary">{'${node_id.field}'}</code>
        </div>
      </div>
    </div>
  )
}

// ============ 环境变量区块（后端加密存储） ============
function EnvVarsSection() {
  const workflowId = useWorkflowStore((s) => s.workflowId)
  const [envVars, setEnvVars] = useState([])
  const [revealed, setRevealed] = useState({}) // 控制每个变量明文显示（已 reveal 的明文缓存）
  const [copied, setCopied] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  // 记录每项是否被用户修改过明文（决定保存时是否需要重新加密）
  // 当后端返回的 value === '******' 时表示"已有值但前端不可见"，用户未改动则保留原值
  const lastLoadedRef = useRef([])

  // 加载环境变量（workflowId 变化时）
  const load = async () => {
    if (!workflowId) {
      setEnvVars([])
      setRevealed({})
      setDirty(false)
      lastLoadedRef.current = []
      return
    }
    setLoading(true)
    try {
      const res = await workflows.getEnvVars(workflowId)
      const items = Array.isArray(res?.items) ? res.items : []
      setEnvVars(items.map((it) => ({
        name: it.name || '',
        description: it.description || '',
        // 列表接口返回掩码（******）或空字符串
        value: it.value || '',
        hasValue: !!it.has_value,
      })))
      setRevealed({})
      setDirty(false)
      lastLoadedRef.current = items
    } catch (err) {
      toast.error(`加载环境变量失败：${err.message || err}`)
      setEnvVars([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [workflowId])

  const addEnv = () => {
    setEnvVars((prev) => [...prev, { name: '', description: '', value: '', hasValue: false }])
    setDirty(true)
  }
  const updateEnv = (idx, patch) => {
    setEnvVars((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)))
    setDirty(true)
  }
  const removeEnv = (idx) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== idx))
    setDirty(true)
  }

  // 查看单个变量明文（调用后端 reveal 接口）
  const revealEnv = async (idx) => {
    const v = envVars[idx]
    if (!v || !v.name) return
    if (revealed[idx]) {
      // 已展开：切换为隐藏
      setRevealed((r) => {
        const next = { ...r }
        delete next[idx]
        return next
      })
      // 还原为掩码显示（避免误传明文被保存）
      const loaded = lastLoadedRef.current.find((x) => x.name === v.name)
      updateEnv(idx, { value: loaded?.value || (v.hasValue ? '******' : '') })
      return
    }
    try {
      const res = await workflows.revealEnvVar(workflowId, v.name)
      setRevealed((r) => ({ ...r, [idx]: true }))
      updateEnv(idx, { value: res?.value || '' })
    } catch (err) {
      toast.error(`查看明文失败：${err.message || err}`)
    }
  }

  // 保存（调用后端 PUT，自动加密存储）
  const save = async () => {
    if (!workflowId) {
      toast.warning('请先保存工作流后再编辑环境变量')
      return
    }
    // 校验：变量名不能为空、不能重复
    const names = envVars.map((v) => v.name).filter(Boolean)
    const dedup = new Set(names)
    if (names.length !== dedup.size) {
      toast.error('存在重复的变量名，请检查')
      return
    }
    setSaving(true)
    try {
      // 构造请求体：未修改的项保留 '******'（让后端保留原值），修改过的项传新明文
      const items = envVars.map((v, idx) => {
        const loaded = lastLoadedRef.current.find((x) => x.name === v.name)
        const wasMasked = loaded && loaded.has_value && loaded.value === '******'
        const isRevealed = !!revealed[idx]
        // 用户未改动（仍是掩码且未 reveal 明文）：传 '******' 触发后端保留原值
        // 用户已改动或已 reveal：传明文触发后端重新加密
        let value
        if (wasMasked && !isRevealed && v.value === '******') {
          value = '******'
        } else {
          value = v.value || ''
        }
        return { name: v.name, description: v.description, value }
      })
      const res = await workflows.setEnvVars(workflowId, items)
      const newItems = Array.isArray(res?.items) ? res.items : []
      setEnvVars(newItems.map((it) => ({
        name: it.name || '',
        description: it.description || '',
        value: it.value || '',
        hasValue: !!it.has_value,
      })))
      setRevealed({})
      setDirty(false)
      lastLoadedRef.current = newItems
      toast.success('环境变量已保存')
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const copyVar = async (name) => {
    const ref = `\${env.${name}}`
    try {
      await navigator.clipboard.writeText(ref)
      setCopied(name)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      window.prompt('复制环境变量引用：', ref)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 敏感信息说明 */}
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="font-medium">敏感信息加密存储，运行时自动解密注入</div>
          <div className="mt-0.5 text-warning/80">
            环境变量值在后端加密存储（按工作流隔离），用于保存 API Key、Token 等敏感凭证。节点中用{' '}
            <code className="rounded bg-background px-1">{'${env.名称}'}</code> 引用。
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          共 {envVars.length} 个环境变量
          {dirty && <span className="ml-1 text-warning">· 未保存</span>}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading || saving || !workflowId}
            title="重新加载"
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={addEnv}
            disabled={!workflowId}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            + 新增
          </button>
        </div>
      </div>

      {!workflowId ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          请先保存工作流后再编辑环境变量
        </div>
      ) : envVars.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          暂无环境变量
          <br />
          点击右上角「新增」创建
        </div>
      ) : (
        envVars.map((v, i) => (
          <div key={i} className="rounded-md border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <Key className="h-3.5 w-3.5 shrink-0 text-warning" />
              <input
                className={`${inputCls} min-w-0 flex-1 font-mono text-xs`}
                placeholder="变量名（如 api_key）"
                value={v.name}
                onChange={(e) => updateEnv(i, { name: e.target.value })}
              />
              {v.name && (
                <button
                  type="button"
                  onClick={() => copyVar(v.name)}
                  title="复制引用语法"
                  className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-primary hover:bg-secondary"
                >
                  {copied === v.name ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeEnv(i)}
                title="删除变量"
                className="flex shrink-0 items-center rounded border border-danger-700/60 px-2 py-1 text-destructive hover:bg-danger-900/40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <input
              className={`${inputCls} mt-1.5 text-xs`}
              placeholder="描述（可选）"
              value={v.description}
              onChange={(e) => updateEnv(i, { description: e.target.value })}
            />
            <div className="relative mt-1.5">
              <input
                className={`${inputCls} pr-8 font-mono text-xs`}
                type={revealed[i] ? 'text' : 'password'}
                placeholder={v.hasValue ? '已设置（点击眼睛查看明文）' : '敏感值（加密存储）'}
                value={v.value ?? ''}
                onChange={(e) => updateEnv(i, { value: e.target.value })}
              />
              <button
                type="button"
                onClick={() => revealEnv(i)}
                disabled={!v.hasValue && !v.value}
                title={revealed[i] ? '隐藏明文（恢复掩码）' : '查看明文'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                {revealed[i] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        ))
      )}

      {/* 保存按钮（仅在有改动时显示） */}
      {dirty && workflowId && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={load}
            disabled={saving}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3 w-3" />
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}
    </div>
  )
}

// ============ 工作流局部变量区块（从节点提取，只读） ============
function LocalVarsSection() {
  const nodes = useWorkflowStore((s) => s.nodes)
  const localVars = useMemo(() => extractLocalVars(nodes), [nodes])

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-md bg-secondary p-2.5 text-xs text-muted-foreground">
        局部变量由节点在运行时产生（如变量赋值、代码执行输出、AI 智能体输出），此处只读展示。
        下游节点可用{' '}
        <code className="rounded bg-background px-1 text-primary">{'${node_id.字段}'}</code>{' '}
        引用。
      </div>

      {localVars.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          暂无局部变量
          <br />
          添加「变量赋值」「代码执行」等节点后将自动提取
        </div>
      ) : (
        localVars.map((lv, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-card px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-primary">{lv.name}</span>
              <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                {lv.sourceType}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              来源节点：{lv.source}
            </div>
            {lv.desc && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{lv.desc}</div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

// ============ 变量引用关系图 ============
function VarReferenceGraph() {
  const nodes = useWorkflowStore((s) => s.nodes)
  const variables = useWorkflowStore((s) => s.variables)
  const refMap = useMemo(() => buildVarReferenceMap(nodes), [nodes])

  // 合并全局变量名与被引用的变量名
  const allNames = useMemo(() => {
    const set = new Set(variables.map((v) => v.name).filter(Boolean))
    Object.keys(refMap).forEach((n) => set.add(n))
    return Array.from(set).sort()
  }, [variables, refMap])

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        扫描节点参数中的{' '}
        <code className="rounded bg-secondary px-1 text-primary">{'{{var}}'}</code>{' '}
        /{' '}
        <code className="rounded bg-secondary px-1 text-primary">{'${var}'}</code>{' '}
        引用，展示变量与节点的引用关系。
      </p>
      {allNames.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          暂无变量引用
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {allNames.map((name) => {
            const refs = refMap[name] || []
            const isGlobal = variables.some((v) => v.name === name)
            return (
              <div
                key={name}
                className="rounded-md border border-border bg-card px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <Variable className="h-3 w-3 shrink-0 text-primary" />
                  <span className="font-mono text-xs text-foreground">{name}</span>
                  {isGlobal && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">全局</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {refs.length} 个节点引用
                  </span>
                </div>
                {refs.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {refs.map((label, i) => (
                      <span
                        key={i}
                        className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">未被任何节点引用</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============ 输入输出映射（数据流视图） ============
function DataFlowView() {
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const [showFlow, setShowFlow] = useState(false)

  // 计算每个节点的上游节点列表
  const upstreamMap = useMemo(() => {
    const m = {}
    edges.forEach((e) => {
      if (!m[e.target]) m[e.target] = []
      if (!m[e.target].includes(e.source)) m[e.target].push(e.source)
    })
    return m
  }, [edges])

  // 节点卡片数据：{ node, inputs, outputs }
  const cards = useMemo(() => {
    return nodes.map((n) => {
      const label = n.data?.label || n.data?.name || NODE_TYPE_LABELS[n.type] || n.type
      const upstreamIds = upstreamMap[n.id] || []
      const upstreams = upstreamIds
        .map((id) => nodes.find((x) => x.id === id))
        .filter(Boolean)
      // 输入来源：上游节点的输出字段
      const inputs = upstreams.flatMap((u) => {
        const uLabel = u.data?.label || u.data?.name || NODE_TYPE_LABELS[u.type] || u.type
        const fields = NODE_OUTPUT_FIELDS[u.type] || [{ field: 'output', label: 'output' }]
        return fields.map((f) => ({ from: uLabel, field: f.label, ref: `\${${u.id}.${f.field}}` }))
      })
      // 输出字段：自身 output_variables 或类型默认输出
      let outputs = []
      if (Array.isArray(n.data?.output_variables) && n.data.output_variables.length > 0) {
        outputs = n.data.output_variables.map((v) => v.name).filter(Boolean)
      } else if (n.type === 'variable_assign' && Array.isArray(n.data?.assignments)) {
        outputs = n.data.assignments.map((a) => a.name).filter(Boolean)
      } else {
        outputs = (NODE_OUTPUT_FIELDS[n.type] || [{ field: 'output' }]).map((f) => f.field)
      }
      return { node: n, label, type: n.type, inputs, outputs }
    })
  }, [nodes, upstreamMap])

  // 数据流连线（文字箭头）：上游.output -> 下游.input
  const flowLines = useMemo(() => {
    const lines = []
    cards.forEach((card) => {
      card.inputs.forEach((inp) => {
        lines.push({
          from: `${inp.from}.output`,
          field: inp.field,
          to: `${card.label}.input`,
          ref: inp.ref,
        })
      })
    })
    return lines
  }, [cards])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          展示每个节点的输入来源与输出去向。
        </p>
        <button
          type="button"
          onClick={() => setShowFlow((s) => !s)}
          className={`shrink-0 rounded border px-2 py-0.5 text-xs transition ${
            showFlow
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {showFlow ? '卡片视图' : '数据流视图'}
        </button>
      </div>

      {showFlow ? (
        // 数据流连线视图
        flowLines.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            暂无数据流连线（节点间未连接或无输入字段）
          </div>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-xs">
            {flowLines.map((l, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1"
              >
                <span className="shrink-0 text-primary">{l.from}</span>
                <span className="shrink-0 text-muted-foreground">.{l.field}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-foreground">{l.to}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        // 节点卡片视图
        cards.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            画布上没有节点
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map((c) => (
              <div
                key={c.node.id}
                className="rounded-md border border-border bg-card p-2"
              >
                <div className="flex items-center gap-1.5">
                  <Boxes className="h-3 w-3 shrink-0 text-primary" />
                  <span className="truncate text-xs font-medium text-foreground">{c.label}</span>
                  <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                    {NODE_TYPE_LABELS[c.type] || c.type}
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {/* 输入 */}
                  <div className="rounded border border-border bg-secondary p-1.5">
                    <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                      <ArrowRight className="h-2.5 w-2.5 rotate-180" /> 输入
                    </div>
                    {c.inputs.length === 0 ? (
                      <div className="text-xs text-muted-foreground">无（起始节点）</div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {c.inputs.map((inp, i) => (
                          <div key={i} className="truncate font-mono text-xs text-foreground">
                            <span className="text-primary">{inp.from}</span>
                            <span className="text-muted-foreground">.{inp.field}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 输出 */}
                  <div className="rounded border border-border bg-secondary p-1.5">
                    <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                      <ArrowRight className="h-2.5 w-2.5" /> 输出
                    </div>
                    {c.outputs.length === 0 ? (
                      <div className="text-xs text-muted-foreground">无</div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {c.outputs.map((out, i) => (
                          <span
                            key={i}
                            className="rounded bg-primary/10 px-1 py-0.5 font-mono text-xs text-primary"
                          >
                            {out}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ============ 主面板 ============
function VariablePanel() {
  const [activeTab, setActiveTab] = useState('global')
  const nodes = useWorkflowStore((s) => s.nodes)

  return (
    <div className="flex flex-col gap-3 p-3 text-foreground">
      {/* Tab 切换 */}
      <div>
        <PillTabs
          items={[
            { key: 'global', label: '全局变量', icon: Variable },
            { key: 'env', label: '环境变量', icon: Key },
            { key: 'local', label: '局部变量', icon: Boxes },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Tab 内容 */}
      {activeTab === 'global' && <GlobalVarsSection />}
      {activeTab === 'env' && <EnvVarsSection />}
      {activeTab === 'local' && <LocalVarsSection />}

      {/* 分割线 */}
      <div className="my-1 border-t border-border" />

      {/* 变量引用关系图 */}
      <CollapsibleSection
        title="变量引用关系"
        icon={GitBranch}
        defaultOpen={false}
        count={Object.keys(buildVarReferenceMap(nodes)).length}
      >
        <VarReferenceGraph />
      </CollapsibleSection>

      {/* 输入输出映射 */}
      <CollapsibleSection
        title="输入输出映射"
        icon={ArrowRight}
        defaultOpen={false}
        count={nodes.length}
      >
        <DataFlowView />
      </CollapsibleSection>
    </div>
  )
}

export default VariablePanel
