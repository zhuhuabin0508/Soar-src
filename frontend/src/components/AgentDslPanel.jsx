import { useState, useEffect, useCallback } from 'react'
import { Copy, Download, Upload, FileCode2 } from 'lucide-react'
import { agents as agentsApi } from '../api/client'
import { toast } from '../store/toastStore'
import { textareaCls } from './property/FormControls'
import { AutoGrowTextarea } from './ui'

/** 开发者 DSL 面板：导出 / 导入 / 从 DSL 创建 */
export default function AgentDslPanel({ agentId, form, onApplyDsl, canEdit = true }) {
  const [dslText, setDslText] = useState('')
  const [loading, setLoading] = useState(false)

  const buildDslFromForm = useCallback(() => ({
    api_version: 'soar/agent-dsl/1',
    name: form.name,
    description: form.description,
    model_config_id: form.model_config_id ? Number(form.model_config_id) : null,
    system_prompt: form.system_prompt,
    temperature: Number(form.temperature),
    max_tokens: Number(form.max_tokens),
    enabled_tools: form.enabled_tools || [],
    enabled_kbs: (form.enabled_kbs || []).map(Number),
    enabled_asset_types: form.enabled_asset_types || [],
    enabled_skills: (form.enabled_skills || []).map(Number),
    max_iterations: Number(form.max_iterations),
    avatar: form.avatar || null,
    greeting: form.greeting || null,
    suggested_questions: form.suggested_questions || [],
    context_turns: Number(form.context_turns),
    enable_memory: form.enable_memory,
    tone_style: form.tone_style,
    variables: form.variables || {},
    tool_configs: form.tool_configs || {},
    engine: form.engine || 'hermes',
  }), [form])

  const loadFromServer = async () => {
    if (!agentId) {
      setDslText(JSON.stringify(buildDslFromForm(), null, 2))
      return
    }
    setLoading(true)
    try {
      const dsl = await agentsApi.exportDsl(agentId)
      setDslText(JSON.stringify(dsl, null, 2))
    } catch (err) {
      toast.error(err.message || '导出失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadFromServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const handleCopy = () => {
    navigator.clipboard.writeText(dslText).then(() => toast.success('已复制 DSL'))
  }

  const handleDownload = () => {
    const blob = new Blob([dslText], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${form.name || 'agent'}.soar-agent.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleApply = () => {
    try {
      const dsl = JSON.parse(dslText)
      if (onApplyDsl) onApplyDsl(dsl)
      toast.success('已应用 DSL 到当前表单（请保存）')
    } catch {
      toast.error('JSON 格式无效')
    }
  }

  const handleCreateFromDsl = async () => {
    try {
      const dsl = JSON.parse(dslText)
      const created = await agentsApi.createFromDsl(dsl)
      toast.success(`已从 DSL 创建智能体 #${created.id}`)
      window.location.href = `/agents/${created.id}/edit`
    } catch (err) {
      toast.error(err.message || '创建失败')
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FileCode2 className="h-4 w-4 text-primary" />
          DSL / JSON（开发者）
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={loadFromServer} disabled={loading} className="btn-secondary btn-sm">
            刷新
          </button>
          <button type="button" onClick={handleCopy} className="btn-secondary btn-sm" title="复制">
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={handleDownload} className="btn-secondary btn-sm" title="下载">
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        可导出为 JSON 做版本管理；粘贴 DSL 后点「应用到表单」或「另存为新智能体」。
      </p>
      <AutoGrowTextarea
        className={`${textareaCls} min-h-[200px] font-mono text-[11px]`}
        value={dslText}
        onChange={(e) => setDslText(e.target.value)}
        readOnly={!canEdit}
        spellCheck={false}
      />
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={handleApply} className="btn-secondary btn-sm inline-flex items-center gap-1">
            <Upload className="h-3.5 w-3.5" /> 应用到当前表单
          </button>
          <button type="button" onClick={handleCreateFromDsl} className="btn-secondary btn-sm">
            另存为新智能体
          </button>
        </div>
      )}
    </div>
  )
}
