// 报告模板库：模板 CRUD、docx 版本上传、manifest 解析查看、版本发布与差异对比
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Plus, RefreshCw, Search, Sparkles, Upload } from 'lucide-react'
import { reportApi } from '../../api/reports'
import {
  Badge, Button, Card, CompactSelect, DataTable, EmptyState, PageContainer, PageHeader, Pagination, SearchInput,
} from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import {
  Field, PdfPreviewPanel, TEMPLATE_STATUS, VERSION_STATUS, StatusOf, fmtTime, inputCls,
} from './shared'

const PAGE_SIZE = 20
const canEdit = () => hasPermission('report', 'edit')
const canPublish = () => hasPermission('report', 'publish')

export default function ReportTemplates() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', category: '', description: '' })
  const [creating, setCreating] = useState(false)

  const [aiOpen, setAiOpen] = useState(false)
  const [aiForm, setAiForm] = useState({ code: '', name: '', category: '', title: '', description: '' })
  const [aiGenerating, setAiGenerating] = useState(false)

  const [fromOpen, setFromOpen] = useState(false)
  const [fromFile, setFromFile] = useState(null)
  const [fromForm, setFromForm] = useState({ code: '', name: '', category: '', hint: '' })
  const [fromLoading, setFromLoading] = useState(false)
  const [fromResult, setFromResult] = useState(null)

  const [detailId, setDetailId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await reportApi.templates.list({
        keyword, status, page, page_size: pageSize,
      })
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message || '模板列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [keyword, status, page, pageSize])

  useEffect(() => { load() }, [load])

  const submitCreate = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.warning('模板编码与名称不能为空')
      return
    }
    setCreating(true)
    try {
      const created = await reportApi.templates.create(form)
      toast.success('模板已创建，请上传 docx 模板文件')
      setCreateOpen(false)
      setForm({ code: '', name: '', category: '', description: '' })
      await load()
      setDetailId(created.id)
    } catch (err) {
      toast.error(err.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const submitAi = async () => {
    if (!aiForm.code.trim() || !aiForm.name.trim() || !aiForm.description.trim()) {
      toast.warning('模板编码、名称与需求描述不能为空')
      return
    }
    setAiGenerating(true)
    try {
      const res = await reportApi.templates.aiDraft(aiForm)
      const count = res.version?.manifest?.placeholders?.length || 0
      toast.success(`AI 已生成模板草稿 v${res.version?.version_no}，共 ${count} 个占位符，确认后再发布`)
      setAiOpen(false)
      setAiForm({ code: '', name: '', category: '', title: '', description: '' })
      await load()
      setDetailId(res.template?.id)
    } catch (err) {
      toast.error(err.message || 'AI 生成失败')
    } finally {
      setAiGenerating(false)
    }
  }

  const closeFromReport = () => {
    setFromOpen(false)
    setFromFile(null)
    setFromForm({ code: '', name: '', category: '', hint: '' })
    setFromResult(null)
  }

  const submitFromReport = async () => {
    if (!fromFile) {
      toast.warning('请选择现有报告 .docx 文件')
      return
    }
    if (!fromForm.code.trim() || !fromForm.name.trim()) {
      toast.warning('模板编码与名称不能为空')
      return
    }
    setFromLoading(true)
    try {
      const res = await reportApi.templates.fromReport(fromFile, fromForm)
      const count = res.manifest?.placeholders?.length || 0
      toast.success(`已生成模板草稿 v${res.version?.version_no}，共 ${count} 个占位符，请确认后发布`)
      setFromResult(res)
      await load()
    } catch (err) {
      toast.error(err.message || '生成失败')
    } finally {
      setFromLoading(false)
    }
  }

  const columns = useMemo(() => [
    {
      key: 'name',
      header: '模板名称',
      width: '26%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{row.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{row.code}</div>
        </div>
      ),
    },
    {
      key: 'category',
      header: '分类',
      width: '12%',
      render: (row) => row.category || '—',
    },
    {
      key: 'status',
      header: '状态',
      width: '10%',
      render: (row) => <StatusOf map={TEMPLATE_STATUS} value={row.status} />,
    },
    {
      key: 'version',
      header: '当前版本',
      width: '10%',
      render: (row) => (row.current_version_id ? `#${row.current_version_id}` : '未发布'),
    },
    {
      key: 'updated_at',
      header: '更新时间',
      width: '16%',
      render: (row) => fmtTime(row.updated_at),
    },
    {
      key: 'actions',
      header: '操作',
      width: '10%',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); setDetailId(row.id) }}
        >
          详情
        </Button>
      ),
    },
  ], [])

  return (
    <PageContainer>
      <PageHeader
        title="报告模板库"
        actions={(
          <>
            <Button variant="ghost" onClick={load} loading={loading}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />刷新
            </Button>
            {canEdit() && (
              <Button variant="ghost" onClick={() => setFromOpen(true)}>
                <Upload className="mr-1 h-4 w-4" />从现有报告生成
              </Button>
            )}
            {canEdit() && (
              <Button variant="ghost" onClick={() => setAiOpen(true)}>
                <Sparkles className="mr-1 h-4 w-4" />AI 生成模板
              </Button>
            )}
            {canEdit() && (
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" />新建模板
              </Button>
            )}
          </>
        )}
      />

      <Card bodyClassName="p-3" className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            className="w-[220px]"
            placeholder="搜索名称 / 编码"
            value={keyword}
            onChange={(v) => { setKeyword(v); setPage(1) }}
            onClear={() => { setKeyword(''); setPage(1) }}
          />
          <CompactSelect value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="archived">已归档</option>
          </CompactSelect>
        </div>
      </Card>

      <Card bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={items}
          loading={loading}
          rowKey="id"
          onRowClick={(row) => setDetailId(row.id)}
          emptyText="暂无报告模板"
          emptyDescription="点击右上角「新建模板」，上传带占位符的 docx 文件"
          emptyAction={canEdit() ? (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />新建模板
            </Button>
          ) : null}
        />
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
        />
      </Card>

      <Modal
        open={createOpen}
        title="新建报告模板"
        onClose={() => setCreateOpen(false)}
        footer={(
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" loading={creating} onClick={submitCreate}>创建</Button>
          </>
        )}
      >
        <Field label="模板编码" required hint="3~64 位小写字母开头，仅含字母/数字/下划线/短横线，创建后不可修改">
          <input
            className={`${inputCls} font-mono`}
            value={form.code}
            placeholder="security_weekly_report"
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label="模板名称" required>
          <input
            className={inputCls}
            value={form.name}
            placeholder="安全运营周报"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="分类">
          <input
            className={inputCls}
            value={form.category}
            placeholder="安全运营 / 漏洞管理 / 合规"
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </Field>
        <Field label="描述">
          <textarea
            className={inputCls}
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={aiOpen}
        title="AI 生成模板草稿"
        size="lg"
        onClose={() => setAiOpen(false)}
        footer={(
          <>
            <Button onClick={() => setAiOpen(false)}>取消</Button>
            <Button variant="primary" loading={aiGenerating} onClick={submitAi}>
              <Sparkles className="mr-1 h-4 w-4" />生成模板
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <p className="rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            AI 只生成模板结构草稿（章节 + 占位符），不会填写任何数据；生成后需人工确认占位符并发布，
            再在报告配置中完成数据映射。
          </p>
          <Field label="报告需求描述" required hint="说明报告用途、章节结构、需要哪些指标与数据表格">
            <textarea
              className={inputCls}
              rows={6}
              value={aiForm.description}
              placeholder="生成一份安全运营周报：包含本周告警总数、高危告警数、已处置数、处置率，漏洞按资产列表展示，最后给出趋势总结。"
              onChange={(e) => setAiForm({ ...aiForm, description: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="模板编码" required hint="创建后不可修改">
              <input
                className={`${inputCls} font-mono`}
                value={aiForm.code}
                placeholder="security_weekly_report"
                onChange={(e) => setAiForm({ ...aiForm, code: e.target.value })}
              />
            </Field>
            <Field label="模板名称" required>
              <input
                className={inputCls}
                value={aiForm.name}
                placeholder="安全运营周报"
                onChange={(e) => setAiForm({ ...aiForm, name: e.target.value })}
              />
            </Field>
            <Field label="分类">
              <input
                className={inputCls}
                value={aiForm.category}
                placeholder="安全运营 / 漏洞管理 / 合规"
                onChange={(e) => setAiForm({ ...aiForm, category: e.target.value })}
              />
            </Field>
            <Field label="报告标题" hint="留空则使用模板名称">
              <input
                className={inputCls}
                value={aiForm.title}
                placeholder="XX 单位安全运营周报"
                onChange={(e) => setAiForm({ ...aiForm, title: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={fromOpen}
        title={fromResult ? '模板草稿已生成' : '从现有报告生成模板'}
        size="lg"
        onClose={closeFromReport}
        footer={fromResult ? (
          <>
            <Button onClick={closeFromReport}>关闭</Button>
            <Button
              variant="primary"
              onClick={() => {
                const templateId = fromResult.template?.id
                closeFromReport()
                if (templateId) setDetailId(templateId)
              }}
            >
              查看模板并确认发布
            </Button>
          </>
        ) : (
          <>
            <Button onClick={closeFromReport}>取消</Button>
            <Button variant="primary" loading={fromLoading} onClick={submitFromReport}>
              <Sparkles className="mr-1 h-4 w-4" />识别并生成
            </Button>
          </>
        )}
      >
        {fromResult ? (
          <div className="space-y-3">
            <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
              已生成草稿 v{fromResult.version?.version_no}：识别到{' '}
              {fromResult.manifest?.placeholders?.length || 0} 个占位符，
              其中 {(fromResult.manifest?.placeholders || []).filter((item) => item.type === 'table').length} 个表格。
              模板尚未发布，请核对占位符与表格列后再发布。
            </div>
            {(fromResult.warnings || []).length > 0 && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <div className="mb-1 font-medium">需人工确认</div>
                <ul className="list-disc space-y-1 pl-4">
                  {(fromResult.warnings || []).map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="overflow-hidden rounded border border-border">
              <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium">
                识别到的占位符
              </div>
              <ul className="max-h-56 divide-y divide-border overflow-auto">
                {(fromResult.manifest?.placeholders || []).map((item) => (
                  <li
                    key={item.id || item.token}
                    className="flex items-start justify-between gap-3 px-3 py-1.5 text-xs"
                  >
                    <span className="font-mono text-foreground">{item.token}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {item.type === 'table'
                        ? `表格 · ${(item.columns || []).map((column) => column.label).join(' / ')}`
                        : (item.label || item.type)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
              上传一份已完成的 Word 报告，系统保留原版式与固定文案，由 AI 识别每次运行会变化的
              数值、日期和表格并写入占位符。生成结果是草稿，确认占位符与表格列后再发布。
            </p>
            <Field
              label="现有报告文件"
              required
              hint="仅支持 .docx；建议使用一份实际产出过的报告，AI 识别更准确"
            >
              <input
                type="file"
                accept=".docx"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-primary"
                onChange={(e) => setFromFile(e.target.files?.[0] || null)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="模板编码" required hint="创建后不可修改">
                <input
                  className={`${inputCls} font-mono`}
                  value={fromForm.code}
                  placeholder="monthly_sec_report"
                  onChange={(e) => setFromForm({ ...fromForm, code: e.target.value })}
                />
              </Field>
              <Field label="模板名称" required>
                <input
                  className={inputCls}
                  value={fromForm.name}
                  placeholder="月度安全运营报告"
                  onChange={(e) => setFromForm({ ...fromForm, name: e.target.value })}
                />
              </Field>
              <Field label="分类">
                <input
                  className={inputCls}
                  value={fromForm.category}
                  placeholder="安全运营 / 漏洞管理 / 合规"
                  onChange={(e) => setFromForm({ ...fromForm, category: e.target.value })}
                />
              </Field>
            </div>
            <Field
              label="补充要求"
              hint="可选：说明哪些内容必须动态替换、哪些保持不变，可减少误识别"
            >
              <textarea
                className={inputCls}
                rows={3}
                value={fromForm.hint}
                placeholder="例如：告警总数、高危数、处置率、报告周期和资产表格需要动态替换；报告编号与免责声明保持固定。"
                onChange={(e) => setFromForm({ ...fromForm, hint: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>

      {detailId && (
        <TemplateDetailDrawer
          templateId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </PageContainer>
  )
}

// --------------------------------------------------------------------------- //
// 模板详情抽屉：版本列表 + 上传版本 + manifest 查看 + 发布 / 差异
// --------------------------------------------------------------------------- //
function TemplateDetailDrawer({ templateId, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [manifestVersion, setManifestVersion] = useState(null)
  const [manifest, setManifest] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [previewVersion, setPreviewVersion] = useState(null)
  const [publishingId, setPublishingId] = useState(null)
  const [diff, setDiff] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const detail = await reportApi.templates.detail(templateId)
      setData(detail)
      const current = detail.versions?.find((v) => v.id === detail.template?.current_version_id)
      if (current) await showManifest(current.id)
    } catch (err) {
      toast.error(err.message || '模板详情加载失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  useEffect(() => { load() }, [load])

  const showManifest = async (versionId) => {
    setManifestVersion(versionId)
    setManifest(null)
    try {
      const res = await reportApi.templates.manifest(templateId, versionId)
      setManifest(res.manifest || {})
    } catch (err) {
      toast.error(err.message || 'manifest 加载失败')
    }
  }

  const publish = async (versionId) => {
    setPublishingId(versionId)
    try {
      const res = await reportApi.templates.publishVersion(templateId, versionId)
      const impact = res.impact || []
      if (impact.length) {
        toast.warning(`已发布，但有 ${impact.length} 个存量配置受影响，请检查映射`)
      } else {
        toast.success('模板版本已发布')
      }
      await load()
      onChanged?.()
    } catch (err) {
      toast.error(err.message || '发布失败')
    } finally {
      setPublishingId(null)
    }
  }

  const showDiff = async (versionId) => {
    const currentId = data?.template?.current_version_id
    if (!currentId) {
      toast.warning('模板尚无已发布版本，无法对比')
      return
    }
    try {
      const res = await reportApi.templates.diff(templateId, currentId, versionId)
      setDiff({ baseId: currentId, targetId: versionId, ...res })
    } catch (err) {
      toast.error(err.message || '版本差异加载失败')
    }
  }

  return (
    <Modal open title={data?.template?.name || '模板详情'} onClose={onClose} size="xl">
      {loading && <p className="text-sm text-muted-foreground">加载中...</p>}
      {!loading && data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="info">{data.template.code}</Badge>
            <StatusOf map={TEMPLATE_STATUS} value={data.template.status} />
            {data.template.category && <span>分类：{data.template.category}</span>}
            <span>更新：{fmtTime(data.template.updated_at)}</span>
            {canEdit() && (
              <Button size="sm" variant="primary" className="ml-auto" onClick={() => setUploadOpen(true)}>
                <Upload className="mr-1 h-3.5 w-3.5" />上传新版本
              </Button>
            )}
          </div>

          <Card title="版本历史" bodyClassName="p-0">
            <DataTable
              rowKey="id"
              data={data.versions || []}
              emptyText="尚未上传模板版本"
              columns={[
                { key: 'version_no', header: '版本', width: '10%', render: (r) => `v${r.version_no}` },
                {
                  key: 'status',
                  header: '状态',
                  width: '12%',
                  render: (r) => <StatusOf map={VERSION_STATUS} value={r.status} />,
                },
                { key: 'changelog', header: '变更说明', width: '30%', render: (r) => r.changelog || '—' },
                { key: 'created_at', header: '创建时间', width: '18%', render: (r) => fmtTime(r.created_at) },
                {
                  key: 'actions',
                  header: '操作',
                  width: '30%',
                  render: (r) => (
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setPreviewVersion(r)}>预览</Button>
                      <Button size="sm" variant="ghost" onClick={() => showManifest(r.id)}>清单</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => reportApi.templates
                          .download(templateId, r.id, `template_v${r.version_no}.docx`)
                          .catch((e) => toast.error(e.message))}
                      >
                        下载
                      </Button>
                      {r.status !== 'published' && canPublish() && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={publishingId === r.id}
                          onClick={() => publish(r.id)}
                        >
                          发布
                        </Button>
                      )}
                      {r.status !== 'published' && data.template.current_version_id && (
                        <Button size="sm" variant="ghost" onClick={() => showDiff(r.id)}>对比</Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          {manifest && (
            <Card
              title={`占位符清单 ${manifestVersion ? `（版本 #${manifestVersion}）` : ''}`}
              description={`章节 ${manifest.sections?.length || 0} 个 · 占位符 ${manifest.placeholders?.length || 0} 个`}
            >
              {(manifest.warnings || []).length > 0 && (
                <div className="mb-3 rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
                  {(manifest.warnings || []).map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
              <ManifestTable manifest={manifest} />
            </Card>
          )}

          {diff && (
            <Card title={`版本差异：v${data.versions?.find((v) => v.id === diff.baseId)?.version_no} → v${data.versions?.find((v) => v.id === diff.targetId)?.version_no}`}>
              <div className="space-y-2 text-xs">
                <DiffLine label="新增占位符" values={diff.added} tone="success" />
                <DiffLine label="移除占位符" values={diff.removed} tone="danger" />
                <DiffLine label="变更占位符" values={(diff.changed || []).map((c) => `${c.token}（${c.fields.join(', ')}）`)} tone="warning" />
                <DiffLine label="新增章节" values={diff.sections?.added} tone="success" />
                <DiffLine label="移除章节" values={diff.sections?.removed} tone="danger" />
                {diff.breaking && (
                  <p className="text-destructive">该版本存在破坏性变更，发布前需检查并迁移存量配置映射。</p>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      <Modal
        open={uploadOpen}
        title="上传模板新版本"
        onClose={() => setUploadOpen(false)}
        footer={<Button onClick={() => setUploadOpen(false)}>关闭</Button>}
      >
        <UploadVersionForm
          templateId={templateId}
          uploading={uploading}
          setUploading={setUploading}
          onDone={async () => { setUploadOpen(false); await load(); onChanged?.() }}
        />
      </Modal>

      <Modal
        open={!!previewVersion}
        title={`模板预览 v${previewVersion?.version_no ?? ''}`}
        size="xl"
        onClose={() => setPreviewVersion(null)}
        footer={<Button onClick={() => setPreviewVersion(null)}>关闭</Button>}
      >
        <p className="mb-2 rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          占位符以【token】显示，表格展示 1 行示例数据，用于确认占位符落在模板的哪些位置。
          预览按当前模板样张生成，不会写入正式报告数据。
        </p>
        {previewVersion && (
          <PdfPreviewPanel
            key={previewVersion.id}
            autoLoad
            load={() => reportApi.templates.previewPdf(templateId, previewVersion.id)}
            filename={`template_v${previewVersion.version_no}_preview.pdf`}
          />
        )}
      </Modal>
    </Modal>
  )
}

function UploadVersionForm({ templateId, uploading, setUploading, onDone }) {
  const [file, setFile] = useState(null)
  const [changelog, setChangelog] = useState('')

  const submit = async () => {
    if (!file) {
      toast.warning('请选择 .docx 文件')
      return
    }
    setUploading(true)
    try {
      const version = await reportApi.templates.uploadVersion(templateId, file, changelog)
      toast.success(`已上传 v${version.version_no}，解析到 ${version.manifest?.placeholders?.length || 0} 个占位符`)
      onDone?.()
    } catch (err) {
      toast.error(err.message || '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      <Field
        label="模板文件"
        required
        hint="仅支持 .docx；脚本占位符必须使用 {{ 域.指标 }} 与 {%tr for r in table.xxx %} 语法"
      >
        <input
          type="file"
          accept=".docx"
          className={inputCls}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </Field>
      <Field label="变更说明">
        <input
          className={inputCls}
          value={changelog}
          placeholder="如：新增漏洞处置章节"
          onChange={(e) => setChangelog(e.target.value)}
        />
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" loading={uploading} onClick={submit}>
          <FileText className="mr-1 h-4 w-4" />上传并解析
        </Button>
      </div>
    </div>
  )
}

function ManifestTable({ manifest }) {
  const placeholders = manifest.placeholders || []
  if (!placeholders.length) return <EmptyState title="未解析到占位符" bordered />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3">占位符</th>
            <th className="py-1.5 pr-3">类型</th>
            <th className="py-1.5 pr-3">必填</th>
            <th className="py-1.5 pr-3">表格列</th>
            <th className="py-1.5">出现位置</th>
          </tr>
        </thead>
        <tbody>
          {placeholders.map((p) => (
            <tr key={p.id || p.token} className="border-b border-border/60 align-top">
              <td className="py-1.5 pr-3 font-mono text-foreground">{p.token}</td>
              <td className="py-1.5 pr-3">{p.type}</td>
              <td className="py-1.5 pr-3">{p.required ? '是' : '否'}</td>
              <td className="py-1.5 pr-3">
                {p.type === 'table'
                  ? (p.columns || []).map((c) => c.label || c.key).join(' / ') || '—'
                  : '—'}
              </td>
              <td className="py-1.5 text-muted-foreground">
                {(p.locations || []).map((loc) => loc.kind).filter((v, i, a) => a.indexOf(v) === i).join(' / ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DiffLine({ label, values = [], tone }) {
  const toneCls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : 'text-warning'
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className={toneCls}>
        {values?.length ? values.join('、') : '无'}
      </span>
    </div>
  )
}
