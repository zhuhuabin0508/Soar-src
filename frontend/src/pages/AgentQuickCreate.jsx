import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, Check, Shield, ShieldBan, Package, Sparkles,
  Wrench, Database, Play, Rocket, Save, AlertTriangle, Loader2, MessageSquare,
} from 'lucide-react'
import {
  agents as agentsApi,
  llmConfigs as llmApi,
  tools as toolsApi,
  knowledgeBases as kbApi,
} from '../api/client'
import { AGENT_TEMPLATES, resolveAgentTemplate, loadStashedAgentDsl } from '../constants/agentTemplates'
import {
  planAgentFromDescription,
  planAgentFromDsl,
  DESCRIPTION_EXAMPLES,
  AGENT_QUICK_DRAFT_KEY,
} from '../constants/agentIntentPlanner'
import { TextInput, TextArea, SelectInput, CheckboxGroup } from '../components/property/FormControls'
import { toast } from '../store/toastStore'
import { runAgentQuickTest } from '../utils/runAgentQuickTest'

const TEMPLATE_ICONS = { shield: Shield, ban: ShieldBan, package: Package }
const STEPS = ['描述需求', '确认配置', '测试发布']

function AgentQuickCreate() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTplId = searchParams.get('template')

  const [step, setStep] = useState(0)
  const [description, setDescription] = useState('')
  const [plan, setPlan] = useState(null)

  const [name, setName] = useState('')
  const [roleLine, setRoleLine] = useState('')
  const [greeting, setGreeting] = useState('')
  const [modelConfigId, setModelConfigId] = useState('')
  const [enabledTools, setEnabledTools] = useState([])
  const [enabledKbs, setEnabledKbs] = useState([])
  const [enabledAssetTypes, setEnabledAssetTypes] = useState([])
  const [toolReasons, setToolReasons] = useState({})

  const [llmOptions, setLlmOptions] = useState([])
  const [toolOptions, setToolOptions] = useState([])
  const [kbOptions, setKbOptions] = useState([])

  const [showExtraTools, setShowExtraTools] = useState(false)
  const [showExtraKbs, setShowExtraKbs] = useState(false)

  const [draftAgentId, setDraftAgentId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testInput, setTestInput] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [testError, setTestError] = useState('')
  const [testLogTab, setTestLogTab] = useState('reply')

  const template = useMemo(
    () => AGENT_TEMPLATES.find((t) => t.id === plan?.templateId) || plan?.template || AGENT_TEMPLATES[0],
    [plan],
  )

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [llms, tls, kbs] = await Promise.all([llmApi.list(), toolsApi.list(), kbApi.list()])
        if (!alive) return
        setLlmOptions((Array.isArray(llms) ? llms : []).map((m) => ({
          value: String(m.id),
          label: m.name || m.model_name || `模型 ${m.id}`,
        })))
        setToolOptions((Array.isArray(tls) ? tls : []).map((t) => ({
          value: t.name || `工具 ${t.id}`,
          label: t.name || `工具 ${t.id}`,
          description: t.description || '',
        })))
        setKbOptions((Array.isArray(kbs) ? kbs : []).map((k) => ({
          value: String(k.id),
          label: `${k.name || `知识库 ${k.id}`}（${k.doc_count ?? 0} 篇）`,
        })))
        if (llms?.length && !modelConfigId) {
          setModelConfigId(String(llms[0].id))
        }
      } catch (err) {
        toast.error(err.message || '加载选项失败')
      }
    })()
    return () => { alive = false }
  }, [])

  // URL 带 template 时预填描述
  useEffect(() => {
    if (initialTplId && toolOptions.length > 0) {
      const tpl = AGENT_TEMPLATES.find((t) => t.id === initialTplId)
      if (tpl) {
        setDescription(`${tpl.description}。${tpl.scenario || ''}`)
      }
    }
  }, [initialTplId, toolOptions.length])

  const applyPlan = useCallback((p) => {
    setPlan(p)
    setName(p.name)
    setRoleLine(p.roleLine)
    setGreeting(p.greeting)
    setEnabledTools(p.enabledTools)
    setEnabledKbs(p.enabledKbs)
    setEnabledAssetTypes(p.enabledAssetTypes || [])
    setToolReasons(p.toolReasons || {})
    setTestInput(p.suggestedTest || '')
    if (p.modelConfigId) setModelConfigId(p.modelConfigId)
  }, [])

  // 从 AgentList / DSL 面板暂存的团队模板预填
  useEffect(() => {
    if (toolOptions.length === 0) return
    const stashed = loadStashedAgentDsl()
    if (!stashed) return
    const dsl = stashed.dsl || stashed
    const desc = stashed.description || dsl.description || dsl.name || ''
    if (desc) setDescription(desc)
    const p = planAgentFromDsl(dsl, { toolOptions, kbOptions })
    applyPlan(p)
    setStep(1)
    toast.success('已载入团队模板配置，请确认后测试')
  }, [toolOptions.length, kbOptions.length, applyPlan])

  const runPlan = () => {
    if (!description.trim()) {
      toast.warning('请先描述你想要的智能体')
      return false
    }
    const p = planAgentFromDescription(description, { toolOptions, kbOptions })
    applyPlan(p)
    return true
  }

  const recommendedTools = useMemo(
    () => toolOptions.filter((t) => enabledTools.includes(t.value)),
    [toolOptions, enabledTools],
  )

  const extraTools = useMemo(
    () => toolOptions.filter((t) => !enabledTools.includes(t.value)),
    [toolOptions, enabledTools],
  )

  const toggleTool = (toolName) => {
    setEnabledTools((prev) => (
      prev.includes(toolName) ? prev.filter((x) => x !== toolName) : [...prev, toolName]
    ))
  }

  const buildAgentBody = (asDraft = false) => {
    const base = resolveAgentTemplate(template, {
      kbOptions: kbOptions.map((k) => ({ value: k.value, label: k.label.replace(/（\d+ 篇）$/, '') })),
      toolOptions,
    })
    const systemPrompt = roleLine.trim()
      ? `${roleLine.trim()}\n\n${base?.system_prompt || ''}`
      : (base?.system_prompt || '')
    const draftPrefix = asDraft && !name.startsWith('（草稿）') ? '（草稿）' : ''
    return {
      name: `${draftPrefix}${name.trim()}`,
      description: asDraft ? `[草稿] ${description.slice(0, 200)}` : (base?.description || description.slice(0, 200)),
      greeting: greeting || base?.greeting || null,
      suggested_questions: base?.suggested_questions || [],
      model_config_id: Number(modelConfigId),
      system_prompt: systemPrompt,
      temperature: base?.temperature ?? 0.3,
      max_tokens: base?.max_tokens ?? 1024,
      reasoning_effort: base?.reasoning_effort ?? null,
      context_turns: 10,
      enabled_tools: enabledTools,
      enabled_kbs: enabledKbs.map(Number),
      enabled_asset_types: enabledAssetTypes,
      enabled_skills: [],
      max_iterations: base?.max_iterations ?? 8,
      enable_memory: false,
      tone_style: 'professional',
      variables: asDraft ? { _publish_status: 'draft' } : { _publish_status: 'published' },
      tool_configs: base?.tool_configs || { tool_search: { enabled: 'off' } },
      engine: base?.engine || 'hermes',
    }
  }

  const ensureAgent = async (asDraft = true) => {
    if (!name.trim()) throw new Error('请填写智能体名称')
    if (!modelConfigId) throw new Error('请选择模型')
    if (enabledTools.length === 0) throw new Error('至少需要挂载一个工具')
    const body = buildAgentBody(asDraft)
    if (draftAgentId) {
      return agentsApi.update(draftAgentId, body)
    }
    const created = await agentsApi.create(body)
    setDraftAgentId(created.id)
    return created
  }

  const goStep = async (next) => {
    if (next === 1 && step === 0) {
      if (!runPlan()) return
    }
    if (next === 2 && step === 1) {
      if (!name.trim() || !modelConfigId) {
        toast.warning('请填写名称并选择模型')
        return
      }
      if (enabledTools.length === 0) {
        toast.warning('未选配任何工具，请返回添加或展开选择')
        return
      }
      setSaving(true)
      try {
        await ensureAgent(true)
        toast.success('已保存为可测试草稿')
      } catch (err) {
        toast.error(err.message || '保存草稿失败')
        setSaving(false)
        return
      }
      setSaving(false)
    }
    setStep(next)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestError('')
    setTestResult({ streaming: true, reply: '', logs: [], toolCalls: [], statusMsgs: [] })
    setTestLogTab('reply')
    try {
      const agent = await ensureAgent(true)
      const agentId = agent?.id ?? draftAgentId
      if (!agentId) throw new Error('草稿保存失败，无法测试')

      const input = testInput.trim() || plan?.suggestedTest || '你好'
      const engine = template?.form?.engine || 'hermes'

      const res = await runAgentQuickTest(agentId, input, {
        engine,
        onProgress: (patch) => setTestResult((prev) => ({ ...prev, ...patch })),
      })
      setTestResult(res)
      if (res?.reply || res?.logs?.length || res?.toolCalls?.length) {
        toast.success('测试完成，请查看下方输出')
      } else {
        toast.warning('测试已结束，但未收到文本回复，请查看日志')
        setTestLogTab('logs')
      }
    } catch (err) {
      setTestError(err.message || '测试失败')
      setTestResult(null)
      toast.error('测试失败，请查看错误信息或补充工具后重试')
    } finally {
      setTesting(false)
    }
  }

  const handlePublish = async () => {
    setSaving(true)
    try {
      const body = buildAgentBody(false)
      body.name = body.name.replace(/^（草稿）/, '')
      body.description = (body.description || '').replace(/^\[草稿\]\s*/, '')
      body.variables = { _publish_status: 'published' }
      let agent
      if (draftAgentId) {
        agent = await agentsApi.update(draftAgentId, body)
      } else {
        agent = await agentsApi.create(body)
      }
      try { localStorage.removeItem(AGENT_QUICK_DRAFT_KEY) } catch { /* ignore */ }
      toast.success('智能体已发布，可在列表或对话中使用')
      navigate(`/agents/${agent.id}/edit`)
    } catch (err) {
      toast.error(err.message || '发布失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveDraft = async () => {
    setSaving(true)
    try {
      const agent = await ensureAgent(true)
      try {
        localStorage.setItem(AGENT_QUICK_DRAFT_KEY, JSON.stringify({
          agentId: agent.id,
          description,
          savedAt: Date.now(),
        }))
      } catch { /* ignore */ }
      toast.success('已暂存草稿，可稍后在智能体列表继续编辑')
      navigate('/studio')
    } catch (err) {
      toast.error(err.message || '暂存失败')
    } finally {
      setSaving(false)
    }
  }

  const testPassed = testResult && !testResult.streaming && (
    testResult.reply || testResult.toolCalls?.length || testResult.logs?.length
  )

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/studio')} className="btn-secondary btn-sm">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">描述创建智能体</h1>
            <p className="text-xs text-muted-foreground">像 Coze 一样：描述需求 → 自动选配工具 → 测试 → 发布或暂存</p>
          </div>
        </div>
        <button type="button" onClick={() => navigate('/agents/new')} className="text-xs text-muted-foreground underline hover:text-foreground">
          高级编辑器
        </button>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        <div className="mb-6 flex items-center justify-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-emerald-500/20 text-emerald-600' : 'bg-secondary text-muted-foreground'
              }`}>
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`text-sm ${i === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
            </div>
          ))}
        </div>

        {/* Step 0: 描述 */}
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <TextArea
              label="用自然语言描述你想要的智能体"
              value={description}
              onChange={setDescription}
              rows={5}
              placeholder="例如：帮我做一个告警研判助手，收到告警后先查白名单和资产归属，再查威胁情报，给出要不要封禁的建议……"
            />
            <div>
              <div className="mb-2 text-xs text-muted-foreground">试试这些示例：</div>
              <div className="flex flex-wrap gap-2">
                {DESCRIPTION_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setDescription(ex)}
                    className="rounded-full border border-border bg-secondary px-3 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                  >
                    {ex.slice(0, 28)}…
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-dashed border-border p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">或从场景模板快速开始</div>
              <div className="flex flex-wrap gap-2">
                {AGENT_TEMPLATES.map((tpl) => {
                  const Icon = TEMPLATE_ICONS[tpl.icon] || Sparkles
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => setDescription(`${tpl.description}。适用：${tpl.scenario || tpl.name}`)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:border-primary/40"
                    >
                      <Icon className="h-3.5 w-3.5 text-primary" />
                      {tpl.name}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: 确认自动选配 */}
        {step === 1 && plan && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
              <Sparkles className="mb-1 inline h-4 w-4 text-primary" />
              {plan.summary}
            </div>

            {plan.missingTools?.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  场景建议的工具「{plan.missingTools.join('、')}」在平台尚未安装，可能影响效果。
                  <button type="button" className="ml-1 underline" onClick={() => navigate('/tools')}>去工具库添加</button>
                </span>
              </div>
            )}

            <TextInput label="智能体名称" value={name} onChange={setName} required maxLength={50} />
            <SelectInput label="模型" value={modelConfigId} onChange={setModelConfigId} options={llmOptions} required />

            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                <Wrench className="h-3.5 w-3.5 text-primary" />
                已自动选配工具（{enabledTools.length} 个）
              </div>
              <div className="flex flex-col gap-2">
                {recommendedTools.map((tool) => (
                  <label key={tool.value} className="flex gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={enabledTools.includes(tool.value)}
                      onChange={() => toggleTool(tool.value)}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <div>
                      <div className="text-sm font-medium">{tool.label}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {toolReasons[tool.value] || template?.tool_hints?.[tool.value] || (tool.description || '').slice(0, 60)}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              {extraTools.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowExtraTools((v) => !v)}
                  className="mt-2 text-[11px] text-primary underline"
                >
                  {showExtraTools ? '收起' : `工具不够？添加更多（${extraTools.length} 个可选）`}
                </button>
              )}
              {showExtraTools && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border p-2">
                  <CheckboxGroup
                    value={enabledTools}
                    onChange={setEnabledTools}
                    options={extraTools}
                    columns={1}
                  />
                </div>
              )}
            </div>

            {enabledKbs.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                <Database className="inline h-3 w-3" /> 已自动关联 {enabledKbs.length} 个知识库
              </p>
            )}
          </div>
        )}

        {/* Step 2: 测试 & 发布 */}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <MessageSquare className="h-4 w-4 text-primary" />
                试运行
              </div>
              <TextArea
                label="测试输入"
                value={testInput}
                onChange={setTestInput}
                rows={3}
                placeholder="输入一条典型用户问题或告警上下文…"
              />
              <button
                type="button"
                disabled={testing}
                onClick={handleTest}
                className="btn-secondary btn-sm mt-2 inline-flex items-center gap-1.5"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {testing ? '测试中…' : '运行测试'}
              </button>
              {testError && (
                <div className="mt-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {testError}
                  <button type="button" className="ml-2 underline" onClick={() => { setStep(1); setShowExtraTools(true) }}>
                    返回添加工具
                  </button>
                </div>
              )}

              {(testing || testResult) && (
                <div className="mt-4 rounded-lg border border-border bg-background">
                  <div className="flex border-b border-border">
                    {[
                      { id: 'reply', label: '回复' },
                      { id: 'tools', label: `工具(${testResult?.toolCalls?.length || 0})` },
                      { id: 'logs', label: `日志(${testResult?.logs?.length || 0})` },
                      { id: 'raw', label: '原始' },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setTestLogTab(tab.id)}
                        className={`px-3 py-2 text-xs font-medium transition ${
                          testLogTab === tab.id
                            ? 'border-b-2 border-primary text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                    {testResult?.streaming && (
                      <span className="ml-auto flex items-center gap-1.5 px-3 text-[10px] text-primary">
                        <Loader2 className="h-3 w-3 animate-spin" /> 运行中…
                      </span>
                    )}
                  </div>

                  <div className="max-h-72 overflow-y-auto p-3 text-xs">
                    {testLogTab === 'reply' && (
                      <>
                        {(testResult?.statusMsgs?.length > 0) && (
                          <div className="mb-2 space-y-0.5 text-[10px] text-muted-foreground">
                            {testResult.statusMsgs.map((s, i) => (
                              <div key={i}>· {s}</div>
                            ))}
                          </div>
                        )}
                        {testResult?.reply ? (
                          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
                            {testResult.reply}
                          </pre>
                        ) : (
                          <p className="text-muted-foreground">
                            {testing ? '等待模型回复…' : '无文本回复，请查看「工具」或「日志」标签'}
                          </p>
                        )}
                      </>
                    )}

                    {testLogTab === 'tools' && (
                      (testResult?.toolCalls?.length > 0) ? (
                        <div className="flex flex-col gap-2">
                          {testResult.toolCalls.map((tc, i) => (
                            <div key={tc.call_id || i} className="rounded border border-border p-2">
                              <div className="flex items-center gap-2 font-medium text-foreground">
                                <Wrench className="h-3 w-3 text-primary" />
                                {tc.name}
                                <span className={`rounded px-1 text-[9px] ${
                                  tc.status === 'done' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-warning/15 text-warning'
                                }`}>
                                  {tc.status === 'done' ? '完成' : '执行中'}
                                </span>
                              </div>
                              {tc.message && <div className="mt-1 text-muted-foreground">{tc.message}</div>}
                              {tc.result != null && (
                                <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-[10px]">
                                  {typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">本次测试未调用工具</p>
                      )
                    )}

                    {testLogTab === 'logs' && (
                      (testResult?.logs?.length > 0) ? (
                        <div className="flex flex-col gap-1 font-mono text-[11px]">
                          {testResult.logs.map((log, i) => (
                            <div key={i} className="border-b border-border pb-1 last:border-0">
                              <span className="text-muted-foreground">[{log.level || 'info'}]</span>
                              {' '}{log.message || JSON.stringify(log)}
                              {log.detail != null && (
                                <pre className="mt-0.5 whitespace-pre-wrap text-[10px] text-muted-foreground">
                                  {typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">暂无日志</p>
                      )
                    )}

                    {testLogTab === 'raw' && testResult && (
                      <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                        {JSON.stringify(testResult, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={saving}
                onClick={handlePublish}
                className="btn-primary flex flex-1 items-center justify-center gap-2"
              >
                <Rocket className="h-4 w-4" />
                {testPassed ? '测试通过，发布' : '直接发布'}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveDraft}
                className="btn-secondary flex flex-1 items-center justify-center gap-2"
              >
                <Save className="h-4 w-4" />
                暂存草稿
              </button>
            </div>
            <p className="text-center text-[10px] text-muted-foreground">
              测试有问题可先「暂存草稿」，稍后在编辑器中补充工具后再发布
            </p>
          </div>
        )}

        {step < 2 && (
          <div className="mt-8 flex justify-between">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="btn-secondary btn-sm inline-flex items-center gap-1"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 上一步
            </button>
            <button
              type="button"
              onClick={() => goStep(step + 1)}
              disabled={saving}
              className="btn-primary btn-sm inline-flex items-center gap-1"
            >
              {saving ? '保存中…' : '下一步'} <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default AgentQuickCreate
