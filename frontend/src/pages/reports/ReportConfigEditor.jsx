// 报告配置向导：基础/参数 → 数据采集 → 占位符映射 → 预览发布
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRightLeft, Beaker, ChevronDown, ChevronRight, Eye, Plus, RefreshCw, Save,
  Send, ShieldCheck, Sparkles, Trash2, X,
} from 'lucide-react'
import { reportApi } from '../../api/reports'
import { devices, tools } from '../../api/client'
import {
  Badge, Button, Card, CompactSelect, EmptyState, PageContainer, PageHeader, StatusBadge,
} from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { confirm } from '../../components/ConfirmDialog'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import {
  Field, IssueList, PdfPreviewPanel, VERSION_STATUS, StatusOf, inputCls, monoCls,
} from './shared'

const STEPS = ['基础与参数', '数据采集', '数据映射', '预览与发布']
const DEGRADE_OPTIONS = [
  ['degrade_mark', '标记缺失（填 —）'],
  ['fail', '中断运行'],
  ['default', '使用默认值'],
  ['skip_section', '跳过章节'],
  ['last_known', '沿用上次值'],
]
const TRANSFORM_OPS = [
  'to_int', 'to_float', 'round', 'date_format', 'map_values', 'count', 'sum',
  'avg', 'min', 'max', 'join', 'split', 'truncate', 'mask', 'unit_convert', 'default',
]

// 绑定唯一标识统一用 token（模板内唯一）
const bindingOf = (bindings, token) => bindings.find((b) => b.token === token)

function parseJSON(text, fallback) {
  if (!text || !text.trim()) return fallback
  return JSON.parse(text)
}

