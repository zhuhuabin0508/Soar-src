import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, FolderKanban, MessageSquare, Pencil,
  Rocket, Loader2, Check, LayoutTemplate, GitBranch, ChevronRight,
} from 'lucide-react'
import { workflows as workflowsApi } from '../api/client'
import { TextInput, TextArea } from '../components/property/FormControls'
import { toast } from '../store/toastStore'
import {
  WORKFLOW_TEMPLATES,
  generateWorkflowSkeletonFromText,
} from '../constants/workflowTemplates'
import { getNodeDefinition } from '../constants/nodeCatalog'

const STEPS = ['选择方式', '确认流程', '发布']
const DESCRIPTION_EXAMPLES = [
  '收到暴力破解告警后研判源 IP，高风险则封禁并邮件通知值班',
  '每日早上 9 点采集资产状态，AI 分析后推送报告',
  '手动录入消息后同时发邮件和 Webhook 推送',
]

function orderedNodes(graph) {
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  if (!nodes.length) return []
  const next = {}
  edges.forEach((e) => { next[e.source] = e.target })
  const incoming = new Set(edges.map((e) => e.target))
  let cur = (nodes.find((n) => !incoming.has(n.id)) || nodes[0])?.id
  const out = []
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const node = nodes.find((n) => n.id === cur)
    if (node) out.push(node)
    cur = next[cur]
  }
  nodes.forEach((n) => {
    if (!seen.has(n.id)) out.push(n)
  })
  return out
}

