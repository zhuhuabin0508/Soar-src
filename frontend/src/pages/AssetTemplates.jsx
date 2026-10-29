import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Plus, Pencil, Trash2, Save, X, ArrowUp, ArrowDown, Boxes,
  Server, Network, Globe, Tag as TagIcon, RefreshCw,
  Download, Upload, FileJson,
} from 'lucide-react'
import { assetsApi } from '../api/assets'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { inputCls, labelCls } from '../components/property/FormControls'
import {
  Card, Badge, ErrorState, EmptyState, StatusBadge, CompactSelect,
} from '../components/ui'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'

const TEMPLATE_ICONS = { host_asset: Server, network_segment: Network, egress_ip: Globe }
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'textarea', 'ip', 'cidr']
const STANDARD_COLS = ['name', 'asset_type', 'department', 'owner', 'location', 'ip', 'criticality', 'status']
const COLOR_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']

const optionsToText = (options) => (options || []).join(', ')
const parseOptions = (text) => String(text || '')
  .split(/[,，]/)
  .map((s) => s.trim())
  .filter(Boolean)

// 下拉选项编辑器：本地保留原始输入文本，避免每次按键都 split/filter/join 回填，
// 从而导致刚输入的英文逗号被立即清掉、无法继续输入下一个选项。
function CommaOptionsInput({ value, onChange }) {
  const [text, setText] = useState(() => optionsToText(value))
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setText(optionsToText(value))
  }, [value])

  const commit = (raw = text) => {
    const opts = parseOptions(raw)
    setText(optionsToText(opts))
    onChange(opts)
  }

  return (
    <input
      className={`${inputCls} h-7 min-w-[200px] flex-1`}
      value={text}
      onFocus={() => { focusedRef.current = true }}
      onChange={(e) => {
        setText(e.target.value)
        // 每输入一个字符就同步解析后的选项，保证直接点「保存」时不会丢失刚输入的内容；
        // 原始文本仍保留在本地，英文逗号不会被回填逻辑吃掉。
        onChange(parseOptions(e.target.value))
      }}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      placeholder="选项（英文逗号分隔，如：是, 否）"
    />
  )
}

// 解析导入文件：兼容导出信封 { templates: [...] }、模板数组、单个模板对象
function parseTemplateImport(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.templates)) return parsed.templates
  if (parsed && parsed.template && typeof parsed.template === 'object') return [parsed.template]
  if (parsed && typeof parsed === 'object' && parsed.code) return [parsed]
  return []
}