export default function ReportConfigEditor() {
  const { configId } = useParams()
  const id = Number(configId)
  const navigate = useNavigate()

  const [config, setConfig] = useState(null)
  const [versions, setVersions] = useState([])
  const [templateDetail, setTemplateDetail] = useState(null)
  const [manifest, setManifest] = useState(null)
  const [manifestLoading, setManifestLoading] = useState(false)

  const [step, setStep] = useState(0)
  const [versionId, setVersionId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const [meta, setMeta] = useState({ name: '', description: '', schedule_cron: '', output_name_pattern: '' })
  const [templateVersionId, setTemplateVersionId] = useState(null)
  const [paramsSchema, setParamsSchema] = useState([])
  const [dataSources, setDataSources] = useState([])
  const [bindings, setBindings] = useState([])
  const [crossChecksText, setCrossChecksText] = useState('[]')
  const [styleProfile, setStyleProfile] = useState('keep')
  const [changelog, setChangelog] = useState('')

  const [sampleParams, setSampleParams] = useState({})
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [health, setHealth] = useState(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthProbing, setHealthProbing] = useState(false)
  const [testIndex, setTestIndex] = useState(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [aiMappingOpen, setAiMappingOpen] = useState(false)

  const markDirty = () => setDirty(true)

  // ---------------- 加载 ----------------
  const load = useCallback(async () => {
    try {
      const detail = await reportApi.configs.detail(id)
      setConfig(detail.config)
      setVersions(detail.versions || [])
      setMeta({
        name: detail.config.name || '',
        description: detail.config.description || '',
        schedule_cron: detail.config.schedule_cron || '',
        output_name_pattern: detail.config.output_name_pattern || '',
      })
      const tpl = await reportApi.templates.detail(detail.config.template_id)
      setTemplateDetail(tpl)

      const latest = (detail.versions || [])[0]
      const baseVersionId = latest?.id || null
      setVersionId(baseVersionId)
      if (latest) {
        const version = await reportApi.configs.version(id, latest.id)
        setTemplateVersionId(version.template_version_id)
        setParamsSchema(version.params_schema || [])
        setDataSources(version.data_sources || [])
        setBindings(version.mapping?.bindings || [])
        setCrossChecksText(JSON.stringify(version.mapping?.cross_checks || [], null, 2))
        setStyleProfile(version.transform?.style_profile || 'keep')
        setChangelog('')
      } else {
        const published = (tpl.versions || []).find((v) => v.id === tpl.template.current_version_id)
          || (tpl.versions || []).find((v) => v.status === 'published')
        setTemplateVersionId(published?.id || null)
      }
    } catch (err) {
      toast.error(err.message || '配置加载失败')
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // 模板版本变化时加载 manifest
  useEffect(() => {
    if (!templateVersionId || !config) return
    let alive = true
    setManifestLoading(true)
    reportApi.templates.manifest(config.template_id, templateVersionId)
      .then((res) => { if (alive) setManifest(res.manifest || {}) })
      .catch((err) => { if (alive) toast.error(err.message || 'manifest 加载失败') })
      .finally(() => { if (alive) setManifestLoading(false) })
    return () => { alive = false }
  }, [config, templateVersionId])

  // manifest 更新后：补齐表格类型信息、清理无效绑定
  useEffect(() => {
    if (!manifest) return
    const placeholders = manifest.placeholders || []
    const tokenMap = new Map(placeholders.map((p) => [p.token, p]))
    setBindings((prev) => {
      const next = []
      placeholders.forEach((placeholder) => {
        const existing = prev.find(
          (b) => b.token === placeholder.token
            || (b.placeholder_id && String(b.placeholder_id) === String(placeholder.id)),
        )
        if (!existing) return
        next.push({
          ...existing,
          token: placeholder.token,
          placeholder_id: placeholder.id,
          type: placeholder.type,
        })
      })
      return next
    })
    // 保留 tokenMap 引用，避免 lint 误报
    void tokenMap
  }, [manifest])

  const templateVersions = templateDetail?.versions || []
  const placeholders = manifest?.placeholders || []
  const currentVersion = versions.find((v) => v.id === versionId)
  const requiredCount = placeholders.filter((p) => p.required).length
  const boundCount = bindings.filter((b) => b.source_key && b.path).length

  // ---------------- 绑定操作 ----------------
  const updateBinding = (placeholder, patch) => {
    setBindings((prev) => {
      const index = prev.findIndex((b) => b.token === placeholder.token)
      const base = index >= 0
        ? prev[index]
        : { token: placeholder.token, placeholder_id: placeholder.id, type: placeholder.type }
      const merged = { ...base, ...patch }
      if (index >= 0) {
        const next = [...prev]
        next[index] = merged
        return next
      }
      return [...prev, merged]
    })
    markDirty()
    setPreview(null)
  }

  const unbind = (placeholder) => {
    setBindings((prev) => prev.filter((b) => b.token !== placeholder.token))
    markDirty()
  }

  // AI 建议合并：按 token 覆盖已绑定项，未绑定的补一条
  const applyAiSuggestions = (suggestions) => {
    setBindings((prev) => {
      const next = [...prev]
      suggestions.forEach((suggestion) => {
        const placeholder = placeholders.find((p) => p.token === suggestion.token)
        if (!placeholder) return
        const index = next.findIndex((b) => b.token === suggestion.token)
        const base = index >= 0
          ? next[index]
          : { token: placeholder.token, placeholder_id: placeholder.id, type: placeholder.type }
        const merged = {
          ...base,
          placeholder_id: placeholder.id,
          token: placeholder.token,
          type: placeholder.type,
          source_key: suggestion.source_key,
          path: suggestion.path,
          on_missing: suggestion.on_missing || 'degrade_mark',
        }
        if (suggestion.transforms?.length) merged.transforms = suggestion.transforms
        else delete merged.transforms
        if (placeholder.type === 'table') merged.columns = suggestion.columns || {}
        if (index >= 0) next[index] = merged
        else next.push(merged)
      })
      return next
    })
    markDirty()
    setPreview(null)
    toast.success(`已应用 ${suggestions.length} 条 AI 映射建议，请检查后保存`)
  }

  // ---------------- 草稿 / 发布 ----------------
  const buildPayload = () => {
    let crossChecks
    try {
      crossChecks = parseJSON(crossChecksText, [])
      if (!Array.isArray(crossChecks)) throw new Error('交叉核对必须是数组')
    } catch (err) {
      throw new Error(`交叉核对 JSON 不合法：${err.message}`)
    }
    const cleaned = bindings
      .filter((b) => b.source_key && b.path)
      .map((b) => {
        const base = {
          placeholder_id: b.placeholder_id,
          token: b.token,
          source_key: b.source_key,
          path: b.path,
          on_missing: b.on_missing || 'degrade_mark',
        }
        if (b.transforms?.length) base.transforms = b.transforms
        if (b.type === 'table') {
          base.columns = b.columns || {}
          if (b.limit) base.limit = Number(b.limit)
        }
        return base
      })
    return {
      template_version_id: templateVersionId,
      params_schema: paramsSchema.map((p) => ({ ...p })),
      data_sources: dataSources,
      mapping: { bindings: cleaned, cross_checks: crossChecks },
      transform: { style_profile: styleProfile },
      degradation_policy: {},
      changelog: changelog || '',
    }
  }

  const saveDraft = async ({ silent = false } = {}) => {
    if (!templateVersionId) {
      toast.warning('请先选择模板版本')
      return null
    }
    setSaving(true)
    try {
      const payload = buildPayload()
      const version = await reportApi.configs.saveDraft(id, payload)
      setVersionId(version.id)
      setDirty(false)
      setChangelog('')
      const detail = await reportApi.configs.detail(id)
      setVersions(detail.versions || [])
      if (!silent) toast.success(`已保存草稿 v${version.version_no}`)
      return version
    } catch (err) {
      const issues = err.data?.extra?.issues || err.data?.issues || []
      if (issues.length) {
        toast.error(`${err.message}：${issues.slice(0, 3).map((i) => i.message).join('；')}`)
      } else {
        toast.error(err.message || '保存失败')
      }
      return null
    } finally {
      setSaving(false)
    }
  }

  const saveMeta = async () => {
    try {
      const updated = await reportApi.configs.update(id, meta)
      setConfig(updated)
      toast.success('基础信息已保存')
    } catch (err) {
      toast.error(err.message || '保存失败')
    }
  }

  const publish = async () => {
    let targetId = versionId
    if (dirty || !targetId) {
      const version = await saveDraft({ silent: true })
      if (!version) return
      targetId = version.id
    }
    setPublishing(true)
    try {
      await reportApi.configs.publishVersion(id, targetId)
      toast.success('配置已发布，可按定时或手动触发')
      await load()
    } catch (err) {
      const issues = err.data?.extra?.issues || err.data?.issues || []
      if (issues.length) {
        toast.error(`${err.message}：${issues.slice(0, 3).map((i) => i.message).join('；')}`)
      } else {
        toast.error(err.message || '发布失败')
      }
    } finally {
      setPublishing(false)
    }
  }

  // ---------------- 试跑 / 预览 ----------------
  const testSource = async (index) => {
    setTestBusy(true)
    setTestIndex(index)
    setTestResult(null)
    try {
      const res = await reportApi.configs.testSource(id, dataSources[index], sampleParams)
      setTestResult(res)
    } catch (err) {
      toast.error(err.message || '数据源测试失败')
    } finally {
      setTestBusy(false)
    }
  }

  const runPreview = async () => {
    let targetId = versionId
    if (dirty || !targetId) {
      const version = await saveDraft({ silent: true })
      if (!version) return
      targetId = version.id
    }
    setPreviewing(true)
    setPreview(null)
    try {
      const res = await reportApi.configs.preview(id, targetId, sampleParams)
      setPreview(res)
      const errors = (res.issues || []).filter((i) => (i.severity || 'error') === 'error')
      if (errors.length) toast.warning(`预览已生成，但有 ${errors.length} 项校验问题`)
      else toast.success('预览已生成，校验通过')
    } catch (err) {
      toast.error(err.message || '预览失败')
    } finally {
      setPreviewing(false)
    }
  }

  const runHealth = async (probe = false) => {
    let targetId = versionId
    if (dirty || !targetId) {
      const version = await saveDraft({ silent: true })
      if (!version) return
      targetId = version.id
    }
    setHealthProbing(probe)
    setHealthLoading(true)
    try {
      const res = probe
        ? await reportApi.configs.healthProbe(id, targetId, sampleParams)
        : await reportApi.configs.health(id, targetId)
      setHealth(res)
      if (res.ok) toast.success(probe ? '样例探针通过' : '健康检查通过')
      else toast.warning(`健康检查发现 ${res.summary?.error || 0} 项错误`)
    } catch (err) {
      toast.error(err.message || '健康检查失败')
    } finally {
      setHealthLoading(false)
    }
  }

  const runNow = async () => {
    const ok = await confirm({
      title: '立即运行报告',
      description: '将使用已发布配置采集数据并生成正式报告，生成后进入待审核状态。',
      confirmText: '运行',
    })
    if (!ok) return
    try {
      const run = await reportApi.runs.trigger({ config_id: id, params: sampleParams })
      toast.success(`已提交运行 #${run.id}`)
      navigate('/reports/runs')
    } catch (err) {
      toast.error(err.message || '触发运行失败')
    }
  }

  const canEdit = hasPermission('report', 'edit')

  if (!config) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">加载中...</p>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        title={config.name}
        actions={(
          <>
            <Button variant="ghost" onClick={() => navigate('/reports/configs')}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />返回
            </Button>
            {canEdit && (
              <Button variant="ghost" onClick={() => saveDraft()} loading={saving}>
                <Save className="mr-1 h-3.5 w-3.5" />保存草稿
              </Button>
            )}
            {canEdit && templateVersions.length > 1 && versionId && (
              <Button variant="ghost" onClick={() => setMigrationOpen(true)}>
                <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />迁移模板版本
              </Button>
            )}
            {hasPermission('report', 'execute') && config.status === 'published' && (
              <Button variant="ghost" onClick={runNow}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />立即运行
              </Button>
            )}
            {canEdit && hasPermission('report', 'publish') && (
              <Button variant="primary" onClick={publish} loading={publishing}>
                <Send className="mr-1 h-3.5 w-3.5" />发布配置
              </Button>
            )}
          </>
        )}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
              step === index
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/40'
            }`}
          >
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
              step === index ? 'bg-primary text-primary-foreground' : 'bg-muted'
            }`}
            >
              {index + 1}
            </span>
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {dirty && <Badge variant="warning">未保存</Badge>}
          {currentVersion && (
            <span>
              当前草稿 v{currentVersion.version_no}
              <StatusOf map={VERSION_STATUS} value={currentVersion.status} />
            </span>
          )}
          <span>必填 {requiredCount} / 已绑定 {boundCount}</span>
        </div>
      </div>

      {step === 0 && (
        <StepBase
          meta={meta}
          setMeta={setMeta}
          onSaveMeta={saveMeta}
          templateVersions={templateVersions}
          templateVersionId={templateVersionId}
          onTemplateVersionChange={(value) => { setTemplateVersionId(Number(value)); markDirty() }}
          manifest={manifest}
          manifestLoading={manifestLoading}
          paramsSchema={paramsSchema}
          setParamsSchema={(value) => { setParamsSchema(value); markDirty() }}
          sampleParams={sampleParams}
          setSampleParams={setSampleParams}
          styleProfile={styleProfile}
          setStyleProfile={(value) => { setStyleProfile(value); markDirty() }}
          changelog={changelog}
          setChangelog={setChangelog}
        />
      )}

      {step === 1 && (
        <StepSources
          dataSources={dataSources}
          setDataSources={(value) => { setDataSources(value); markDirty() }}
          onTest={testSource}
          testingIndex={testBusy ? testIndex : null}
        />
      )}

      {step === 2 && (
        <StepMapping
          manifest={manifest}
          loading={manifestLoading}
          bindings={bindings}
          updateBinding={updateBinding}
          unbind={unbind}
          dataSources={dataSources}
          crossChecksText={crossChecksText}
          setCrossChecksText={(value) => { setCrossChecksText(value); markDirty() }}
          onOpenAi={() => setAiMappingOpen(true)}
          aiDisabled={!versionId || !dataSources.length}
        />
      )}

      {step === 3 && (
        <StepPreview
          preview={preview}
          previewing={previewing}
          onPreview={runPreview}
          dirty={dirty}
          paramsSchema={paramsSchema}
          sampleParams={sampleParams}
          setSampleParams={setSampleParams}
          health={health}
          healthLoading={healthLoading}
          healthProbing={healthProbing}
          onHealth={runHealth}
          configId={id}
        />
      )}

      <Modal
        open={testResult !== null}
        title="数据源试跑结果"
        size="lg"
        onClose={() => { setTestResult(null); setTestIndex(null) }}
        footer={<Button onClick={() => { setTestResult(null); setTestIndex(null) }}>关闭</Button>}
      >
        {testResult && (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge color={testResult.ok ? 'success' : 'danger'} label={testResult.ok ? '成功' : '失败'} />
              <span>耗时 {testResult.latency_ms} ms · 尝试 {testResult.attempts} 次</span>
              {testResult.status_code && <span>HTTP {testResult.status_code}</span>}
              <span className="font-mono text-muted-foreground">{testResult.source_key}</span>
            </div>
            {testResult.error_message && (
              <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                {testResult.error_code}: {testResult.error_message}
              </p>
            )}
            <pre className="max-h-80 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
              {JSON.stringify(testResult.data ?? testResult.data_preview ?? null, null, 2)}
            </pre>
            {testResult.truncated && <p className="text-warning">响应过大，已截断展示。</p>}
          </div>
        )}
      </Modal>
      <Modal
        open={aiMappingOpen}
        title="AI 映射建议"
        size="xl"
        onClose={() => setAiMappingOpen(false)}
      >
        {aiMappingOpen && (
          <AiMappingWizard
            configId={id}
            versionId={versionId}
            params={sampleParams}
            onApply={(suggestions) => {
              applyAiSuggestions(suggestions)
              setAiMappingOpen(false)
            }}
            onClose={() => setAiMappingOpen(false)}
          />
        )}
      </Modal>
      <Modal
        open={migrationOpen}
        title="模板版本迁移向导"
        size="xl"
        onClose={() => setMigrationOpen(false)}
      >
        {migrationOpen && (
          <MigrationWizard
            configId={id}
            baseVersionId={versionId}
            templateVersions={templateVersions}
            currentTemplateVersionId={templateVersionId}
            onClose={() => setMigrationOpen(false)}
            onMigrated={async () => {
              setMigrationOpen(false)
              await load()
              toast.success('已生成迁移草稿，请检查映射后发布')
            }}
          />
        )}
      </Modal>
    </PageContainer>
  )
}

// --------------------------------------------------------------------------- //
// 模板版本迁移向导：预检差异 → 处理 token 改名 → 生成新配置草稿
// --------------------------------------------------------------------------- //
function MigrationWizard({
  configId, baseVersionId, templateVersions, currentTemplateVersionId, onClose, onMigrated,
}) {
  const targets = templateVersions.filter((v) => v.id !== currentTemplateVersionId)
  const defaultTarget = (
    targets.find((v) => v.status === 'published') || targets[0]
  )?.id || ''
  const [targetId, setTargetId] = useState(defaultTarget)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [renames, setRenames] = useState({})
  const [changelog, setChangelog] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!targetId) return undefined
    let alive = true
    setLoading(true)
    setPreview(null)
    setRenames({})
    reportApi.configs.migrationPreview(configId, targetId, baseVersionId)
      .then((res) => {
        if (!alive) return
        setPreview(res)
        // 高置信度候选自动预选，低置信度交给用户确认
        const preset = {}
        ;(res.removed || []).forEach((item) => {
          const top = item.candidates?.[0]
          if (top && top.score >= 0.8) preset[item.token] = top.token
        })
        setRenames(preset)
      })
      .catch((err) => {
        if (alive) toast.error(err.message || '迁移预检失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [configId, targetId, baseVersionId])

  const renamedTo = Object.values(renames).filter(Boolean)
  const remainingRequired = (preview?.unbound_required || []).filter(
    (token) => !renamedTo.includes(token),
  )
  const diff = preview?.diff || {}
  const targetVersion = templateVersions.find((v) => v.id === targetId)

  const submit = async () => {
    if (!preview) return
    setSubmitting(true)
    try {
      const version = await reportApi.configs.migrate(configId, {
        target_template_version_id: targetId,
        base_version_id: baseVersionId,
        renames,
        changelog,
      })
      toast.success(`已生成迁移草稿 v${version.version_no}`)
      onMigrated?.(version)
    } catch (err) {
      const issues = err.data?.extra?.issues || err.data?.issues || []
      if (issues.length) {
        toast.error(`${err.message}：${issues.slice(0, 3).map((i) => i.message).join('；')}`)
      } else {
        toast.error(err.message || '迁移失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4 text-xs">
      <Field label="目标模板版本" required hint="迁移会保留数据源、运行参数与版式，仅调整占位符绑定">
        <CompactSelect block value={targetId} onChange={(e) => setTargetId(Number(e.target.value))}>
          <option value="">请选择目标版本</option>
          {targets.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version_no} · {VERSION_STATUS[v.status]?.label || v.status}
            </option>
          ))}
        </CompactSelect>
      </Field>

      {!targets.length && (
        <EmptyState title="没有其他模板版本" description="请先在模板库上传并发布新版本" bordered />
      )}

      {loading && <p className="text-muted-foreground">正在对比模板差异...</p>}

      {!loading && preview && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">
              v{preview.from_template_version_no} → v{preview.to_template_version_no}
            </Badge>
            <span className="text-muted-foreground">保留绑定 {preview.kept_count} 个</span>
            <span className="text-muted-foreground">移除 {preview.removed.length} 个</span>
            <span className="text-muted-foreground">新增 {preview.added.length} 个</span>
            <span className="text-muted-foreground">数据源 {preview.data_source_count} 个（保留）</span>
            {targetVersion?.status === 'draft' && (
              <Badge variant="warning">目标模板版本尚未发布</Badge>
            )}
          </div>

          <div className="rounded border border-border bg-muted/30 p-2">
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">新增占位符</span>
              <span className="text-success">{diff.added?.length ? diff.added.join('、') : '无'}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">移除占位符</span>
              <span className="text-destructive">{diff.removed?.length ? diff.removed.join('、') : '无'}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">变更占位符</span>
              <span className="text-warning">
                {(diff.changed || []).length
                  ? diff.changed.map((c) => `${c.token}（${c.fields.join(', ')}）`).join('、')
                  : '无'}
              </span>
            </div>
            {diff.breaking && (
              <p className="mt-1 text-destructive">存在破坏性变更，请确认改名映射后再迁移。</p>
            )}
          </div>

          {preview.removed.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-foreground">已移除占位符的绑定处理</p>
              <div className="space-y-2">
                {preview.removed.map((item) => (
                  <div key={item.token} className="grid grid-cols-12 items-center gap-2">
                    <div className="col-span-5 min-w-0">
                      <div className="truncate font-mono text-foreground">{item.token}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.label} · 来源 {item.binding?.source_key || '—'} · {item.binding?.path || '—'}
                      </div>
                    </div>
                    <div className="col-span-2 text-center text-muted-foreground">迁移到</div>
                    <div className="col-span-5">
                      <CompactSelect
                        block
                        value={renames[item.token] || ''}
                        onChange={(e) => setRenames({ ...renames, [item.token]: e.target.value })}
                      >
                        <option value="">不迁移（丢弃该绑定）</option>
                        {(item.candidates || []).map((candidate) => (
                          <option
                            key={candidate.token}
                            value={candidate.token}
                            disabled={renamedTo.includes(candidate.token)
                              && renames[item.token] !== candidate.token}
                          >
                            {candidate.token} · {candidate.label}（{Math.round(candidate.score * 100)}%）
                          </option>
                        ))}
                        {(item.candidates || []).length === 0 && (
                          <option value="" disabled>无相似的新占位符</option>
                        )}
                      </CompactSelect>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.added.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-foreground">新增占位符</p>
              <div className="flex flex-wrap gap-1">
                {preview.added.map((item) => (
                  <Badge key={item.token} variant={item.required ? 'warning' : 'neutral'}>
                    {item.token}{item.required ? ' · 必填' : ''}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {remainingRequired.length > 0 && (
            <p className="rounded border border-warning/30 bg-warning/10 p-2 text-warning">
              仍有 {remainingRequired.length} 个必填占位符未绑定：{remainingRequired.join('、')}。
              迁移草稿可以保存，但发布前必须在「数据映射」中补齐。
            </p>
          )}

          <Field label="变更说明">
            <input
              className={inputCls}
              value={changelog}
              placeholder={`模板迁移：v${preview.from_template_version_no} → v${preview.to_template_version_no}`}
              onChange={(e) => setChangelog(e.target.value)}
            />
          </Field>
        </>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          loading={submitting}
          disabled={!preview || loading}
          onClick={submit}
        >
          生成迁移草稿
        </Button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// AI 映射建议：采集样例 → AI 给出绑定建议 → 人工确认后合并到当前草稿
// --------------------------------------------------------------------------- //
function AiMappingWizard({ configId, versionId, params, onApply, onClose }) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    reportApi.configs.aiMappingSuggest(configId, { version_id: versionId, params })
      .then((res) => { if (alive) setResult(res) })
      .catch((err) => { if (alive) setError(err.message || 'AI 建议生成失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // 参数只在打开时取一次，输入预览参数不应重复触发采集
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, versionId])

  const suggestions = result?.suggestions || []
  const warnings = result?.warnings || []
  const stats = result?.stats || {}

  return (
    <div className="space-y-3 text-xs">
      <p className="rounded border border-border bg-muted/30 p-2 text-muted-foreground">
        将按当前已保存的配置版本采集一次数据样例，再由 AI 给出绑定建议（不会写入配置）。
        应用后请核对路径与列映射，再保存草稿。
      </p>

      {loading && <p className="text-muted-foreground">正在采集样例并生成建议，请稍候...</p>}
      {error && (
        <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">{error}</p>
      )}

      {!loading && result && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">{result.model || 'AI'}</Badge>
            <span className="text-muted-foreground">建议 {suggestions.length} 条</span>
            <span className="text-muted-foreground">
              覆盖 {stats.covered || 0} / {stats.total || 0} 个占位符
            </span>
          </div>

          {warnings.length > 0 && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-warning">
              {warnings.map((warning, index) => <div key={index}>{warning}</div>)}
            </div>
          )}

          {(stats.uncovered || []).length > 0 && (
            <p className="text-muted-foreground">未覆盖：{stats.uncovered.join('、')}</p>
          )}

          <div className="max-h-80 overflow-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">占位符</th>
                  <th className="px-2 py-1.5">数据源</th>
                  <th className="px-2 py-1.5">路径 / 列映射</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((item) => (
                  <tr key={item.token} className="border-t border-border/60 align-top">
                    <td className="px-2 py-1.5 font-mono text-foreground">{item.token}</td>
                    <td className="px-2 py-1.5">{item.source_key}</td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">
                      {item.columns
                        ? Object.entries(item.columns)
                          .map(([key, column]) => `${key}: ${column.path}`)
                          .join(' | ')
                        : item.path}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!suggestions.length && (
              <p className="p-3 text-muted-foreground">AI 未给出可用建议，请检查数据源样例或手动配置。</p>
            )}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>关闭</Button>
        <Button
          variant="primary"
          disabled={!suggestions.length || loading}
          onClick={() => onApply(suggestions)}
        >
          应用全部建议
        </Button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// JSON 文本域：输入期间不改父状态，失焦时校验并提交，避免格式化打断输入
// --------------------------------------------------------------------------- //
function JsonTextarea({ value, onCommit }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [error, setError] = useState('')

  useEffect(() => {
    setText(JSON.stringify(value ?? {}, null, 2))
    setError('')
  }, [value])

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(text || '{}')
      setError('')
      onCommit(parsed)
    } catch (err) {
      setError(`JSON 不合法：${err.message}`)
    }
  }

  return (
    <div>
      <textarea
        className={`${monoCls} min-h-[80px]`}
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Step 1 基础与参数
// --------------------------------------------------------------------------- //
function StepBase({
  meta, setMeta, onSaveMeta, templateVersions, templateVersionId, onTemplateVersionChange,
  manifest, manifestLoading, paramsSchema, setParamsSchema, sampleParams, setSampleParams,
  styleProfile, setStyleProfile, changelog, setChangelog,
}) {
  const setParam = (index, patch) => {
    const next = [...paramsSchema]
    next[index] = { ...next[index], ...patch }
    setParamsSchema(next)
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="基础信息" description="配置名称、定时策略与输出文件名（不随版本变化）">
        <div className="space-y-3">
          <Field label="配置名称" required>
            <input className={inputCls} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          </Field>
          <Field label="描述">
            <textarea className={inputCls} rows={2} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="定时 cron" hint="5 段表达式，如 0 8 * * 1（每周一 08:00）；留空=仅手动">
              <input className={monoCls} value={meta.schedule_cron} placeholder="0 8 * * 1" onChange={(e) => setMeta({ ...meta, schedule_cron: e.target.value })} />
            </Field>
            <Field label="输出文件名" hint="支持 {template}/{config}/{run_id}/{date}">
              <input className={monoCls} value={meta.output_name_pattern} placeholder="{template}_{date}.docx" onChange={(e) => setMeta({ ...meta, output_name_pattern: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" onClick={onSaveMeta}>保存基础信息</Button>
          </div>
        </div>
      </Card>

      <Card title="模板版本与版式" description="配置绑定具体模板版本；模板升级后需新建配置版本">
        <div className="space-y-3">
          <Field label="模板版本" required>
            <CompactSelect block value={templateVersionId || ''} onChange={(e) => onTemplateVersionChange(e.target.value)}>
              <option value="">请选择版本</option>
              {templateVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version_no} · {VERSION_STATUS[v.status]?.label || v.status}
                </option>
              ))}
            </CompactSelect>
          </Field>
          <Field label="版式配置" hint="keep=保留模板原版式；gb9704=按党政机关公文版式重排">
            <CompactSelect block value={styleProfile} onChange={(e) => setStyleProfile(e.target.value)}>
              <option value="keep">保留模板版式</option>
              <option value="gb9704">GB/T 9704 公文版式</option>
            </CompactSelect>
          </Field>
          <Field label="变更说明" hint="记录在本配置版本上，便于回溯">
            <input className={inputCls} value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="如：新增漏洞统计采集源" />
          </Field>
          <div className="rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            {manifestLoading && '正在解析模板清单...'}
            {!manifestLoading && manifest && (
              <span>
                模板版本含 {manifest.placeholders?.length || 0} 个占位符、
                {manifest.sections?.length || 0} 个章节、{manifest.tables?.length || 0} 个表格。
              </span>
            )}
            {!manifestLoading && !manifest && '请选择模板版本'}
          </div>
        </div>
      </Card>

      <Card
        title="运行参数"
        description="触发运行时填写的参数，可在数据源请求参数中用 {{params.xxx}} 引用"
        className="lg:col-span-2"
        actions={<Button size="sm" variant="ghost" onClick={() => setParamsSchema([...paramsSchema, { name: '', label: '', type: 'string', required: true }])}><Plus className="mr-1 h-3.5 w-3.5" />添加参数</Button>}
      >
        {!paramsSchema.length && <EmptyState title="未定义运行参数" description="如报告周期 period、开始/结束日期等" bordered />}
        <div className="space-y-2">
          {paramsSchema.map((param, index) => (
            <div key={index} className="grid grid-cols-12 items-center gap-2">
              <input className={`${monoCls} col-span-3`} placeholder="name" value={param.name || ''} onChange={(e) => setParam(index, { name: e.target.value })} />
              <input className={`${inputCls} col-span-3`} placeholder="显示名" value={param.label || ''} onChange={(e) => setParam(index, { label: e.target.value })} />
              <div className="col-span-2">
                <CompactSelect block value={param.type || 'string'} onChange={(e) => setParam(index, { type: e.target.value })}>
                  <option value="string">文本</option>
                  <option value="number">数字</option>
                  <option value="date">日期</option>
                </CompactSelect>
              </div>
              <label className="col-span-2 flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={!!param.required} onChange={(e) => setParam(index, { required: e.target.checked })} />
                必填
              </label>
              <input
                className={`${inputCls} col-span-2`}
                placeholder="预览值"
                value={sampleParams[param.name] ?? ''}
                onChange={(e) => setSampleParams({ ...sampleParams, [param.name]: e.target.value })}
              />
              <div className="col-span-12 flex justify-end sm:col-span-12">
                <Button size="sm" variant="ghost" onClick={() => setParamsSchema(paramsSchema.filter((_, i) => i !== index))}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Step 2 数据采集
// --------------------------------------------------------------------------- //
function StepSources({ dataSources, setDataSources, onTest, testingIndex }) {
  const [deviceList, setDeviceList] = useState([])
  const [toolList, setToolList] = useState([])
  const [actionsMap, setActionsMap] = useState({})
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    devices.list().then((res) => setDeviceList(Array.isArray(res) ? res : res.items || [])).catch(() => {})
    tools.list().then((res) => setToolList(Array.isArray(res) ? res : res.items || [])).catch(() => {})
  }, [])

  const loadActions = async (deviceId) => {
    if (!deviceId || actionsMap[deviceId]) return
    try {
      const res = await devices.listActions(deviceId)
      setActionsMap((prev) => ({ ...prev, [deviceId]: Array.isArray(res) ? res : res.items || [] }))
    } catch {
      setActionsMap((prev) => ({ ...prev, [deviceId]: [] }))
    }
  }

  const update = (index, patch) => {
    const next = [...dataSources]
    next[index] = { ...next[index], ...patch }
    setDataSources(next)
  }

  const addSource = () => {
    const key = `source_${dataSources.length + 1}`
    setDataSources([...dataSources, {
      source_key: key,
      source_type: 'device_action',
      device_id: null,
      action_id: null,
      params: {},
      timeout_seconds: 30,
      retry: { max_attempts: 2 },
      on_error: 'degrade_mark',
    }])
    setExpanded({ ...expanded, [dataSources.length]: true })
  }

  return (
    <Card
      title="数据采集配置"
      description="每个数据源对应一个设备动作、HTTP 工具或静态数据；采集并发执行，失败按 on_error 策略降级。"
      actions={<Button size="sm" variant="primary" onClick={addSource}><Plus className="mr-1 h-3.5 w-3.5" />添加数据源</Button>}
    >
      {!dataSources.length && (
        <EmptyState title="尚未配置数据源" description="至少添加一个数据源后才能完成映射与预览" bordered />
      )}
      <div className="space-y-3">
        {dataSources.map((source, index) => {
          const open = expanded[index] ?? true
          return (
            <div key={index} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-3 py-2">
                <button type="button" className="flex items-center gap-1 text-sm font-medium" onClick={() => setExpanded({ ...expanded, [index]: !open })}>
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-mono">{source.source_key || `source_${index + 1}`}</span>
                </button>
                <Badge variant="info">{source.source_type}</Badge>
                {source.device_id && <span className="text-xs text-muted-foreground">设备 #{source.device_id}</span>}
                {source.action_id && <span className="text-xs text-muted-foreground">动作 #{source.action_id}</span>}
                {source.tool_id && <span className="text-xs text-muted-foreground">工具 #{source.tool_id}</span>}
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onTest(index)} loading={testingIndex === index}>
                    <Beaker className="mr-1 h-3.5 w-3.5" />试跑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDataSources(dataSources.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
              {open && (
                <div className="grid gap-3 p-3 sm:grid-cols-3">
                  <Field label="数据源标识" required hint="映射绑定按此标识引用，如 xdr_alerts">
                    <input className={monoCls} value={source.source_key || ''} onChange={(e) => update(index, { source_key: e.target.value })} />
                  </Field>
                  <Field label="类型" required>
                    <CompactSelect
                      block
                      value={source.source_type}
                      onChange={(e) => update(index, { source_type: e.target.value, device_id: null, action_id: null, tool_id: null })}
                    >
                      <option value="device_action">设备动作</option>
                      <option value="http_tool">HTTP 工具</option>
                      <option value="static">静态数据</option>
                    </CompactSelect>
                  </Field>
                  <Field label="失败策略">
                    <CompactSelect block value={source.on_error || 'degrade_mark'} onChange={(e) => update(index, { on_error: e.target.value })}>
                      {DEGRADE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </CompactSelect>
                  </Field>

                  {source.source_type === 'device_action' && (
                    <>
                      <Field label="设备" required>
                        <CompactSelect
                          block
                          value={source.device_id || ''}
                          onChange={(e) => {
                            const deviceId = Number(e.target.value) || null
                            update(index, { device_id: deviceId, action_id: null })
                            loadActions(deviceId)
                          }}
                        >
                          <option value="">请选择设备</option>
                          {deviceList.map((d) => <option key={d.id} value={d.id}>{d.name}（{d.device_type || d.type}）</option>)}
                        </CompactSelect>
                      </Field>
                      <Field label="设备动作" required>
                        <CompactSelect block value={source.action_id || ''} onChange={(e) => update(index, { action_id: Number(e.target.value) || null })}>
                          <option value="">请选择动作</option>
                          {(actionsMap[source.device_id] || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </CompactSelect>
                      </Field>
                    </>
                  )}

                  {source.source_type === 'http_tool' && (
                    <Field label="HTTP 工具" required>
                      <CompactSelect block value={source.tool_id || ''} onChange={(e) => update(index, { tool_id: Number(e.target.value) || null })}>
                        <option value="">请选择工具</option>
                        {toolList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </CompactSelect>
                    </Field>
                  )}

                  <Field label="超时（秒）">
                    <input
                      type="number"
                      min={1}
                      className={inputCls}
                      value={source.timeout_seconds || 30}
                      onChange={(e) => update(index, { timeout_seconds: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="最大尝试次数" hint="仅超时/5xx/限流等可重试错误会重试">
                    <input
                      type="number"
                      min={1}
                      max={5}
                      className={inputCls}
                      value={source.retry?.max_attempts || 1}
                      onChange={(e) => update(index, { retry: { max_attempts: Number(e.target.value) } })}
                    />
                  </Field>

                  <div className="sm:col-span-3">
                    <Field label={source.source_type === 'static' ? '静态数据（JSON）' : '请求参数（JSON）'} hint="支持 {{params.period}}、{{run.xxx}} 占位；static 使用 payload 字段">
                      <JsonTextarea
                        value={source.source_type === 'static' ? (source.payload ?? {}) : (source.params ?? {})}
                        onCommit={(parsed) => update(index, source.source_type === 'static' ? { payload: parsed } : { params: parsed })}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// --------------------------------------------------------------------------- //
// Step 3 数据映射
// --------------------------------------------------------------------------- //
function StepMapping({
  manifest, loading, bindings, updateBinding, unbind, dataSources,
  crossChecksText, setCrossChecksText, onOpenAi, aiDisabled,
}) {
  const placeholders = manifest?.placeholders || []
  const sourceOptions = dataSources.map((s) => s.source_key).filter(Boolean)

  if (loading) return <Card><p className="text-sm text-muted-foreground">正在解析模板占位符...</p></Card>
  if (!placeholders.length) {
    return <Card><EmptyState title="模板未解析到占位符" description="请检查 docx 模板中的 {{ token }} / {%tr for ... %} 语法" bordered /></Card>
  }

  return (
    <div className="space-y-4">
      <Card
        title="占位符映射"
        description="标量填字段路径（JSONPath，如 $.data.total）；表格绑定需为每个列指定行内字段路径。"
        actions={(
          <Button size="sm" variant="ghost" disabled={aiDisabled} onClick={onOpenAi}>
            <Sparkles className="mr-1 h-3.5 w-3.5" />AI 建议映射
          </Button>
        )}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-3">占位符</th>
                <th className="py-2 pr-3">数据源</th>
                <th className="py-2 pr-3">字段路径</th>
                <th className="py-2 pr-3">缺失策略 / 转换</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {placeholders.map((placeholder) => {
                const binding = bindingOf(bindings, placeholder.token)
                const isTable = placeholder.type === 'table'
                return (
                  <tr key={placeholder.id || placeholder.token} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-mono text-foreground">{placeholder.token}</div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Badge variant={isTable ? 'info' : 'neutral'}>{placeholder.type}</Badge>
                        {placeholder.required && <Badge variant="warning">必填</Badge>}
                      </div>
                    </td>
                    <td className="py-2 pr-3" style={{ minWidth: 140 }}>
                      <CompactSelect
                        block
                        value={binding?.source_key || ''}
                        onChange={(e) => updateBinding(placeholder, { source_key: e.target.value })}
                      >
                        <option value="">未绑定</option>
                        {sourceOptions.map((key) => <option key={key} value={key}>{key}</option>)}
                      </CompactSelect>
                    </td>
                    <td className="py-2 pr-3" style={{ minWidth: 200 }}>
                      {isTable ? (
                        <div className="space-y-1">
                          {(placeholder.columns || []).map((col) => (
                            <div key={col.key} className="flex items-center gap-1">
                              <span className="w-24 shrink-0 truncate text-muted-foreground" title={col.label || col.key}>
                                {col.label || col.key}
                              </span>
                              <input
                                className={monoCls}
                                placeholder={`$.items[*].${col.key}`}
                                value={binding?.columns?.[col.key]?.path || ''}
                                onChange={(e) => updateBinding(placeholder, {
                                  columns: {
                                    ...(binding?.columns || {}),
                                    [col.key]: { ...(binding?.columns?.[col.key] || {}), path: e.target.value },
                                  },
                                })}
                              />
                            </div>
                          ))}
                          {(placeholder.columns || []).length === 0 && (
                            <span className="text-warning">模板表格未识别到列，请使用循环首行的表头占位符</span>
                          )}
                        </div>
                      ) : (
                        <input
                          className={monoCls}
                          placeholder="$.data.total"
                          value={binding?.path || ''}
                          onChange={(e) => updateBinding(placeholder, { path: e.target.value })}
                        />
                      )}
                      {isTable && (
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            className={monoCls}
                            style={{ width: 90 }}
                            placeholder="行上限"
                            value={binding?.limit || ''}
                            onChange={(e) => updateBinding(placeholder, { limit: e.target.value })}
                          />
                          <input
                            className={monoCls}
                            placeholder="根路径 $.data.items"
                            value={binding?.path || ''}
                            onChange={(e) => updateBinding(placeholder, { path: e.target.value })}
                          />
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3" style={{ minWidth: 180 }}>
                      <CompactSelect
                        block
                        value={binding?.on_missing || 'degrade_mark'}
                        onChange={(e) => updateBinding(placeholder, { on_missing: e.target.value })}
                      >
                        {DEGRADE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </CompactSelect>
                      {!isTable && (
                        <input
                          className={`${monoCls} mt-1`}
                          placeholder="转换，逗号分隔：to_int,date_format"
                          value={(binding?.transforms || []).map((t) => t.op).join(',')}
                          onChange={(e) => {
                            const ops = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                            updateBinding(placeholder, {
                              transforms: ops.map((op) => (
                                binding?.transforms?.find((t) => t.op === op) || { op }
                              )),
                            })
                          }}
                        />
                      )}
                      {!isTable && (binding?.transforms || []).some((t) => !TRANSFORM_OPS.includes(t.op)) && (
                        <p className="mt-1 text-xs text-warning">存在未支持的转换算子，发布前会被拦截</p>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {binding && (
                        <Button size="sm" variant="ghost" onClick={() => unbind(placeholder)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="交叉核对规则"
        description={'渲染前对上下文做一致性校验，示例：[{"type":"sum_equals","detail":"table.vuln","item_field":"count","summary":"summary.vuln_total"}]'}
      >
        <textarea
          className={`${monoCls} min-h-[120px]`}
          rows={6}
          value={crossChecksText}
          onChange={(e) => setCrossChecksText(e.target.value)}
        />
      </Card>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Step 4 预览与发布
// --------------------------------------------------------------------------- //
function StepPreview({
  preview, previewing, onPreview, dirty, paramsSchema, sampleParams, setSampleParams,
  health, healthLoading, healthProbing, onHealth, configId,
}) {
  const issues = preview?.issues || []
  const errors = issues.filter((i) => (i.severity || 'error') === 'error')
  return (
    <div className="space-y-4">
      <Card
        title="试运行与预览"
        description="使用真实数据源采集并渲染一份预览 docx（不生成正式产物、不写运行记录）。"
        actions={(
          <Button variant="primary" onClick={onPreview} loading={previewing}>
            <Eye className="mr-1 h-3.5 w-3.5" />生成预览
          </Button>
        )}
      >
        {!!paramsSchema.length && (
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {paramsSchema.map((param) => (
              <Field key={param.name} label={param.label || param.name} required={param.required}>
                <input
                  className={inputCls}
                  value={sampleParams[param.name] ?? ''}
                  onChange={(e) => setSampleParams({ ...sampleParams, [param.name]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        )}
        {dirty && (
          <p className="mb-2 text-xs text-warning">当前有未保存修改，生成预览会先自动保存一个配置草稿版本。</p>
        )}
        {!preview && !previewing && (
          <EmptyState title="尚未生成预览" description="点击「生成预览」验证采集与映射是否可用" bordered />
        )}
        {preview && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge color={errors.length ? 'danger' : 'success'} label={errors.length ? `${errors.length} 项错误` : '校验通过'} />
              <span className="text-muted-foreground">配置版本 v{preview.config_version_no}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => reportApi.configs.downloadPreview(preview.config_id, preview.preview_id).catch((e) => toast.error(e.message))}
              >
                下载预览 docx
              </Button>
            </div>
            <IssueList issues={issues} />
            <div>
              <p className="mb-1 font-medium text-foreground">PDF 保真预览</p>
              <PdfPreviewPanel
                load={() => reportApi.configs.previewPdf(configId, preview.preview_id)}
                filename="preview.pdf"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="mb-1 font-medium text-foreground">数据源结果</p>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
                  {JSON.stringify(preview.sources || {}, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-medium text-foreground">渲染上下文</p>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
                  {JSON.stringify(preview.context || {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="配置健康检查"
        description="只读校验模板版本、占位符绑定、数据源、cron、表格列与最近运行；样例探针会真实采集一次并校验映射命中。"
        actions={(
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={healthLoading && !healthProbing}
              onClick={() => onHealth(false)}
            >
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />运行健康检查
            </Button>
            {hasPermission('report', 'execute') && (
              <Button
                variant="primary"
                size="sm"
                loading={healthLoading && healthProbing}
                onClick={() => onHealth(true)}
              >
                <Beaker className="mr-1 h-3.5 w-3.5" />样例探针
              </Button>
            )}
          </div>
        )}
      >
        {health ? (
          <HealthPanel health={health} />
        ) : (
          <EmptyState
            title="尚未检查"
            description="运行健康检查可在发布前发现未绑定占位符、数据源缺失与映射路径问题"
            bordered
          />
        )}
      </Card>
    </div>
  )
}

const HEALTH_STATUS = {
  pass: { color: 'success', label: '通过' },
  info: { color: 'neutral', label: '提示' },
  warning: { color: 'warning', label: '警告' },
  error: { color: 'danger', label: '错误' },
}

const HEALTH_LEVEL = {
  ok: { color: 'success', label: '健康' },
  warning: { color: 'warning', label: '需关注' },
  error: { color: 'danger', label: '存在错误' },
}

function HealthPanel({ health }) {
  const level = HEALTH_LEVEL[health.level] || HEALTH_LEVEL.warning
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge color={level.color} label={level.label} />
        <span className="text-muted-foreground">
          通过 {health.summary?.pass || 0} · 提示 {health.summary?.info || 0} ·
          警告 {health.summary?.warning || 0} · 错误 {health.summary?.error || 0}
        </span>
        {health.version_no && (
          <span className="text-muted-foreground">配置版本 v{health.version_no}</span>
        )}
      </div>
      <ul className="space-y-1">
        {(health.checks || []).map((check) => {
          const meta = HEALTH_STATUS[check.status] || HEALTH_STATUS.info
          const hasDetails = check.details && Object.keys(check.details).length > 0
          return (
            <li key={check.key} className="rounded border border-border px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge color={meta.color} label={meta.label} />
                <span className="font-medium text-foreground">{check.title}</span>
                <span className="text-muted-foreground">{check.message}</span>
              </div>
              {hasDetails && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    查看详情
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs">
                    {JSON.stringify(check.details, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          )
        })}
      </ul>
      {health.probe && (
        <div>
          <p className="mb-1 font-medium text-foreground">样例探针结果</p>
          <pre className="max-h-48 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs">
            {JSON.stringify({
              sources: health.probe.sources,
              issues: health.probe.issues,
              context_keys: health.probe.context_keys,
            }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