function WorkflowQuickCreate() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTpl = searchParams.get('template')
  const initialMode = searchParams.get('mode')
  const initialQ = searchParams.get('q')

  const [step, setStep] = useState(0)
  const [mode, setMode] = useState(null)
  const [description, setDescription] = useState(initialQ || '')
  const [selectedTplKey, setSelectedTplKey] = useState(null)

  const [draftId, setDraftId] = useState(null)
  const [name, setName] = useState('')
  const [wfDescription, setWfDescription] = useState('')
  const [category, setCategory] = useState('')
  const [graphConfig, setGraphConfig] = useState({ nodes: [], edges: [], variables: [] })

  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)

  const flowNodes = useMemo(() => orderedNodes(graphConfig), [graphConfig])

  const applyDraft = useCallback((wf) => {
    setDraftId(wf.id)
    setName(wf.name || '未命名工作流')
    setWfDescription(wf.description || '')
    setCategory(wf.category || '')
    setGraphConfig(wf.graph_config || { nodes: [], edges: [], variables: [] })
  }, [])

  useEffect(() => {
    if (initialMode === 'describe') {
      setMode('describe')
      return
    }
    if (!initialTpl) return
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.key === initialTpl)
    if (tpl) {
      setMode('template')
      setSelectedTplKey(tpl.key)
      setDescription(tpl.description || '')
      setName(tpl.template.name)
      setWfDescription(tpl.description)
      setCategory(tpl.scenario || '')
      setGraphConfig(tpl.template.graph_config)
    }
  }, [initialTpl, initialMode])

  const createFromTemplate = async (tplKey) => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.key === tplKey)
    if (!tpl) return
    setGenerating(true)
    try {
      const wf = await workflowsApi.create({
        name: tpl.template.name,
        graph_config: tpl.template.graph_config,
        status: 'draft',
        enabled: false,
        trigger_type: tpl.template.graph_config?.nodes?.[0]?.type === 'schedule_trigger' ? 'schedule' : 'webhook',
        description: tpl.description,
        category: tpl.scenario,
        tags: tpl.tags,
      })
      applyDraft(wf)
      setStep(1)
      toast.success('已载入模板，请确认流程步骤')
    } catch (err) {
      toast.error(err.message || '创建失败')
    } finally {
      setGenerating(false)
    }
  }

  const createFromDescription = async () => {
    if (!description.trim()) {
      toast.warning('请先描述工作流要做什么')
      return
    }
    setGenerating(true)
    try {
      const wf = await workflowsApi.generateDraft(description.trim())
      applyDraft(wf)
      setStep(1)
      toast.success('已生成流程草稿，请确认节点后发布')
    } catch (err) {
      const sk = generateWorkflowSkeletonFromText(description.trim())
      try {
        const wf = await workflowsApi.create({
          name: sk.name,
          graph_config: sk.graph_config,
          status: 'draft',
          enabled: false,
          trigger_type: 'webhook',
          description: description.trim(),
          category: '告警处置',
          tags: ['AI草稿'],
        })
        applyDraft(wf)
        setStep(1)
        toast.success('已生成流程草稿（本地骨架）')
      } catch (e2) {
        toast.error(e2.message || err.message || '生成失败')
      }
    } finally {
      setGenerating(false)
    }
  }

  const saveDraft = async () => {
    if (!name.trim()) throw new Error('请填写工作流名称')
    if (!draftId) {
      const wf = await workflowsApi.create({
        name: name.trim(),
        graph_config: graphConfig,
        status: 'draft',
        enabled: false,
        trigger_type: 'webhook',
        description: wfDescription,
        category: category || undefined,
      })
      setDraftId(wf.id)
      return wf
    }
    const updated = await workflowsApi.updateDraft(draftId, {
      name: name.trim(),
      description: wfDescription,
      graph_config: graphConfig,
      category: category || undefined,
    })
    return updated
  }

  const goStep = async (next) => {
    if (next === 1 && step === 0) {
      if (mode === 'template') {
        if (selectedTplKey && !draftId) {
          await createFromTemplate(selectedTplKey)
          return
        }
        if (!draftId && !graphConfig.nodes?.length) {
          toast.warning('请选择一个模板')
          return
        }
      } else if (mode === 'describe') {
        if (!draftId) {
          await createFromDescription()
          return
        }
      } else {
        toast.warning('请选择创建方式')
        return
      }
    }
    if (next === 2 && step === 1) {
      if (!flowNodes.length) {
        toast.warning('流程中没有节点，请返回选择模板或描述')
        return
      }
      setSaving(true)
      try {
        await saveDraft()
      } catch (err) {
        toast.error(err.message || '保存失败')
        setSaving(false)
        return
      }
      setSaving(false)
    }
    setStep(next)
  }

  const handlePublish = async () => {
    setSaving(true)
    try {
      const wf = await saveDraft()
      const id = wf?.id ?? draftId
      if (!id) throw new Error('草稿保存失败')
      await workflowsApi.publishDraft(id)
      toast.success('工作流已发布')
      navigate('/studio?tab=workflow')
    } catch (err) {
      toast.error(err.message || '发布失败')
    } finally {
      setSaving(false)
    }
  }

  const openAdvancedEditor = async () => {
    try {
      const wf = await saveDraft()
      const id = wf?.id ?? draftId
      navigate(`/editor?id=${id}`)
    } catch (err) {
      toast.error(err.message || '无法打开画布')
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/studio?tab=workflow')} className="btn-secondary btn-sm">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">快速创建工作流</h1>
          </div>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          {STEPS.map((label, i) => (
            <div key={label} className={`flex items-center gap-1.5 text-xs ${i === step ? 'font-medium text-primary' : i < step ? 'text-foreground' : 'text-muted-foreground'}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${i <= step ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {label}
              {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {step === 0 && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => { setMode('template'); setSelectedTplKey(null) }}
                  className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition ${mode === 'template' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                >
                  <LayoutTemplate className="h-5 w-5 text-primary" />
                  <span className="text-sm font-medium">从模板开始</span>
                  <span className="text-xs text-muted-foreground">告警处置、巡检、通知等常见场景</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('describe')}
                  className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition ${mode === 'describe' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                >
                  <MessageSquare className="h-5 w-5 text-cyan-500" />
                  <span className="text-sm font-medium">一句话描述</span>
                  <span className="text-xs text-muted-foreground">AI 生成流程骨架，再人工确认</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/editor')}
                  className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border p-4 text-left transition hover:border-primary/40"
                >
                  <Pencil className="h-5 w-5 text-muted-foreground" />
                  <span className="text-sm font-medium">高级画布</span>
                  <span className="text-xs text-muted-foreground">复杂编排、分支与调试</span>
                </button>
              </div>

              {mode === 'template' && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">选择模板：</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {WORKFLOW_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.key}
                        type="button"
                        disabled={generating}
                        onClick={() => {
                          setSelectedTplKey(tpl.key)
                          setName(tpl.template.name)
                          setWfDescription(tpl.description)
                          setCategory(tpl.scenario || '')
                          setGraphConfig(tpl.template.graph_config)
                        }}
                        className={`rounded-lg border p-4 text-left transition ${selectedTplKey === tpl.key ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                      >
                        <div className="text-sm font-medium">{tpl.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{tpl.description}</div>
                        {tpl.tags?.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {tpl.tags.map((tag) => (
                              <span key={tag} className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{tag}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {mode === 'describe' && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <label className="mb-2 block text-sm font-medium">描述你的工作流</label>
                  <TextArea
                    value={description}
                    onChange={setDescription}
                    rows={3}
                    placeholder="例如：收到告警后研判源 IP，若高风险则封禁并通知值班"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {DESCRIPTION_EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => setDescription(ex)}
                        className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      >
                        {ex.slice(0, 24)}…
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {mode && mode !== 'advanced' && (
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => goStep(1)} disabled={generating || saving} className="btn-primary">
                    {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    下一步
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput label="工作流名称" value={name} onChange={setName} />
                <TextInput label="分类（可选）" value={category} onChange={setCategory} placeholder="告警处置" />
              </div>
              <TextArea label="描述" value={wfDescription} onChange={setWfDescription} rows={2} />

              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <GitBranch className="h-4 w-4 text-primary" />
                    流程步骤（{flowNodes.length} 个节点）
                  </div>
                  <button type="button" onClick={openAdvancedEditor} className="text-xs text-primary hover:underline">
                    在画布中精细调整
                  </button>
                </div>
                <div className="space-y-0">
                  {flowNodes.map((node, idx) => {
                    const def = getNodeDefinition(node.type)
                    const color = def?.color || '#6b7280'
                    const typeLabel = def?.label || node.type
                    const title = node.data?.label || typeLabel
                    return (
                      <div key={node.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                            style={{ backgroundColor: color }}
                          >
                            {idx + 1}
                          </div>
                          {idx < flowNodes.length - 1 && (
                            <div className="my-1 w-px flex-1 min-h-[24px] bg-border" />
                          )}
                        </div>
                        <div className="mb-4 flex-1 rounded-lg border border-border bg-background px-3 py-2.5">
                          <div className="text-sm font-medium">{title}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{typeLabel}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {flowNodes.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">暂无节点，请返回上一步选择模板或描述</p>
                )}
              </div>

              <div className="flex justify-between gap-2">
                <button type="button" onClick={() => setStep(0)} className="btn-secondary">上一步</button>
                <button type="button" onClick={() => goStep(2)} disabled={saving} className="btn-primary">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  下一步
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 text-center">
                <FolderKanban className="mx-auto mb-3 h-10 w-10 text-primary" />
                <h2 className="text-lg font-semibold">{name}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{wfDescription || '暂无描述'}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  共 {flowNodes.length} 个步骤 · 发布后可被 Webhook / 定时等方式触发
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <button type="button" onClick={() => setStep(1)} className="btn-secondary">上一步</button>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <button type="button" onClick={openAdvancedEditor} className="btn-secondary">
                    <Pencil className="h-4 w-4" />
                    高级编辑
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await saveDraft()
                        toast.success('已保存为草稿')
                        navigate('/studio?tab=workflow')
                      } catch (err) {
                        toast.error(err.message || '保存失败')
                      } finally {
                        setSaving(false)
                      }
                    }}
                    disabled={saving}
                    className="btn-secondary"
                  >
                    仅保存草稿
                  </button>
                  <button type="button" onClick={handlePublish} disabled={saving} className="btn-primary">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                    发布工作流
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default WorkflowQuickCreate