// ===== 模板编辑器 =====
function TemplateEditor({ open, template, onClose, onSaved }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  // 未保存修改检测：编辑器打开期间跟踪表单是否被改过
  const [dirty, setDirty] = useState(false)
  const bypassGuard = useUnsavedChanges(dirty)

  useEffect(() => {
    if (!open) return
    setErr('')
    if (template) {
      // 深拷贝用于编辑
      setForm({
        code: template.code,
        name: template.name,
        description: template.description || '',
        icon: template.icon || 'server',
        color: template.color || 'chart-1',
        identifier_field: template.identifier_field || 'ip',
        fields: (template.fields || []).map((f) => ({ ...f })),
        is_preset: template.is_preset,
        allow_aggregate: !!template.allow_aggregate,
      })
    } else {
      setForm({
        code: '', name: '', description: '', icon: 'server', color: 'chart-1',
        identifier_field: 'ip', fields: [], is_preset: false, allow_aggregate: false,
      })
    }
    setDirty(false)
  }, [open, template])

  if (!open || !form) return null

  const isCreate = !template
  const update = (patch) => { setForm((p) => ({ ...p, ...patch })); setDirty(true) }

  const updateField = (idx, patch) => {
    setForm((p) => {
      const fields = p.fields.slice()
      fields[idx] = { ...fields[idx], ...patch }
      return { ...p, fields }
    })
    setDirty(true)
  }
  const addField = () => {
    setForm((p) => ({
      ...p,
      fields: [
        ...p.fields,
        {
          key: '', label: '', type: 'text', mapped_to: 'extra',
          required: false, unique: false, options: [], placeholder: '',
          default: '', width: 'half', sort_order: p.fields.length + 1,
          show_in_list: true, show_in_detail: true,
        },
      ],
    }))
    setDirty(true)
  }
  const removeField = (idx) => { setForm((p) => ({ ...p, fields: p.fields.filter((_, i) => i !== idx) })); setDirty(true) }
  const moveField = (idx, dir) => {
    setForm((p) => {
      const fields = p.fields.slice()
      const ni = idx + dir
      if (ni < 0 || ni >= fields.length) return p
      ;[fields[idx], fields[ni]] = [fields[ni], fields[idx]]
      return { ...p, fields }
    })
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true); setErr('')
    try {
      // 校验
      if (!form.name.trim()) throw new Error('模板名称不能为空')
      if (isCreate && !form.code.trim()) throw new Error('模板代码不能为空')
      if (form.fields.length === 0) throw new Error('至少需要定义一个字段')
      const fieldKeys = form.fields.map((f) => f.key)
      if (fieldKeys.some((k) => !k)) throw new Error('所有字段必须填写 key')
      if (new Set(fieldKeys).size !== fieldKeys.length) throw new Error('字段 key 不能重复')
      if (!fieldKeys.includes(form.identifier_field)) {
        throw new Error(`标识字段 "${form.identifier_field}" 必须在字段列表中`)
      }
      const payload = {
        name: form.name, description: form.description, icon: form.icon,
        color: form.color, identifier_field: form.identifier_field,
        allow_aggregate: !!form.allow_aggregate,
        fields: form.fields.map((f, i) => ({
          ...f,
          key: f.key.trim(), label: f.label.trim() || f.key,
          sort_order: f.sort_order ?? i + 1,
          options: f.type === 'select' ? (f.options || []) : [],
        })),
      }
      if (isCreate) {
        payload.code = form.code.trim()
        await assetsApi.createTemplate(payload)
      } else {
        await assetsApi.updateTemplate(form.code, payload)
      }
      setDirty(false)
      bypassGuard() // 放行下一次导航，避免点保存也弹未保存修改弹窗
      onSaved?.()
      onClose()
    } catch (e) {
      setErr(e.message || '保存失败')
    } finally { setSaving(false) }
  }

  // 关闭编辑器：放弃当前编辑，重置 dirty 并放行后续导航
  const handleClose = () => {
    setDirty(false)
    bypassGuard()
    onClose()
  }

  return (
    <Modal
      open={open}
      title={isCreate ? '新建资产类型' : `编辑「${template.name}」`}
      onClose={handleClose}
      maxWidth="max-w-4xl"
      footer={
        <>
          <button onClick={handleClose} className="btn-secondary">取消</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary btn-sm flex items-center gap-1">
            <Save className="h-3.5 w-3.5" /> {saving ? '保存中...' : '保存'}
          </button>
        </>
      }
    >
      {err && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}
      {/* 基本信息 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {isCreate && (
          <div>
            <label className={labelCls}>模板代码（唯一，英文）</label>
            <input className={inputCls} value={form.code} onChange={(e) => update({ code: e.target.value })} placeholder="如 web_service" />
          </div>
        )}
        <div>
          <label className={labelCls}>模板名称</label>
          <input className={inputCls} value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="如 Web 服务资产" />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>描述</label>
          <input className={inputCls} value={form.description} onChange={(e) => update({ description: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>图标（lucide 名称）</label>
          <input className={inputCls} value={form.icon} onChange={(e) => update({ icon: e.target.value })} placeholder="server / network / globe ..." />
        </div>
        <div>
          <label className={labelCls}>主题色</label>
          <CompactSelect value={form.color} onChange={(e) => update({ color: e.target.value })} size="lg" block>
            {COLOR_TOKENS.map((c) => <option key={c} value={c}>{c}</option>)}
          </CompactSelect>
        </div>
        <div>
          <label className={labelCls}>标识字段（唯一标识）</label>
          <CompactSelect value={form.identifier_field} onChange={(e) => update({ identifier_field: e.target.value })} size="lg" block>
            {form.fields.map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
          </CompactSelect>
        </div>
      </div>

      {/* 标识聚合开关 */}
      <div className="mt-3 flex items-start gap-3 rounded-lg border border-border bg-muted p-3">
        <label className="mt-0.5 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={!!form.allow_aggregate}
            onChange={(e) => update({ allow_aggregate: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">允许标识聚合</span>
        </label>
        <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
          开启后，同一标识（如同一网段）允许存在多条不同使用单位的记录，
          资产清单中按标识分组展开显示各使用单位子项；
          关闭时标识在该类型下全局唯一，同标识不同部门视为冲突。
        </p>
      </div>

      {/* 字段定义 */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">字段定义（{form.fields.length}）</h3>
          <button onClick={addField} className="btn-secondary btn-sm flex items-center gap-1">
            <Plus className="h-3.5 w-3.5" /> 添加字段
          </button>
        </div>
        <div className="space-y-2">
          {form.fields.map((f, idx) => (
            <div key={idx} className="rounded-lg border border-border bg-muted p-3">
              <div className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-3">
                  <label className="text-[10px] text-muted-foreground">字段 key</label>
                  <input className={inputCls} value={f.key} onChange={(e) => updateField(idx, { key: e.target.value })} placeholder="ip" />
                </div>
                <div className="col-span-3">
                  <label className="text-[10px] text-muted-foreground">显示标签</label>
                  <input className={inputCls} value={f.label} onChange={(e) => updateField(idx, { label: e.target.value })} placeholder="IP 地址" />
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] text-muted-foreground">类型</label>
                  <CompactSelect value={f.type} onChange={(e) => updateField(idx, { type: e.target.value })} size="lg" block>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </CompactSelect>
                </div>
                <div className="col-span-3">
                  <label className="text-[10px] text-muted-foreground">映射目标</label>
                  <CompactSelect value={f.mapped_to} onChange={(e) => updateField(idx, { mapped_to: e.target.value })} size="lg" block>
                    <option value="extra">extra（扩展字段）</option>
                    {STANDARD_COLS.map((c) => <option key={c} value={`standard:${c}`}>standard:{c}</option>)}
                  </CompactSelect>
                </div>
                <div className="col-span-1 flex items-center justify-end gap-1">
                  <button onClick={() => moveField(idx, -1)} disabled={idx === 0} className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" title="上移">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => moveField(idx, 1)} disabled={idx === form.fields.length - 1} className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30" title="下移">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => removeField(idx)} className="rounded p-1 text-destructive hover:bg-destructive/10" title="删除">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!!f.required} onChange={(e) => updateField(idx, { required: e.target.checked })} /> 必填
                </label>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!!f.show_in_list} onChange={(e) => updateField(idx, { show_in_list: e.target.checked })} /> 列表显示
                </label>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!!f.show_in_detail} onChange={(e) => updateField(idx, { show_in_detail: e.target.checked })} /> 详情显示
                </label>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  宽度
                  <CompactSelect variant="ghost" size="sm" value={f.width || 'half'} onChange={(e) => updateField(idx, { width: e.target.value })}>
                    <option value="half">半行</option>
                    <option value="full">整行</option>
                  </CompactSelect>
                </label>
                <input className={`${inputCls} h-7 max-w-[160px]`} value={f.placeholder || ''} onChange={(e) => updateField(idx, { placeholder: e.target.value })} placeholder="占位提示" />
                {f.type === 'select' && (
                  <CommaOptionsInput
                    value={f.options || []}
                    onChange={(options) => updateField(idx, { options })}
                  />
                )}
              </div>
            </div>
          ))}
          {form.fields.length === 0 && (
            <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
              点击「添加字段」定义资产属性
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ===== 标签管理 =====
function TagManager() {
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [color, setColor] = useState('brand')
  const [category, setCategory] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setTags(await assetsApi.listTags()) } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!name.trim()) return
    setErr('')
    try {
      await assetsApi.createTag({ name: name.trim(), color, category: category.trim() || null })
      setName(''); setCategory('')
      load()
    } catch (e) { setErr(e.message || '创建失败') }
  }
  const handleDelete = async (t) => {
    const ok = await confirm({
      title: '删除标签',
      message: `确定删除标签「${t.name}」？关联资产的标签会自动解除，此操作不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    await assetsApi.deleteTag(t.id)
    load()
  }

  // 按 category 分组
  const grouped = tags.reduce((acc, t) => {
    const cat = t.category || '未分类'
    ;(acc[cat] = acc[cat] || []).push(t)
    return acc
  }, {})

  return (
    <Card>
      <div className="border-b border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">标签管理</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">全局共享，多对多分组，按分类组织</p>
      </div>
      <div className="space-y-4 p-4">
        {/* 新建 */}
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted p-3">
          <div className="min-w-[140px] flex-1">
            <label className={labelCls}>标签名称</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：核心系统" onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
          </div>
          <div className="min-w-[120px]">
            <label className={labelCls}>分类</label>
            <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="如：安全等级" />
          </div>
          <div>
            <label className={labelCls}>颜色</label>
            <CompactSelect value={color} onChange={(e) => setColor(e.target.value)} size="lg" block>
              {['brand', 'success', 'warning', 'danger', 'neutral', 'info'].map((c) => <option key={c} value={c}>{c}</option>)}
            </CompactSelect>
          </div>
          <button onClick={handleCreate} disabled={!name.trim()} className="btn-primary btn-sm flex items-center gap-1">
            <Plus className="h-3.5 w-3.5" /> 添加
          </button>
        </div>
        {err && <div className="text-xs text-destructive">{err}</div>}
        {/* 列表（按分类分组） */}
        {loading ? (
          <div className="space-y-4">
            <div className="h-3 w-16 rounded skeleton-shimmer" />
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-6 w-20 rounded-full skeleton-shimmer" />
              ))}
            </div>
          </div>
        ) : tags.length === 0 ? (
          <EmptyState icon={TagIcon} title="暂无标签" description="创建标签用于资产分组与筛选" />
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([cat, list]) => (
              <div key={cat}>
                <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{cat}</div>
                <div className="flex flex-wrap gap-2">
                  {list.map((t) => (
                    <div key={t.id} className="group flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-3 pr-1.5">
                      <Badge variant={t.color || 'brand'}>{t.name}</Badge>
                      <span className={`text-[10px] tabular-nums ${t.asset_count > 0 ? 'text-muted-foreground' : 'text-muted-foreground'}`} title={t.asset_count == null ? '未统计' : `关联 ${t.asset_count} 项资产`}>
                        {(t.asset_count ?? 0).toLocaleString()}
                      </span>
                      <button onClick={() => handleDelete(t)} className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100" title="删除">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

// ===== 主页面 =====
export default function AssetTemplates() {
  const [tab, setTab] = useState('templates') // templates | tags
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  // 导入/导出状态
  const [importOpen, setImportOpen] = useState(false)
  const [importParsed, setImportParsed] = useState(null) // { payload, names, count }
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState('') // '' | 'all' | 模板 code
  const importFileRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setTemplates(await assetsApi.listTemplates()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const handleDelete = async (t) => {
    if (t.is_preset) { toast.warning('预设模板不可删除'); return }
    const ok = await confirm({
      title: '删除类型模板',
      message: `确定删除模板「${t.name}」？已关联的资产数据保留（type_code 仍存），此操作不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    await assetsApi.deleteTemplate(t.code)
    load()
  }

  // 导出单个模板 / 全部模板为 JSON
  const handleExport = async (t) => {
    const key = t ? t.code : 'all'
    setExporting(key)
    try {
      await assetsApi.exportTemplates(t ? [t.code] : [])
      toast.success(t ? `已导出「${t.name}」` : `已导出 ${templates.length} 个类型模板`)
    } catch (e) {
      toast.error(e.message || '导出失败')
    } finally {
      setExporting('')
    }
  }

  // 读取 JSON 文件 → 预览 → 确认导入
  const handleImportFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''))
        const items = parseTemplateImport(parsed)
        if (items.length === 0) throw new Error('未识别到模板定义')
        setImportParsed({
          payload: { templates: items },
          names: items.map((it) => it?.name || it?.code || '(未命名)'),
          count: items.length,
        })
      } catch (e) {
        toast.error(e.message === '未识别到模板定义' ? e.message : '文件不是合法的模板 JSON')
        setImportParsed(null)
      }
    }
    reader.onerror = () => toast.error('文件读取失败')
    reader.readAsText(file)
  }

  const handleImportSubmit = async () => {
    if (!importParsed) return
    setImporting(true)
    try {
      const res = await assetsApi.importTemplates(importParsed.payload)
      const renamed = (res.items || []).filter((it) => it.renamed_from).length
      toast.success(`成功导入 ${res.imported} 个类型模板${renamed ? `，其中 ${renamed} 个因 code 冲突已自动重命名` : ''}`)
      setImportOpen(false)
      setImportParsed(null)
      if (importFileRef.current) importFileRef.current.value = ''
      load()
    } catch (e) {
      toast.error(e.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const closeImport = () => {
    if (importing) return
    setImportOpen(false)
    setImportParsed(null)
    if (importFileRef.current) importFileRef.current.value = ''
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">类型模板与标签</h1>
          {tab === 'templates' && !loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{templates.length}</span> 个模板
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">定义资产数据模型（字段 schema）与全局标签</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新模板列表">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          {tab === 'templates' && (
            <>
              <button
                type="button"
                onClick={() => { setImportOpen(true); setImportParsed(null) }}
                className="btn-secondary btn-sm"
                title="从 JSON 文件导入类型模板"
              >
                <Upload className="mr-1 h-3.5 w-3.5" /> 导入模板
              </button>
              <button
                type="button"
                onClick={() => handleExport(null)}
                disabled={exporting === 'all' || templates.length === 0}
                className="btn-secondary btn-sm"
                title="导出全部类型模板为 JSON"
              >
                <Download className={`mr-1 h-3.5 w-3.5 ${exporting === 'all' ? 'animate-pulse' : ''}`} /> 导出全部
              </button>
              <button onClick={() => { setEditing(null); setEditorOpen(true) }} className="btn-primary btn-sm">
                <Plus className="mr-1 h-3.5 w-3.5" /> 新建类型
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">

      {/* Tab 切换 */}
      <div className="mb-4 flex items-center gap-1.5 border-b border-border pb-px">
        <button onClick={() => setTab('templates')} className={`relative rounded-t-md px-3 py-2 text-sm ${tab === 'templates' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
          类型模板
          {tab === 'templates' && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />}
        </button>
        <button onClick={() => setTab('tags')} className={`relative rounded-t-md px-3 py-2 text-sm ${tab === 'tags' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
          标签管理
          {tab === 'tags' && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-primary" />}
        </button>
      </div>

      {tab === 'templates' ? (
        loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col rounded-lg border border-border bg-card">
                <div className="flex items-start gap-3 border-b border-border p-4">
                  <div className="h-10 w-10 shrink-0 rounded-lg skeleton-shimmer" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 w-2/3 rounded skeleton-shimmer" />
                    <div className="h-2.5 w-1/2 rounded skeleton-shimmer" />
                  </div>
                </div>
                <div className="flex-1 space-y-2 p-4">
                  <div className="h-2.5 w-full rounded skeleton-shimmer" />
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <div key={j} className="h-4 w-14 rounded skeleton-shimmer" />
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1 border-t border-border px-3 py-2">
                  <div className="h-6 w-14 rounded skeleton-shimmer" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? <ErrorState description={error} onRetry={load} /> : (
          <div className="card-stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((t) => {
              const Icon = TEMPLATE_ICONS[t.code] || Boxes
              return (
                <div key={t.code} className="card-hover flex flex-col rounded-lg border border-border bg-card transition-colors hover:border-primary/40">
                  <div className="flex items-start gap-3 border-b border-border p-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{t.name}</span>
                        {t.is_preset ? (
                          <Badge variant="brand">预设</Badge>
                        ) : (
                          <Badge variant="neutral">自定义</Badge>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {t.code} · 标识：{t.identifier_field}
                        {t.allow_aggregate && (
                          <span className="ml-1 inline-flex items-center rounded border border-primary/40 bg-primary/10 px-1 text-[10px] text-primary">
                            聚合
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 p-4">
                    {t.description && <p className="mb-3 text-xs text-muted-foreground">{t.description}</p>}
                    <div className="mb-2 text-[11px] font-medium tabular-nums uppercase tracking-wider text-muted-foreground">
                      字段（{(t.fields || []).length}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(t.fields || []).slice(0, 12).map((f) => (
                        <span key={f.key} className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          f.key === t.identifier_field
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground'
                        }`}>
                          {f.label || f.key}
                          {f.required && <span className="ml-0.5 text-destructive">*</span>}
                        </span>
                      ))}
                      {(t.fields || []).length > 12 && (
                        <span className="text-[10px] text-muted-foreground">+{(t.fields || []).length - 12}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1 border-t border-border px-3 py-2">
                    <button
                      onClick={() => handleExport(t)}
                      disabled={exporting === t.code}
                      className="btn-secondary btn-sm"
                      title="导出模板 JSON"
                    >
                      <Download className={`h-3 w-3 ${exporting === t.code ? 'animate-pulse' : ''}`} />
                    </button>
                    <button onClick={() => { setEditing(t); setEditorOpen(true) }} className="btn-secondary btn-sm" title="编辑模板">
                      <Pencil className="h-3 w-3" />
                    </button>
                    {!t.is_preset && (
                      <button onClick={() => handleDelete(t)} className="btn-danger btn-sm" title="删除模板">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {templates.length === 0 && (
              <div className="col-span-full">
                <EmptyState
                  icon={Boxes}
                  title="暂无资产类型"
                  description="创建第一个类型模板，为资产清单定义字段结构"
                  action={
                    <button onClick={() => { setEditing(null); setEditorOpen(true) }} className="btn-primary btn-sm">
                      <Plus className="mr-1 h-3.5 w-3.5" /> 新建类型
                    </button>
                  }
                />
              </div>
            )}
          </div>
        )
      ) : (
        <TagManager />
      )}

      {/* 类型模板导入弹窗：选择 JSON 文件 → 预览 → 确认导入 */}
      <Modal
        open={importOpen}
        title="导入类型模板"
        onClose={closeImport}
        maxWidth="max-w-xl"
        footer={
          <>
            <button onClick={closeImport} disabled={importing} className="btn-secondary">取消</button>
            <button
              onClick={handleImportSubmit}
              disabled={!importParsed || importing}
              className="btn-primary btn-sm flex items-center gap-1"
            >
              <Upload className="h-3.5 w-3.5" />
              {importing ? '导入中...' : importParsed ? `导入 ${importParsed.count} 个模板` : '导入'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center transition hover:border-primary/50 hover:bg-primary/5">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <span className="text-sm text-foreground">点击选择 .json 文件</span>
            <span className="text-xs text-muted-foreground">
              支持单模板对象、模板数组或导出的信封文件，结构与「导出模板」一致
            </span>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              disabled={importing}
              onChange={(e) => handleImportFile(e.target.files?.[0])}
            />
          </label>
          {importParsed && (
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground">
                已识别 <span className="font-medium text-foreground">{importParsed.count}</span> 个模板：
              </div>
              <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-auto text-sm">
                {importParsed.names.map((n, i) => (
                  <li key={i} className="flex items-center gap-2 truncate">
                    <FileJson className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-foreground">{n}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-muted-foreground">
                code 冲突时将自动追加「_importN」后缀；结构非法将整批拒绝，不导入任何模板。
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* 模板编辑器 */}
      <TemplateEditor
        open={editorOpen}
        template={editing}
        onClose={() => { setEditorOpen(false); setEditing(null) }}
        onSaved={load}
      />
      </div>
    </div>
  )
}
