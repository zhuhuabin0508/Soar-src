import { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ClipboardList,
  Globe,
  Lock,
  SlidersHorizontal,
  Package,
  Code2,
  TestTube,
  Wrench,
  MessageSquare,
  Zap,
  X,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Maximize2,
  Minimize2,
  Wand2,
} from 'lucide-react'
import { tools as toolsApi } from '../api/client'
import {
  Section,
  TextInput,
  TextArea,
  CheckRow,
  SelectInput,
  NumberInput,
  KeyValueEditor,
  inputCls,
  inputBaseCls,
  labelCls,
  hintCls,
} from '../components/property/FormControls'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { CompactSelect } from '../components/ui'
import { toast } from '../store/toastStore'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { canEditResource } from '../utils/permissions'

// 默认 HTTP 工具配置
const DEFAULT_HTTP_CONFIG = {
  method: 'GET',
  url: '',
  headers: [{ key: 'Content-Type', value: 'application/json' }],
  body_type: 'json', // json | form | xml | none
  body_content: '',
  auth_type: 'none', // none | bearer | api_key | oauth2
  auth_config: {},
  timeout: 10,
  retry: 0,
  response_jsonpath: '',
  error_handling: '',
}

// Python 代码模板库
const CODE_TEMPLATES = [
  {
    label: '查询类',
    desc: '查询并返回结果',
    code: `async def run(**kwargs):
    """查询类工具模板"""
    query = kwargs.get('query', '')
    # TODO: 实现查询逻辑
    result = {"query": query, "found": True, "data": []}
    return result`,
  },
  {
    label: '封禁类',
    desc: '执行封禁/解封操作',
    code: `async def run(**kwargs):
    """封禁类工具模板（危险操作）"""
    ip = kwargs.get('ip', '')
    action = kwargs.get('action', 'block')
    duration = kwargs.get('duration', 3600)
    # TODO: 调用防火墙 API 执行封禁
    # result = await httpx.post(...)
    return {"ip": ip, "action": action, "duration": duration, "success": True}`,
  },
  {
    label: '文件读取类',
    desc: '读取并解析文件内容',
    code: `async def run(**kwargs):
    """文件读取类工具模板"""
    file_path = kwargs.get('file_path', '')
    # TODO: 读取文件内容
    # with open(file_path, 'r') as f:
    #     content = f.read()
    return {"file": file_path, "lines": 0, "content": ""}`,
  },
  {
    label: 'API 调用类',
    desc: '调用外部 API 获取数据',
    code: `async def run(**kwargs):
    """API 调用类工具模板"""
    import httpx
    url = kwargs.get('url', '')
    params = kwargs.get('params', {})
    resp = await httpx.get(url, params=params, timeout=10)
    return {"status": resp.status_code, "data": resp.json()}`,
  },
]

// 方法颜色映射：GET 绿色，POST/PUT/PATCH 橙色，DELETE 红色
const METHOD_COLORS = {
  GET: 'bg-success/20 text-success border-success/40',
  POST: 'bg-warning/20 text-warning border-warning/40',
  PUT: 'bg-warning/20 text-warning border-warning/40',
  PATCH: 'bg-warning/20 text-warning border-warning/40',
  DELETE: 'bg-destructive/20 text-destructive border-destructive/40',
}

// 可折叠卡片（与 AgentEditor 风格一致）
function Card({ title, icon, children, defaultOpen = true, hint, extra }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex w-full items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left transition hover:text-primary"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span>{icon}</span>
            {title}
            {hint && <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>}
          </span>
          <span className="text-muted-foreground">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
        </button>
        {extra && <div className="shrink-0">{extra}</div>}
      </div>
      {open && <div className="flex flex-col gap-3 border-t border-border p-4">{children}</div>}
    </div>
  )
}

// 参数 Schema 编辑器（扩展版：支持 location / default / enum）
// value: [{ name, type, location, required, description, default, enum }]
function ParamSchemaEditor({ value = [], onChange, showHttpFields = false }) {
  // 防御：framework 工具的 parameters_schema 是 OpenAI 对象格式，非数组
  const safeValue = Array.isArray(value) ? value : []
  const typeOpts = ['String', 'Number', 'Boolean', 'Object', 'Array']
  const locationOpts = [
    { value: 'query', label: 'Query URL' },
    { value: 'body', label: 'Body JSON' },
    { value: 'header', label: 'Header' },
    { value: 'path', label: 'Path 路径' },
  ]
  const update = (idx, patch) => {
    const next = safeValue.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  const add = () =>
    onChange([
      ...safeValue,
      { name: '', type: 'String', location: showHttpFields ? 'query' : 'body', required: false, description: '', default: '', enum: '' },
    ])
  const remove = (idx) => onChange(safeValue.filter((_, i) => i !== idx))

  return (
    <div>
      <div className="flex flex-col gap-2">
        {safeValue.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无参数</p>
        )}
        {safeValue.map((item, idx) => (
          <div key={idx} className="rounded-md border border-border bg-card p-2.5">
            {/* 第一行：参数名 + 类型 + 删除 */}
            <div className="flex items-center gap-1.5">
              <input
                className={`${inputBaseCls} min-w-0 flex-1`}
                placeholder="参数名（与外部 API 字段名一致）"
                value={item.name}
                onChange={(e) => update(idx, { name: e.target.value })}
              />
              <CompactSelect
                size="md"
                className="w-28 shrink-0"
                value={item.type}
                onChange={(e) => update(idx, { type: e.target.value })}
              >
                {typeOpts.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </CompactSelect>
              {showHttpFields && (
                <CompactSelect
                  size="md"
                  className="w-32 shrink-0"
                  value={item.location || 'query'}
                  onChange={(e) => update(idx, { location: e.target.value })}
                  title="参数位置"
                >
                  {locationOpts.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </CompactSelect>
              )}
              <label className="flex shrink-0 cursor-pointer items-center gap-1 px-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border bg-secondary text-primary focus:ring-primary"
                  checked={!!item.required}
                  onChange={(e) => update(idx, { required: e.target.checked })}
                />
                必填
              </label>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="flex shrink-0 items-center rounded-md border border-border px-2 text-muted-foreground hover:border-destructive hover:text-destructive"
                title="删除"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {/* 第二行：描述（极重要） */}
            <input
              className={`${inputCls} mt-1.5`}
              placeholder="参数描述（告诉 LLM 如何从用户输入提取此参数）"
              value={item.description || ''}
              onChange={(e) => update(idx, { description: e.target.value })}
            />
            {/* 第三行：默认值 / 枚举（仅 HTTP 工具） */}
            {showHttpFields && (
              <div className="mt-1.5 flex gap-1.5">
                <input
                  className={`${inputBaseCls} min-w-0 flex-1`}
                  placeholder="默认值或动态变量 {{sys.user_id}}"
                  value={item.default || ''}
                  onChange={(e) => update(idx, { default: e.target.value })}
                />
                <input
                  className={`${inputBaseCls} min-w-0 flex-1`}
                  placeholder="枚举值（逗号分隔，如 sunny,rainy,cloudy）"
                  value={Array.isArray(item.enum) ? item.enum.join(',') : (item.enum || '')}
                  onChange={(e) =>
                    update(idx, {
                      enum: e.target.value
                        ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                        : '',
                    })
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        + 添加参数
      </button>
    </div>
  )
}

// 简易 Python 代码编辑器：等宽 textarea + 行号
function CodeEditor({ value, onChange }) {
  const lines = (value || '').split('\n')
  const lineCount = Math.max(lines.length, 1)
  return (
    <div className="flex w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="shrink-0 select-none bg-background px-2 py-2 text-right font-mono text-[12px] leading-6 text-muted-foreground">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        className="flex-1 resize-y bg-card px-3 py-2 font-mono text-[12px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
        rows={Math.max(lineCount, 12)}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'async def run(**kwargs):\n    # 在此实现工具逻辑，返回结果\n    return {"ok": True}'}
      />
    </div>
  )
}

// OpenAPI 导入弹窗
function OpenAPIImportModal({ open, onClose, onPick }) {
  const [tab, setTab] = useState('json') // json | url
  const [specText, setSpecText] = useState('')
  const [url, setUrl] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [ops, setOps] = useState(null) // {title, version, operations}
  const [err, setErr] = useState('')

  const handleParse = async () => {
    setParsing(true)
    setErr('')
    setOps(null)
    try {
      const result = await toolsApi.importOpenapi(
        tab === 'json' ? { spec: specText } : { url }
      )
      setOps(result)
    } catch (e) {
      setErr(e.message || '解析失败')
    } finally {
      setParsing(false)
    }
  }

  const handlePick = async (op) => {
    setParsing(true)
    setErr('')
    try {
      const built = await toolsApi.buildFromOperation({ operation: op, base_url: baseUrl })
      onPick(built)
      // 重置
      setOps(null)
      setSpecText('')
      setUrl('')
      setBaseUrl('')
      onClose()
    } catch (e) {
      setErr(e.message || '构造工具配置失败')
    } finally {
      setParsing(false)
    }
  }

  const close = () => {
    setOps(null)
    setSpecText('')
    setUrl('')
    setBaseUrl('')
    setErr('')
    onClose()
  }

  return (
    <Modal
      open={open}
      title="OpenAPI / Swagger 快捷导入"
      onClose={close}
      maxWidth="max-w-3xl"
      footer={
        <button type="button" onClick={close} className="btn-secondary">关闭</button>
      }
    >
      {!ops && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTab('json')}
              className={`rounded px-3 py-1 text-xs ${tab === 'json' ? 'bg-primary text-foreground' : 'bg-secondary text-muted-foreground'}`}
            >
              粘贴 JSON
            </button>
            <button
              type="button"
              onClick={() => setTab('url')}
              className={`rounded px-3 py-1 text-xs ${tab === 'url' ? 'bg-primary text-foreground' : 'bg-secondary text-muted-foreground'}`}
            >
              从 URL 拉取
            </button>
          </div>
          {tab === 'json' ? (
            <textarea
              className={`${inputCls} resize-y font-mono`}
              rows={10}
              placeholder={'粘贴 OpenAPI 3.0 / Swagger JSON\n例如：\n{"openapi":"3.0.0","info":{"title":"..."},"paths":{...}}'}
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              spellCheck={false}
            />
          ) : (
            <input
              className={inputCls}
              placeholder="https://example.com/openapi.json"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
          <TextInput
            label="Base URL（可选，拼接在 path 前）"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://api.example.com"
          />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <button
            type="button"
            onClick={handleParse}
            disabled={parsing}
            className="btn-primary btn-sm self-start"
          >
            {parsing ? '解析中…' : '解析 OpenAPI'}
          </button>
        </div>
      )}

      {ops && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">
            <span className="font-medium">{ops.title || 'OpenAPI'}</span>
            {ops.version && <span className="ml-2 text-xs text-muted-foreground">v{ops.version}</span>}
            <span className="ml-2 text-xs text-muted-foreground">共 {ops.operations.length} 个操作</span>
          </div>
          <div className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
            {ops.operations.map((op, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handlePick(op)}
                disabled={parsing}
                className="flex items-center gap-3 rounded-md border border-border bg-card p-3 text-left transition hover:border-primary hover:bg-card disabled:opacity-50"
              >
                <span className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[11px] font-semibold ${METHOD_COLORS[op.method] || 'bg-secondary text-muted-foreground'}`}>
                  {op.method}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-muted-foreground">{op.path}</div>
                  <div className="truncate text-xs text-muted-foreground">{op.summary}</div>
                </div>
                <span className="shrink-0 text-xs text-primary">导入 →</span>
              </button>
            ))}
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      )}
    </Modal>
  )
}

// 调试面板：模拟入参测试 + 模拟对话调试
// 通过 forwardRef + useImperativeHandle 暴露 triggerTest()，
// 供「保存并测试」按钮在外部保存后直接触发面板内的入参测试
const DebugPanel = forwardRef(function DebugPanel({ toolId, parametersSchema, toolType, httpConfig }, ref) {
  const [tab, setTab] = useState('params') // params | chat
  // 入参测试
  const [testParams, setTestParams] = useState({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testErr, setTestErr] = useState('')
  // 对话调试
  const [chatInput, setChatInput] = useState('')
  const [chatting, setChatting] = useState(false)
  const [chatResult, setChatResult] = useState(null)
  const [chatErr, setChatErr] = useState('')

  // 当参数 schema 变化时重置测试入参
  useEffect(() => {
    const init = {}
    ;(parametersSchema || []).forEach((p) => {
      init[p.name] = p.default !== undefined && p.default !== '' ? p.default : ''
    })
    setTestParams(init)
  }, [JSON.stringify(parametersSchema)])

  const handleParamTest = async () => {
    if (!toolId) {
      toast.warning('请先保存工具后再测试')
      return
    }
    setTesting(true)
    setTestErr('')
    setTestResult(null)
    try {
      const parsed = {}
      ;(parametersSchema || []).forEach((p) => {
        const raw = testParams[p.name]
        if (raw === '' || raw === undefined || raw === null) return
        switch ((p.type || 'String').toLowerCase()) {
          case 'number': {
            const n = Number(raw)
            parsed[p.name] = isNaN(n) ? raw : n
            break
          }
          case 'boolean':
            parsed[p.name] = raw === true || raw === 'true'
            break
          case 'object':
          case 'array':
            try { parsed[p.name] = JSON.parse(raw) } catch { parsed[p.name] = raw }
            break
          default:
            parsed[p.name] = raw
        }
      })
      const res = await toolsApi.test(toolId, parsed)
      setTestResult(res)
    } catch (err) {
      setTestErr(err.message || String(err))
    } finally {
      setTesting(false)
    }
  }

  // 暴露给父组件：外部「保存并测试」调用 triggerTest() 即可触发入参测试
  // 不固定依赖：每次 render 重新创建 handle，确保 triggerTest 调用最新闭包（含最新 testParams/toolId 等 state）
  useImperativeHandle(ref, () => ({
    triggerTest: () => handleParamTest(),
  }))

  const handleChat = async () => {
    if (!toolId) {
      toast.warning('请先保存工具后再调试')
      return
    }
    if (!chatInput.trim()) return
    setChatting(true)
    setChatErr('')
    setChatResult(null)
    try {
      const res = await toolsApi.debugChat(toolId, chatInput)
      setChatResult(res)
    } catch (err) {
      setChatErr(err.message || String(err))
    } finally {
      setChatting(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Tab 切换 */}
      <div className="flex border-b border-border">
        {[
          { v: 'params', label: <span className="flex items-center gap-1.5"><Wrench className="h-4 w-4" />模拟入参测试</span> },
          { v: 'chat', label: <span className="flex items-center gap-1.5"><MessageSquare className="h-4 w-4" />模拟对话调试</span> },
        ].map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => setTab(t.v)}
            className={`px-4 py-2 text-sm font-medium transition ${
              tab === t.v ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {/* 入参测试 */}
        {tab === 'params' && (
          <div className="flex flex-col gap-3">
            {toolType === 'http' && httpConfig && (
              <div className="rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
                将向 <span className="font-mono text-muted-foreground">{httpConfig.method} {httpConfig.url}</span> 发起真实请求
              </div>
            )}
            {(parametersSchema || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">该工具没有参数，可直接点击「发送请求」。</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {parametersSchema.map((p) => (
                  <div key={p.name}>
                    <label className={labelCls}>
                      {p.name}
                      <span className="ml-1 text-[10px] text-muted-foreground">({p.type}{p.location ? ` · ${p.location}` : ''})</span>
                      {p.required && <span className="ml-1 text-destructive">*</span>}
                    </label>
                    {p.type === 'Boolean' ? (
                      <CompactSelect
                        size="lg"
                        block
                        value={testParams[p.name] === true ? 'true' : 'false'}
                        onChange={(e) => setTestParams((prev) => ({ ...prev, [p.name]: e.target.value === 'true' }))}
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </CompactSelect>
                    ) : p.type === 'Object' || p.type === 'Array' ? (
                      <textarea
                        className={`${inputCls} resize-y font-mono`}
                        rows={2}
                        value={testParams[p.name] ?? ''}
                        onChange={(e) => setTestParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        placeholder={p.type === 'Array' ? '["a","b"]' : '{"key":"value"}'}
                      />
                    ) : (
                      <input
                        className={inputCls}
                        value={testParams[p.name] ?? ''}
                        onChange={(e) => setTestParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        placeholder={p.description || ''}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={handleParamTest}
              disabled={testing}
              className="btn-primary btn-sm self-start"
            >
              {testing ? '请求中…' : '发送请求'}
            </button>

            {testErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {testErr}
              </div>
            )}
            {testResult && (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">返回结果</div>
                  <pre className="max-h-72 w-full overflow-auto rounded-md bg-background p-3 font-mono text-xs text-foreground ring-1 ring-border">
                    {testResult.result == null
                      ? '(空)'
                      : typeof testResult.result === 'string'
                      ? testResult.result
                      : JSON.stringify(testResult.result, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">日志（{(testResult.logs || []).length} 条）</div>
                  <div className="max-h-48 w-full overflow-auto rounded-md bg-background p-3 ring-1 ring-border">
                    {(testResult.logs || []).length === 0 ? (
                      <div className="text-xs text-muted-foreground">暂无日志</div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {testResult.logs.map((log, i) => (
                          <div key={i} className="font-mono text-xs">
                            <span className="mr-2 text-muted-foreground">[{(log.level || 'info').toUpperCase()}]</span>
                            <span className="text-muted-foreground">{log.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 对话调试 */}
        {tab === 'chat' && (
          <div className="flex flex-col gap-3">
            <p className={hintCls}>
              输入自然语言，系统将展示 LLM 思考 → 提取参数 → 调用工具 → 最终回答的完整链路。
            </p>
            <div className="flex gap-2">
              <input
                className={inputCls}
                placeholder="如：今天北京天气怎么样"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !chatting) handleChat() }}
              />
              <button
                type="button"
                onClick={handleChat}
                disabled={chatting || !chatInput.trim()}
                className="btn-primary btn-sm shrink-0"
              >
                {chatting ? '调试中…' : '发送'}
              </button>
            </div>

            {chatErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {chatErr}
              </div>
            )}
            {chatResult && (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">最终回答</div>
                  <div className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
                    {chatResult.response || '(空)'}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">运行链路（{(chatResult.messages || []).length} 条消息）</div>
                  <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-md bg-background p-3 ring-1 ring-border">
                    {(chatResult.messages || []).map((m, i) => {
                      const role = m.role || '?'
                      const roleColor = {
                        user: 'text-primary',
                        human: 'text-primary',
                        assistant: 'text-success',
                        ai: 'text-success',
                        tool: 'text-warning',
                        system: 'text-muted-foreground',
                      }[role] || 'text-muted-foreground'
                      return (
                        <div key={i} className="font-mono text-xs">
                          <span className={`mr-2 font-semibold ${roleColor}`}>[{role}]</span>
                          <span className="whitespace-pre-wrap break-all text-muted-foreground">{m.content}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

// 工具编辑器：6 维度配置
function ToolEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isEdit = !!id

  const [form, setForm] = useState({
    name: '',
    description: '',
    enabled: true,
    parameters_schema: [],
    code: 'async def run(**kwargs):\n    return {"ok": True}\n',
    tool_type: 'http', // 默认 HTTP（主流推荐）
    http_config: { ...DEFAULT_HTTP_CONFIG },
    category: null, // 工具集分类
    tags: [], // 自定义标签
  })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  // 资源级 owner 控制：已加载详情的 can_edit / created_by（新建时默认可编辑）
  const [toolMeta, setToolMeta] = useState({ can_edit: true, created_by: null })

  // OpenAPI 导入弹窗
  const [importOpen, setImportOpen] = useState(false)
  // AI 优化描述
  const [optimizing, setOptimizing] = useState(false)
  // 代码全屏编辑
  const [codeFullscreen, setCodeFullscreen] = useState(false)

  const bypassGuard = useUnsavedChanges(dirty)

  useEffect(() => {
    // 优先从 sessionStorage 读取模板
    const tplStr = sessionStorage.getItem('soar:tool:template')
    if (tplStr && !isEdit) {
      try {
        const tpl = JSON.parse(tplStr)
        setForm({
          name: tpl.name || '',
          description: tpl.description || '',
          enabled: true,
          parameters_schema: tpl.parameters_schema || [],
          code: tpl.code || '',
          tool_type: tpl.tool_type || 'code',
          http_config: tpl.http_config || { ...DEFAULT_HTTP_CONFIG },
        })
      } catch { /* ignore */ }
      sessionStorage.removeItem('soar:tool:template')
    }

    let alive = true
    if (!isEdit) {
      return () => { alive = false }
    }
    ;(async () => {
      setLoading(true)
      try {
        const all = await toolsApi.list()
        if (!alive) return
        const tool = (Array.isArray(all) ? all : []).find((t) => String(t.id) === String(id))
        if (tool) {
          setForm({
            name: tool.name || '',
            description: tool.description || '',
            enabled: tool.enabled !== false,
            parameters_schema: tool.parameters_schema || [],
            code: tool.code || '',
            tool_type: tool.tool_type || 'code',
            http_config: tool.http_config || { ...DEFAULT_HTTP_CONFIG },
            category: tool.category || null,
            tags: tool.tags || [],
          })
          // 记录资源级权限标志（用于禁用保存按钮）
          setToolMeta({
            can_edit: typeof tool.can_edit === 'boolean' ? tool.can_edit : true,
            created_by: tool.created_by ?? null,
          })
        } else {
          setError('未找到该工具')
        }
      } catch (err) {
        if (!alive) return
        setError(err.message || '加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [id, isEdit])

  const setField = (field) => (value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
  }
  const setHttpField = (field) => (value) => {
    setForm((prev) => ({ ...prev, http_config: { ...(prev.http_config || {}), [field]: value } }))
    setDirty(true)
  }

  const handleSave = async (silent = false) => {
    if (!form.name.trim()) {
      if (!silent) toast.warning('请填写工具名称')
      return null
    }
    setSaving(true)
    try {
      const body = {
        name: form.name,
        description: form.description,
        enabled: form.enabled,
        parameters_schema: form.parameters_schema,
        code: form.code,
        tool_type: form.tool_type,
        http_config: form.tool_type === 'http' ? form.http_config : null,
        category: form.category === '_custom' ? null : form.category,
        tags: form.tags,
      }
      let result
      if (isEdit) {
        result = await toolsApi.update(id, body)
      } else {
        result = await toolsApi.create(body)
      }
      setDirty(false)
      bypassGuard()
      if (!silent) navigate('/tools')
      return result
    } catch (err) {
      if (!silent) toast.error(`保存失败：${err.message || err}`)
      return null
    } finally {
      setSaving(false)
    }
  }

  // OpenAPI 导入：把构造好的配置填入表单
  const handlePickOperation = (built) => {
    setForm((prev) => ({
      ...prev,
      name: built.name || prev.name,
      description: built.description || prev.description,
      tool_type: 'http',
      http_config: built.http_config || prev.http_config,
      parameters_schema: built.parameters_schema || prev.parameters_schema,
    }))
    setDirty(true)
  }

  // AI 优化工具描述
  const handleOptimizeDesc = async () => {
    setOptimizing(true)
    try {
      const res = await toolsApi.optimizeDescription({
        name: form.name,
        description: form.description,
        parameters: form.parameters_schema,
      })
      setField('description')(res.description)
    } catch (err) {
      toast.error(`优化失败：${err.message || err}`)
    } finally {
      setOptimizing(false)
    }
  }

  // 保存并测试：保存后自动滚动到调试区并触发 DebugPanel.triggerTest
  const debugTriggerRef = useRef(null) // 绑定外层 <div>：仅用于 scrollIntoView
  const debugPanelRef = useRef(null)  // 绑定 <DebugPanel>：调用 triggerTest()
  const handleSaveAndTest = async () => {
    // 预校验名称：silent 保存会吞掉 toast，这里先提示，避免「点了没反应」
    if (!form.name.trim()) {
      toast.warning('请填写工具名称')
      return
    }
    const result = await handleSave(true)
    if (!result) {
      // silent 模式下保存失败不弹 toast，这里补反馈，避免用户以为按钮失灵
      toast.error('保存失败，请检查表单输入或稍后重试')
      return
    }
    toast.success('保存成功，正在准备测试…')
    // 滚动到调试区 + 触发测试（等 DOM 完成可能的 tab 渲染）
    setTimeout(() => {
      if (debugTriggerRef.current) {
        debugTriggerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      const panel = debugPanelRef.current
      if (panel && typeof panel.triggerTest === 'function') {
        panel.triggerTest()
      } else {
        // 兜底：triggerTest 不可用时告知用户手动点测试
        toast.info('已切换到调试面板，请点击「发送请求」开始测试')
      }
    }, 300)
  }

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
        加载中...
      </div>
    )
  }

  const isHttp = form.tool_type === 'http'
  const isFramework = form.tool_type === 'framework'
  // 资源级 owner 控制：新建允许编辑；已存在资源按 can_edit 标志
  const canEdit = !isEdit || canEditResource(toolMeta)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => navigate('/tools')} className="btn-secondary btn-sm">
            ← 返回列表
          </button>
          <h1 className="text-xl font-semibold">{isEdit ? '编辑工具' : '新建工具'}</h1>
          <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium ${
            isFramework
              ? 'border-purple-500/40 bg-primary/10 text-primary'
              : isHttp
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-secondary text-muted-foreground'
          }`}>
            {isFramework ? '框架内置工具' : isHttp ? 'HTTP 接口工具' : 'Python 代码工具'}
          </span>
          {dirty && <span className="text-[10px] text-warning">● 未保存</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleSaveAndTest()}
            disabled={saving || !canEdit}
            title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}
            className="btn-secondary btn-sm"
          >
            {saving ? '保存中…' : '保存并测试'}
          </button>
          <button
            type="button"
            onClick={() => handleSave(false)}
            disabled={saving || !canEdit}
            title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}
            className="btn-primary"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {error && (
          <div className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* 维度一：基础信息与导入方式 */}
        <Card title="基础信息与导入方式" icon={<ClipboardList className="h-4 w-4" />}>
          {/* 工具类型切换：大卡片选择（含场景说明） */}
          <div>
            <label className={labelCls}>创建方式 / 工具类型</label>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => { setField('tool_type')('http'); setHttpField('method')('GET') }}
                className={`flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition ${
                  isHttp ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-primary/40 hover:bg-muted'
                }`}
              >
                <Globe className={`h-6 w-6 ${isHttp ? 'text-primary' : 'text-muted-foreground'}`} />
                <div className="text-sm font-semibold text-foreground">HTTP 接口工具</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  声明式配置，无需写代码。适合调用外部 RESTful API、查询威胁情报等。
                </div>
                <span className="mt-1 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">推荐</span>
              </button>
              <button
                type="button"
                onClick={() => setField('tool_type')('code')}
                className={`flex flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition ${
                  !isHttp && !isFramework ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-primary/40 hover:bg-muted'
                }`}
              >
                <Code2 className={`h-6 w-6 ${!isHttp && !isFramework ? 'text-primary' : 'text-muted-foreground'}`} />
                <div className="text-sm font-semibold text-foreground">Python 代码工具</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  在沙箱中运行 Python 代码，适合复杂逻辑、数据处理、算法实现等。
                </div>
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="flex flex-col items-start gap-1.5 rounded-lg border border-dashed border-primary/50 p-4 text-left transition hover:bg-primary/10"
              >
                <Zap className="h-6 w-6 text-primary" />
                <div className="text-sm font-semibold text-foreground">OpenAPI 导入</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  从 Swagger/OpenAPI 规范批量导入已有接口，快速生成 HTTP 工具。
                </div>
              </button>
            </div>
          </div>

          <TextInput label="工具名称" value={form.name} onChange={setField('name')} placeholder="如：查询订单工具（给开发者看）" />

          {/* 工具描述 + AI 优化按钮 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={labelCls + ' mb-0'}>工具描述（极重要，写给 LLM 看）</label>
              <button
                type="button"
                onClick={handleOptimizeDesc}
                disabled={optimizing}
                className="rounded border border-primary/50 px-2 py-0.5 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-50"
              >
                {optimizing ? '优化中…' : 'AI 优化提示词'}
              </button>
            </div>
            <textarea
              className={`${inputCls} resize-y`}
              rows={3}
              value={form.description}
              onChange={(e) => setField('description')(e.target.value)}
              placeholder={'决定 LLM 在什么情况下会调用此工具。\n示例：当用户询问订单的物流状态、发货情况或查询特定订单号时，调用此工具。'}
            />
            {/* 描述提示模板 */}
            <div className="mt-1.5 flex items-start gap-1 rounded border border-border bg-secondary p-2 text-[11px] text-muted-foreground">
              <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
              <span>推荐模板：<span className="font-mono">[做什么] + [适用场景] + [返回什么]</span>。如：查询 IP 是否命中内网白名单，返回布尔值。适用于判断外部 IP 是否为可信内网地址。</span>
            </div>
          </div>

          {/* 工具集分类：支持下拉选择或自定义输入 */}
          <div>
            <label className={labelCls}>工具集分类</label>
            <div className="flex gap-1.5">
              <CompactSelect
                size="md"
                className="w-40 shrink-0"
                value={form.category || ''}
                onChange={(e) => setField('category')(e.target.value || null)}
              >
                <option value="">不分类</option>
                <option value="file_operations">文件操作</option>
                <option value="security">安全运营</option>
                <option value="cron_jobs">定时任务</option>
                <option value="memory">记忆</option>
                <option value="computer_use">计算机操作</option>
                <option value="clarifying_question">澄清提问</option>
                <option value="task_planning">任务规划</option>
                <option value="task_delegation">任务委派</option>
                <option value="_custom">自定义...</option>
              </CompactSelect>
              <input
                className={`${inputBaseCls} min-w-0 flex-1`}
                placeholder={form.category === '_custom' ? '输入自定义分类名称' : '选择或自定义分类'}
                value={form.category === '_custom' ? '' : (form.category || '')}
                onChange={(e) => setField('category')(e.target.value || null)}
              />
            </div>
          </div>

          {/* 多标签编辑：支持自定义标签 */}
          <div>
            <label className={labelCls}>标签 <span className="text-muted-foreground">(回车添加，多个标签便于检索)</span></label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-secondary p-1.5">
              {(form.tags || []).map((tag, idx) => (
                <span key={idx} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                  {tag}
                  <button
                    type="button"
                    onClick={() => {
                      const next = (form.tags || []).filter((_, i) => i !== idx)
                      setField('tags')(next)
                    }}
                    className="ml-0.5 hover:text-foreground"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <input
                className="min-w-[100px] flex-1 bg-transparent px-1 py-0.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="输入标签后回车"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target.value.trim()) {
                    e.preventDefault()
                    const val = e.target.value.trim()
                    const next = [...(form.tags || []), val]
                    setField('tags')(next)
                    e.target.value = ''
                  }
                }}
              />
            </div>
            {/* 快捷标签建议 */}
            <div className="mt-1 flex flex-wrap gap-1">
              {['安全运营', '网络资产', '文件操作', 'API调用', '危险操作'].map((t) => {
                const has = (form.tags || []).includes(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      if (has) {
                        setField('tags')((form.tags || []).filter((x) => x !== t))
                      } else {
                        setField('tags')([...(form.tags || []), t])
                      }
                    }}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                      has
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
                    }`}
                  >
                    {has ? '✓ ' : '+ '}{t}
                  </button>
                )
              })}
            </div>
          </div>
          <CheckRow label="启用" checked={form.enabled} onChange={setField('enabled')} hint="禁用后，Agent 推理时不会调用此工具。" />
        </Card>

        {/* 维度二：接口定义层（仅 HTTP） */}
        {isHttp && (
          <Card title="接口定义层" icon={<Globe className="h-4 w-4" />}>
            <div className="flex gap-2">
              <div className="w-32 shrink-0">
                <label className={labelCls}>Method</label>
                <CompactSelect
                  size="lg"
                  block
                  value={form.http_config.method}
                  onChange={(e) => setHttpField('method')(e.target.value)}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </CompactSelect>
              </div>
              <div className="min-w-0 flex-1">
                <label className={labelCls}>URL</label>
                <input
                  className={inputCls}
                  value={form.http_config.url}
                  onChange={(e) => setHttpField('url')(e.target.value)}
                  placeholder="https://api.example.com/v1/weather"
                />
              </div>
            </div>
            <p className={hintCls}>URL 中的路径参数用 {'{param}'} 占位，如 https://api.example.com/orders/{`{order_id}`}。</p>

            <KeyValueEditor
              label="请求头（Headers）"
              value={form.http_config.headers}
              onChange={setHttpField('headers')}
              keyPlaceholder="Header 名（如 Content-Type）"
              valuePlaceholder="值（如 application/json）"
            />

            {/* 请求体（仅 POST/PUT/PATCH） */}
            {['POST', 'PUT', 'PATCH'].includes(form.http_config.method) && (
              <div>
                <label className={labelCls}>请求体格式 (Body)</label>
                <div className="mb-2 flex gap-2">
                  {[
                    { v: 'json', l: 'JSON' },
                    { v: 'form', l: 'Form-data' },
                    { v: 'xml', l: 'XML' },
                  ].map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => setHttpField('body_type')(o.v)}
                      className={`rounded px-2.5 py-1 text-xs ${form.http_config.body_type === o.v ? 'bg-primary text-foreground' : 'bg-secondary text-muted-foreground'}`}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
                <textarea
                  className={`${inputCls} resize-y font-mono`}
                  rows={5}
                  value={form.http_config.body_content}
                  onChange={(e) => setHttpField('body_content')(e.target.value)}
                  placeholder={
                    form.http_config.body_type === 'json'
                      ? '{\n  "fixed_key": "value"\n}\n（运行时 body 参数会自动合并）'
                      : form.http_config.body_type === 'xml'
                      ? '<request>\n  <key>value</key>\n</request>'
                      : '键值对参数会自动作为 form-data 发送'
                  }
                  spellCheck={false}
                />
              </div>
            )}
          </Card>
        )}

        {/* 维度三：鉴权与安全配置（仅 HTTP） */}
        {isHttp && (
          <Card title="鉴权与安全配置" icon={<Lock className="h-4 w-4" />}>
            <SelectInput
              label="鉴权方式"
              value={form.http_config.auth_type}
              onChange={(v) => { setHttpField('auth_type')(v); setHttpField('auth_config')({}) }}
              options={[
                { value: 'none', label: '无鉴权' },
                { value: 'bearer', label: 'API Key (Bearer Token)' },
                { value: 'api_key', label: 'API Key (自定义 Header/Query)' },
                { value: 'oauth2', label: 'OAuth 2.0 (预配置 Access Token)' },
              ]}
            />

            {/* Bearer Token */}
            {form.http_config.auth_type === 'bearer' && (
              <TextInput
                label="Bearer Token"
                value={form.http_config.auth_config.token || ''}
                onChange={(v) => setHttpField('auth_config')({ ...form.http_config.auth_config, token: v })}
                placeholder="Authorization: Bearer <token>"
              />
            )}

            {/* API Key 自定义 */}
            {form.http_config.auth_type === 'api_key' && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <TextInput
                    label="Key 名称"
                    value={form.http_config.auth_config.key_name || ''}
                    onChange={(v) => setHttpField('auth_config')({ ...form.http_config.auth_config, key_name: v })}
                    placeholder="如 X-API-Key"
                  />
                  <TextInput
                    label="Key 值"
                    value={form.http_config.auth_config.key_value || ''}
                    onChange={(v) => setHttpField('auth_config')({ ...form.http_config.auth_config, key_value: v })}
                    placeholder="实际的 API Key"
                  />
                </div>
                <SelectInput
                  label="位置"
                  value={form.http_config.auth_config.location || 'header'}
                  onChange={(v) => setHttpField('auth_config')({ ...form.http_config.auth_config, location: v })}
                  options={[
                    { value: 'header', label: '请求头 Header' },
                    { value: 'query', label: '查询参数 Query' },
                  ]}
                />
              </div>
            )}

            {/* OAuth2 简化：使用预配置 access_token */}
            {form.http_config.auth_type === 'oauth2' && (
              <div className="flex flex-col gap-2">
                <TextInput
                  label="Access Token（预配置）"
                  value={form.http_config.auth_config.access_token || ''}
                  onChange={(v) => setHttpField('auth_config')({ ...form.http_config.auth_config, access_token: v })}
                  placeholder="已获取的 OAuth2 Access Token"
                />
                <p className={hintCls}>
                  简化实现：直接填入已通过授权码流程获取的 access_token。完整 OAuth2 流程（Client ID/Secret/授权 URL）将在后续版本支持。
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <NumberInput
                label="超时时间（秒）"
                value={form.http_config.timeout}
                onChange={setHttpField('timeout')}
                min={1}
                max={120}
                step={1}
              />
              <NumberInput
                label="失败重试次数（仅 5xx）"
                value={form.http_config.retry}
                onChange={setHttpField('retry')}
                min={0}
                max={5}
                step={1}
              />
            </div>
          </Card>
        )}

        {/* 维度四：参数定义与映射（默认展开，关键配置） */}
        <Card title="参数定义与映射" icon={<SlidersHorizontal className="h-4 w-4" />} hint="LLM 从用户输入中提取参数的规则" defaultOpen={true}>
          {isFramework ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] text-primary">
                <Lock className="h-3.5 w-3.5" />
                框架内置工具使用 OpenAI 参数格式（JSON 对象），不支持可视化编辑。
              </p>
              <pre className="max-h-60 overflow-auto rounded border border-border bg-card p-2 text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(form.parameters_schema, null, 2)}
              </pre>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <p className={`${hintCls} mb-0`}>
                  大模型决定调用工具时，会从用户自然语言中提取这些参数。
                  {isHttp && ' 位置决定参数放在 Query URL 还是 Body JSON 中。'}
                  描述写得好，LLM 提取才准。
                </p>
                {/* 从描述自动提取参数 */}
                <button
                  type="button"
                  onClick={async () => {
                    if (!form.description.trim()) {
                      toast.warning('请先填写工具描述')
                      return
                    }
                    try {
                      toast.info('正在从描述提取参数…')
                      const res = await toolsApi.extractParameters({
                        name: form.name,
                        description: form.description,
                      })
                      if (res.parameters && res.parameters.length > 0) {
                        setField('parameters_schema')(res.parameters)
                        toast.success(`已提取 ${res.parameters.length} 个参数`)
                      } else {
                        toast.warning('未能从描述中提取参数')
                      }
                    } catch (err) {
                      toast.error(`提取失败：${err.message || err}`)
                    }
                  }}
                  className="flex shrink-0 items-center gap-1 rounded border border-primary/50 px-2 py-1 text-[10px] text-primary transition hover:bg-primary/10"
                >
                  <Wand2 className="h-3 w-3" /> 从描述提取参数
                </button>
              </div>
              <ParamSchemaEditor
                value={form.parameters_schema}
                onChange={setField('parameters_schema')}
                showHttpFields={isHttp}
              />
              {/* kwargs 提示同步：展示代码中可用的参数名 */}
              {!isHttp && !isFramework && form.parameters_schema.length > 0 && (
                <div className="mt-2 rounded-md border border-border bg-muted p-2">
                  <div className="mb-0.5 text-[10px] font-semibold text-muted-foreground">代码中可通过 kwargs 获取：</div>
                  <code className="text-[11px] text-primary">
                    {form.parameters_schema.map((p) => p.name).filter(Boolean).map((n) => `kwargs.get('${n}')`).join(',  ')}
                  </code>
                </div>
              )}
            </>
          )}
        </Card>

        {/* 维度五：响应处理与解析（仅 HTTP） */}
        {isHttp && (
          <Card title="响应处理与解析" icon={<Package className="h-4 w-4" />} hint="只把 LLM 需要的字段保留，节省 Token" defaultOpen={false}>
            <TextInput
              label="字段提取（JSONPath）"
              value={form.http_config.response_jsonpath}
              onChange={setHttpField('response_jsonpath')}
              placeholder="如 $.data.weather_info（留空则返回完整响应）"
              hint="支持 $.a.b.c、$.list[0].name、$.items[*].id。API 返回 50 个字段时，可只提取需要的部分传给 LLM。"
            />
            <TextArea
              label="异常处理逻辑（可选）"
              value={form.http_config.error_handling}
              onChange={setHttpField('error_handling')}
              rows={2}
              placeholder="如：HTTP 非 2xx 时向用户道歉并建议换种问法；业务 code 非 0 时返回错误提示"
              hint="当 HTTP 状态码非 2xx 或业务报错时，指导大模型如何应对（描述性说明）。"
            />
          </Card>
        )}

        {/* Python 代码（仅 code 工具，framework 无代码） */}
        {!isHttp && !isFramework && (
          <Card title="Python 代码" icon={<Code2 className="h-4 w-4" />} hint="代码内须定义 `async def run(**kwargs)`，返回值即结果。">
            {/* 代码模板库 + 全屏按钮 */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">模板：</span>
                {CODE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    onClick={() => {
                      setField('code')(tpl.code)
                      toast.success(`已应用「${tpl.label}」模板`)
                    }}
                    className="rounded border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                    title={tpl.desc}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setCodeFullscreen(true)}
                className="flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                title="全屏编辑"
              >
                <Maximize2 className="h-3 w-3" /> 全屏
              </button>
            </div>
            <CodeEditor value={form.code} onChange={setField('code')} />
            <p className={hintCls}>
              可用模块：asyncio / json / datetime / re / ipaddress / httpx（沙箱内执行，禁止 os/subprocess/socket 等）。
            </p>
          </Card>
        )}

        {/* 维度六：调试与测试面板（framework 工具不可测试） */}
        {!isFramework && (
        <div ref={debugTriggerRef}>
        <Card title="调试与测试面板" icon={<TestTube className="h-4 w-4" />} defaultOpen={false}>
          <DebugPanel
            ref={debugPanelRef}
            toolId={id}
            parametersSchema={form.parameters_schema}
            toolType={form.tool_type}
            httpConfig={form.http_config}
          />
        </Card>
        </div>
        )}

        <div className="h-2" />
      </div>

      {/* OpenAPI 导入弹窗 */}
      <OpenAPIImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onPick={handlePickOperation}
      />

      {/* 代码全屏编辑弹窗 */}
      {codeFullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border px-6 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Code2 className="h-4 w-4" />
              Python 代码编辑（全屏）
            </div>
            <div className="flex items-center gap-2">
              {CODE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() => setField('code')(tpl.code)}
                  className="rounded border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  {tpl.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCodeFullscreen(false)}
                className="flex items-center gap-1 rounded border border-border bg-secondary px-2 py-1 text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
              >
                <Minimize2 className="h-3.5 w-3.5" /> 退出全屏
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6">
            <CodeEditor value={form.code} onChange={setField('code')} />
          </div>
        </div>
      )}
    </div>
  )
}

export default ToolEditor
