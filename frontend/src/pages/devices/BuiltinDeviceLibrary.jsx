// 内置设备库：系统内置设备模板列表（按设备类别/厂商分组）、搜索筛选、
// 模板与固化动作的增删改、从现有设备识别入库、复用模板一键创建设备。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Copy,
  FileClock,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { devices as devicesApi } from '../../api/client'
import { Modal } from '../../components/Dialog'
import { CompactSelect, PageContainer, PageHeader } from '../../components/ui'
import { inputCls } from '../../components/property/FormControls'
import { toast } from '../../store/toastStore'
import { ActionFormModal } from './ActionModal'
import { CategoryBadge, DeviceTypeIcon, MethodBadge, RiskBadge, Section, Switch } from './Badges'
import {
  DEVICE_AUTH_TYPES,
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
  fmtTime,
  parseTags,
  safeParseJson,
} from './constants'

const SOURCE_META = {
  builtin: { label: '系统内置', cls: 'bg-primary/15 text-primary' },
  device: { label: '设备识别入库', cls: 'bg-warning/15 text-warning' },
  manual: { label: '手动新增', cls: 'bg-secondary text-muted-foreground' },
}

const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'builtin', label: '系统内置' },
  { value: 'device', label: '设备识别入库' },
  { value: 'manual', label: '手动新增' },
]

const AUTH_LABELS = Object.fromEntries(DEVICE_AUTH_TYPES.map((a) => [a.value, a.label]))

// 设备类别取值集合（键与中文标签）。EDR、自定义等属于设备类别，
// 不能出现在厂商维度（筛选、分组、展示）中。
const CATEGORY_VALUES = new Set(
  DEVICE_TYPES.flatMap((t) => [t.value.toLowerCase(), t.label.toLowerCase()])
)

function isDeviceCategory(value) {
  const v = (value || '').trim().toLowerCase()
  return !!v && CATEGORY_VALUES.has(v)
}

// 厂商展示值：类别值不视为厂商
function vendorText(value, fallback = '未标注厂商') {
  return value && !isDeviceCategory(value) ? value : fallback
}

function actionParamCount(action) {
  const params = safeParseJson(action?.params_schema, [])
  return Array.isArray(params) ? params.length : 0
}

// ============ 模板基础信息表单 ============
function TemplateFormModal({ open, initial, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(null)
  const [tagsInput, setTagsInput] = useState('')

  useEffect(() => {
    if (!open) return
    const src = initial || {}
    setForm({
      name: src.name || '',
      type: src.type || 'custom',
      vendor: src.vendor || '',
      version: src.version || '',
      description: src.description || '',
      api_url: src.api_url || '',
      auth_type: src.auth_type || 'api_key',
      icon: src.icon || '',
      timeout: src.timeout ?? 30,
      max_retries: src.max_retries ?? 2,
      verify_tls: !!src.verify_tls,
    })
    setTagsInput(parseTags(src.tags).join(', '))
  }, [open, initial])

  if (!form) return null

  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }))

  const handleSubmit = async () => {
    if (!(form.name || '').trim()) {
      toast.warning('请填写模板名称')
      return
    }
    if (isDeviceCategory(form.vendor)) {
      toast.warning(`「${form.vendor.trim()}」是设备类别，请在「设备类别」中选择，厂商需填写品牌名称（如：青藤）`)
      return
    }
    const tags = tagsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ok = await onSubmit({
      ...form,
      name: form.name.trim(),
      tags,
      timeout: form.timeout === '' ? null : Number(form.timeout),
      max_retries: form.max_retries === '' ? null : Number(form.max_retries),
    })
    if (ok) onClose()
  }

  return (
    <Modal
      open={open}
      title={initial ? `编辑内置模板：${initial.name}` : '新增内置模板条目'}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving} className="btn-primary">
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Section title="基础信息">
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                模板名称 <span className="text-destructive">*</span>
              </div>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
                placeholder="如：青藤万相主机安全管理"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">设备类别</div>
              <CompactSelect value={form.type} onChange={(e) => set('type')(e.target.value)} size="lg" block>
                {DEVICE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">厂商（品牌名称）</div>
              <input
                className={inputCls}
                value={form.vendor}
                onChange={(e) => set('vendor')(e.target.value)}
                placeholder="如：青藤（不要填 EDR / 自定义 等类别）"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">对接协议版本</div>
              <input
                className={inputCls}
                value={form.version}
                onChange={(e) => set('version')(e.target.value)}
                placeholder="如：v3.4.1.66"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">认证方式</div>
              <CompactSelect
                value={form.auth_type}
                onChange={(e) => set('auth_type')(e.target.value)}
                size="lg"
                block
              >
                {DEVICE_AUTH_TYPES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">API 基地址</div>
              <input
                className={inputCls}
                value={form.api_url}
                onChange={(e) => set('api_url')(e.target.value)}
                placeholder="https://host:port/api"
              />
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">模板描述</div>
              <input
                className={inputCls}
                value={form.description}
                onChange={(e) => set('description')(e.target.value)}
                placeholder="说明模板包含的设备能力与适用场景"
              />
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">标签（英文逗号分隔）</div>
              <input
                className={inputCls}
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="如：青藤, 主机安全"
              />
            </label>
          </div>
        </Section>
        <Section title="连接参数默认值" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">请求超时（秒）</div>
              <input
                type="number"
                className={inputCls}
                value={form.timeout ?? ''}
                onChange={(e) => set('timeout')(e.target.value)}
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">最大重试次数</div>
              <input
                type="number"
                className={inputCls}
                value={form.max_retries ?? ''}
                onChange={(e) => set('max_retries')(e.target.value)}
              />
            </label>
            <label className="col-span-2 flex items-center gap-2">
              <Switch checked={!!form.verify_tls} onChange={() => set('verify_tls')(!form.verify_tls)} />
              <span className="text-sm text-muted-foreground">默认校验 TLS 证书</span>
            </label>
          </div>
        </Section>
      </div>
    </Modal>
  )
}

// ============ 从现有设备识别入库 ============
function ImportFromDeviceModal({ open, devices, loading, onClose, onSubmit, saving }) {
  const [deviceId, setDeviceId] = useState('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) {
      setDeviceId('')
      setName('')
    }
  }, [open])

  const selected = devices.find((d) => String(d.id) === String(deviceId))

  return (
    <Modal
      open={open}
      title="从现有设备识别入库"
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit({ device_id: Number(deviceId), name: name.trim() })}
            disabled={saving || !deviceId}
            className="btn-primary"
          >
            {saving ? '入库中…' : '识别并入库'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          选择已对接的设备，系统将固化其基础信息与全部关联动作，生成可复用的内置模板条目。
          入库为快照，后续对模板的修改不会影响源设备。
        </p>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            源设备 <span className="text-destructive">*</span>
          </div>
          <CompactSelect
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            size="lg"
            block
            disabled={loading}
          >
            <option value="">{loading ? '加载中…' : '请选择设备'}</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}（{DEVICE_TYPE_LABELS[d.type] || d.type} · {d.action_count ?? 0} 个动作）
              </option>
            ))}
          </CompactSelect>
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">模板名称（留空沿用设备名称）</div>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selected?.name || '模板名称'}
          />
        </label>
        {selected && (
          <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            将固化：{selected.action_count ?? 0} 个动作 · 类别 {DEVICE_TYPE_LABELS[selected.type] || selected.type} ·
            厂商 {vendorText(selected.vendor, '未标注')} · 版本 {selected.version || '未标注'}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ============ 复用模板创建设备 ============
function InstantiateModal({ open, template, onClose, onSubmit, saving }) {
  const [form, setForm] = useState({
    name: '',
    api_url: '',
    ip_address: '',
    username: '',
    password: '',
    api_key: '',
    enabled: true,
  })

  useEffect(() => {
    if (open && template) {
      setForm({
        name: template.name || '',
        api_url: template.api_url || '',
        ip_address: '',
        username: '',
        password: '',
        api_key: '',
        enabled: true,
      })
    }
  }, [open, template])

  if (!template) return null

  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }))

  const handleSubmit = () => {
    if (!(form.name || '').trim()) {
      toast.warning('请填写新设备名称')
      return
    }
    onSubmit({ ...form, name: form.name.trim(), ip_address: (form.ip_address || '').trim() })
  }

  return (
    <Modal
      open={open}
      title={`复用内置模板：${template.name}`}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving} className="btn-primary">
            {saving ? '创建中…' : `创建并复制 ${template.action_count ?? 0} 个动作`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          将完整复用该模板的基础信息（类别：{DEVICE_TYPE_LABELS[template.type] || template.type}，厂商：
          {vendorText(template.vendor, '未标注')}，版本：{template.version || '未标注'}，认证：
          {AUTH_LABELS[template.auth_type] || template.auth_type}）与全部 {template.action_count ?? 0} 个动作。
          账号/密码/API Key 等凭据不会写入模板，请在此填写。
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              新设备名称 <span className="text-destructive">*</span>
            </div>
            <input className={inputCls} value={form.name} onChange={(e) => set('name')(e.target.value)} />
          </label>
          <label className="col-span-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">API 基地址</div>
            <input
              className={inputCls}
              value={form.api_url}
              onChange={(e) => set('api_url')(e.target.value)}
              placeholder="留空则沿用模板地址"
            />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">设备 IP 地址</div>
            <input
              className={inputCls}
              value={form.ip_address}
              onChange={(e) => set('ip_address')(e.target.value)}
              placeholder="可选，如 10.0.0.10"
            />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">提交后状态</div>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={form.enabled} onChange={() => set('enabled')(!form.enabled)} />
              <span className="text-sm text-muted-foreground">{form.enabled ? '启用' : '停用'}</span>
            </div>
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">用户名</div>
            <input
              className={inputCls}
              value={form.username}
              onChange={(e) => set('username')(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">密码</div>
            <input
              type="password"
              className={inputCls}
              value={form.password}
              onChange={(e) => set('password')(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="col-span-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {template.auth_type === 'sangfor_xdr' ? '联动码（AK/SK）' : 'API Key / Token'}
            </div>
            <input
              className={inputCls}
              value={form.api_key}
              onChange={(e) => set('api_key')(e.target.value)}
              placeholder={template.auth_type === 'sangfor_xdr' ? '粘贴深信服 XDR 联动码' : ''}
              autoComplete="off"
            />
          </label>
        </div>
      </div>
    </Modal>
  )
}

// ============ 操作日志 ============
function LogsModal({ open, template, logs, loading, onClose }) {
  const ACTION_LABELS = {
    create: '新增条目',
    update: '修改基础信息',
    delete: '删除条目',
    import: '从设备识别入库',
    instantiate: '复用模板创建设备',
    create_action: '新增动作',
    update_action: '修改动作',
    delete_action: '删除动作',
  }
  return (
    <Modal open={open} title={`操作记录：${template?.name || ''}`} onClose={onClose} maxWidth="max-w-2xl">
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
      ) : logs.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">暂无操作记录</div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">时间</th>
                <th className="px-3 py-2 text-left font-medium">操作者</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
                <th className="px-3 py-2 text-left font-medium">IP</th>
                <th className="px-3 py-2 text-left font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((lg) => (
                <tr key={lg.id} className="border-t border-border">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{fmtTime(lg.created_at)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{lg.username || '-'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{ACTION_LABELS[lg.action] || lg.action}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                    {lg.ip_address || '-'}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    <span className="line-clamp-2 break-all" title={lg.detail || ''}>
                      {lg.detail || '-'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ============ 主页面 ============
export default function BuiltinDeviceLibrary() {
  const [items, setItems] = useState([])
  const [facets, setFacets] = useState({ types: [], vendors: [] })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [vendorFilter, setVendorFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [expanded, setExpanded] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [actionsMap, setActionsMap] = useState({})
  const [actionsLoading, setActionsLoading] = useState({})

  const [formOpen, setFormOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState(null)
  const [savingTemplate, setSavingTemplate] = useState(false)

  const [importOpen, setImportOpen] = useState(false)
  const [importDevices, setImportDevices] = useState([])
  const [importLoading, setImportLoading] = useState(false)
  const [importSaving, setImportSaving] = useState(false)

  const [instantiateOpen, setInstantiateOpen] = useState(false)
  const [instantiateTemplate, setInstantiateTemplate] = useState(null)
  const [instantiating, setInstantiating] = useState(false)

  const [actionModalOpen, setActionModalOpen] = useState(false)
  const [editingAction, setEditingAction] = useState(null)
  const [actionTemplateId, setActionTemplateId] = useState(null)
  const [savingAction, setSavingAction] = useState(false)

  const [logsOpen, setLogsOpen] = useState(false)
  const [logsTemplate, setLogsTemplate] = useState(null)
  const [logs, setLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)

  const templatesReqSeq = useRef(0)

  const loadTemplates = useCallback(async () => {
    // 竞态守卫：筛选/搜索快速变化时旧请求可能后返回，
    // 序号不匹配的过期响应直接丢弃，避免旧结果覆盖新筛选
    const seq = ++templatesReqSeq.current
    setLoading(true)
    try {
      const res = await devicesApi.builtinTemplates.list({
        search,
        type: typeFilter,
        vendor: vendorFilter,
        source: sourceFilter,
      })
      if (seq !== templatesReqSeq.current) return
      setItems(res?.items || [])
      setFacets({ types: res?.types || [], vendors: res?.vendors || [] })
    } catch (err) {
      if (seq !== templatesReqSeq.current) return
      toast.error(err.message || '加载内置设备库失败')
    } finally {
      if (seq === templatesReqSeq.current) setLoading(false)
    }
  }, [search, typeFilter, vendorFilter, sourceFilter])

  useEffect(() => {
    const timer = setTimeout(loadTemplates, search ? 250 : 0)
    return () => clearTimeout(timer)
  }, [loadTemplates, search])

  const groups = useMemo(() => {
    const typeMap = new Map()
    for (const t of items) {
      const type = t.type || 'custom'
      if (!typeMap.has(type)) typeMap.set(type, new Map())
      const vendorMap = typeMap.get(type)
      const vendor = vendorText(t.vendor)
      if (!vendorMap.has(vendor)) vendorMap.set(vendor, [])
      vendorMap.get(vendor).push(t)
    }
    return Array.from(typeMap.entries()).map(([type, vendorMap]) => ({
      type,
      count: Array.from(vendorMap.values()).reduce((sum, arr) => sum + arr.length, 0),
      vendors: Array.from(vendorMap.entries()).map(([vendor, list]) => ({ vendor, list })),
    }))
  }, [items])

  const loadActions = async (templateId) => {
    setActionsLoading((p) => ({ ...p, [templateId]: true }))
    try {
      const res = await devicesApi.builtinTemplates.listActions(templateId)
      setActionsMap((p) => ({ ...p, [templateId]: res || [] }))
    } catch (err) {
      toast.error(err.message || '加载模板动作失败')
    } finally {
      setActionsLoading((p) => ({ ...p, [templateId]: false }))
    }
  }

  const toggleExpand = (template) => {
    const next = !expanded[template.id]
    setExpanded((p) => ({ ...p, [template.id]: next }))
    if (next && !actionsMap[template.id]) loadActions(template.id)
  }

  const refreshTemplate = async (templateId) => {
    await loadTemplates()
    if (expanded[templateId]) await loadActions(templateId)
  }

  // ---- 模板基础信息 ----
  const handleSaveTemplate = async (payload) => {
    setSavingTemplate(true)
    try {
      if (editingTemplate) {
        await devicesApi.builtinTemplates.update(editingTemplate.id, payload)
        toast.success('模板已更新')
      } else {
        await devicesApi.builtinTemplates.create(payload)
        toast.success('内置条目已新增')
      }
      await loadTemplates()
      return true
    } catch (err) {
      toast.error(err.message || '保存模板失败')
      return false
    } finally {
      setSavingTemplate(false)
    }
  }

  const handleDeleteTemplate = async (template) => {
    const ok = window.confirm(
      `确认删除内置模板「${template.name}」？\n\n该操作会同时删除其下 ${template.action_count ?? 0} 个固化动作，且不可恢复。\n仅在确认不再使用该模板时才继续。`
    )
    if (!ok) return
    try {
      await devicesApi.builtinTemplates.remove(template.id)
      toast.success('内置模板已删除')
      setExpanded((p) => {
        const next = { ...p }
        delete next[template.id]
        return next
      })
      await loadTemplates()
    } catch (err) {
      toast.error(err.message || '删除模板失败')
    }
  }

  // ---- 从设备入库 ----
  const openImport = async () => {
    setImportOpen(true)
    setImportLoading(true)
    try {
      const res = await devicesApi.list()
      setImportDevices(Array.isArray(res) ? res : res?.items || [])
    } catch (err) {
      toast.error(err.message || '加载设备列表失败')
      setImportDevices([])
    } finally {
      setImportLoading(false)
    }
  }

  const handleImport = async (payload) => {
    if (!payload.device_id) {
      toast.warning('请选择源设备')
      return
    }
    setImportSaving(true)
    try {
      const created = await devicesApi.builtinTemplates.fromDevice(payload)
      toast.success(`已识别入库，固化 ${created?.action_count ?? 0} 个动作`)
      setImportOpen(false)
      await loadTemplates()
      if (created?.id) {
        setExpanded((p) => ({ ...p, [created.id]: true }))
        loadActions(created.id)
      }
    } catch (err) {
      toast.error(err.message || '识别入库失败')
    } finally {
      setImportSaving(false)
    }
  }

  // ---- 复用模板创建设备 ----
  const handleInstantiate = async (payload) => {
    if (!instantiateTemplate) return
    setInstantiating(true)
    try {
      const res = await devicesApi.builtinTemplates.instantiate(instantiateTemplate.id, payload)
      toast.success(
        `设备「${res?.device?.name || payload.name}」已创建，已复制 ${res?.actions_created ?? 0} 个动作`
      )
      setInstantiateOpen(false)
      setInstantiateTemplate(null)
      await loadTemplates()
    } catch (err) {
      toast.error(err.message || '复用模板创建设备失败')
    } finally {
      setInstantiating(false)
    }
  }

  // ---- 模板动作 ----
  const openCreateAction = (templateId) => {
    setActionTemplateId(templateId)
    setEditingAction(null)
    setActionModalOpen(true)
  }

  const openEditAction = (templateId, action) => {
    setActionTemplateId(templateId)
    setEditingAction(action)
    setActionModalOpen(true)
  }

  const handleSaveAction = async (form) => {
    setSavingAction(true)
    try {
      const payload = {
        name: form.name,
        action_type: form.action_type,
        http_method: form.http_method,
        api_path: form.api_path,
        params_schema: form.params_schema,
        headers: form.headers,
        body_template: form.body_template,
        // 透传用户选择：'inherit'（继承设备认证）与 'api_key' 在执行器中
        // 行为不同（设备级签名 vs Bearer 头），不能静默改写语义
        auth_type: form.auth_type,
        enabled: form.enabled,
        description: form.description,
        category: form.category,
        risk_level: form.risk_level,
        example_payload: form.example_payload || null,
        example_response: form.example_response || null,
      }
      if (editingAction) {
        await devicesApi.builtinTemplates.updateAction(actionTemplateId, editingAction.id, payload)
        toast.success('模板动作已更新')
      } else {
        await devicesApi.builtinTemplates.createAction(actionTemplateId, payload)
        toast.success('模板动作已新增')
      }
      setActionModalOpen(false)
      setEditingAction(null)
      await refreshTemplate(actionTemplateId)
      return true
    } catch (err) {
      toast.error(err.message || '保存模板动作失败')
      return false
    } finally {
      setSavingAction(false)
    }
  }

  const handleDeleteAction = async (templateId, action) => {
    if (!window.confirm(`确认删除动作「${action.name}」？该操作不可恢复。`)) return
    try {
      await devicesApi.builtinTemplates.removeAction(templateId, action.id)
      toast.success('模板动作已删除')
      await refreshTemplate(templateId)
    } catch (err) {
      toast.error(err.message || '删除模板动作失败')
    }
  }

  // ---- 操作日志 ----
  const openLogs = async (template) => {
    setLogsTemplate(template)
    setLogsOpen(true)
    setLogs([])
    setLogsLoading(true)
    try {
      const res = await devicesApi.builtinTemplates.logs(template.id, 50)
      setLogs(res?.items || [])
    } catch (err) {
      toast.error(err.message || '加载操作日志失败')
    } finally {
      setLogsLoading(false)
    }
  }

  const totalActions = items.reduce((sum, t) => sum + (t.action_count || 0), 0)

  return (
    <PageContainer>
      <PageHeader
        title="内置设备库"
        description="系统内置设备模板与固化动作，可直接复用创建设备，无需重复配置"
        actions={
          <>
            <button type="button" onClick={loadTemplates} className="btn-secondary" title="刷新">
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button type="button" onClick={openImport} className="btn-secondary">
              <Inbox className="mr-1.5 h-4 w-4" />
              从现有设备入库
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingTemplate(null)
                setFormOpen(true)
              }}
              className="btn-primary"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              新增内置条目
            </button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputCls} pl-9`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模板名称 / 厂商 / 协议版本 / 描述"
          />
        </div>
        <CompactSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} size="lg">
          <option value="">全部设备类别</option>
          {DEVICE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </CompactSelect>
        <CompactSelect value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} size="lg">
          <option value="">全部厂商</option>
          {facets.vendors
            .filter((v) => v.value && !isDeviceCategory(v.value))
            .map((v) => (
              <option key={v.value} value={v.value}>
                {v.value}（{v.count}）
              </option>
            ))}
        </CompactSelect>
        <CompactSelect value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} size="lg">
          {SOURCE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </CompactSelect>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            条目 <span className="font-mono text-foreground">{items.length}</span>
          </span>
          <span>
            固化动作 <span className="font-mono text-foreground">{totalActions}</span>
          </span>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 w-full rounded-lg skeleton-shimmer" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center">
          <Boxes className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">暂无匹配的内置设备模板</div>
          <div className="mt-1 text-xs text-muted-foreground">
            可点击「从现有设备入库」将已对接设备固化为模板，或手动新增条目
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const collapsed = !!collapsedGroups[group.type]
            return (
              <section key={group.type} className="overflow-hidden rounded-lg border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setCollapsedGroups((p) => ({ ...p, [group.type]: !collapsed }))}
                  className="flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors hover:bg-accent"
                >
                  {collapsed ? (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <DeviceTypeIcon type={group.type} className="h-4 w-4" />
                  </span>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    设备类别
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    {DEVICE_TYPE_LABELS[group.type] || group.type}
                  </span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {group.count}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {group.vendors.length} 个厂商
                  </span>
                </button>

                {!collapsed && (
                  <div className="flex flex-col gap-3 p-4">
                    {group.vendors.map(({ vendor, list }) => (
                      <div key={`${group.type}-${vendor}`}>
                        <div className="mb-2 flex items-center gap-2 px-1">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            厂商
                          </span>
                          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            {vendor}
                          </span>
                          <span className="h-px flex-1 bg-border" />
                          <span className="text-[10px] text-muted-foreground">{list.length} 个模板</span>
                        </div>
                        <div className="flex flex-col gap-2">
                          {list.map((tpl) => {
                            const isOpen = !!expanded[tpl.id]
                            const source = SOURCE_META[tpl.source] || SOURCE_META.manual
                            const actions = actionsMap[tpl.id] || []
                            return (
                              <div
                                key={tpl.id}
                                className={`overflow-hidden rounded-md border transition-colors ${
                                  isOpen
                                    ? 'border-primary/60 bg-primary/5'
                                    : 'border-border bg-background hover:border-primary/40'
                                }`}
                              >
                                <div className="flex items-center gap-3 px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => toggleExpand(tpl)}
                                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                  >
                                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/15 text-primary">
                                      <DeviceTypeIcon type={tpl.type} className="h-5 w-5" />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-semibold text-foreground">
                                          {tpl.name}
                                        </span>
                                        <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${source.cls}`}>
                                          {source.label}
                                        </span>
                                        {tpl.code && (
                                          <span className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                            {tpl.code}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                        <span>类别 {DEVICE_TYPE_LABELS[tpl.type] || tpl.type}</span>
                                        <span>·</span>
                                        <span>厂商 {vendorText(tpl.vendor)}</span>
                                        <span>·</span>
                                        <span>协议版本 {tpl.version || '未标注'}</span>
                                        <span>·</span>
                                        <span>认证 {AUTH_LABELS[tpl.auth_type] || tpl.auth_type}</span>
                                        <span>·</span>
                                        <span>
                                          动作 <span className="font-mono text-foreground">{tpl.action_count ?? 0}</span>
                                        </span>
                                        {tpl.source_device_name && (
                                          <>
                                            <span>·</span>
                                            <span title="快照来源设备">来源 {tpl.source_device_name}</span>
                                          </>
                                        )}
                                      </div>
                                      {tpl.description && (
                                        <div className="mt-1 truncate text-[11px] text-muted-foreground" title={tpl.description}>
                                          {tpl.description}
                                        </div>
                                      )}
                                    </div>
                                  </button>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setInstantiateTemplate(tpl)
                                        setInstantiateOpen(true)
                                      }}
                                      className="btn-primary btn-sm"
                                      title="复用该模板创建设备"
                                    >
                                      <Copy className="mr-1 h-3 w-3" />
                                      复用创建
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openLogs(tpl)}
                                      className="btn-secondary btn-sm"
                                      title="操作记录"
                                    >
                                      <FileClock className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingTemplate(tpl)
                                        setFormOpen(true)
                                      }}
                                      className="btn-secondary btn-sm"
                                    >
                                      <Pencil className="mr-1 h-3 w-3" />
                                      编辑
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteTemplate(tpl)}
                                      className="btn-danger btn-sm"
                                    >
                                      <Trash2 className="mr-1 h-3 w-3" />
                                      删除
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => toggleExpand(tpl)}
                                      className="btn-secondary btn-sm"
                                      title={isOpen ? '收起' : '展开动作'}
                                    >
                                      {isOpen ? (
                                        <ChevronDown className="h-3.5 w-3.5" />
                                      ) : (
                                        <ChevronRight className="h-3.5 w-3.5" />
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {isOpen && (
                                  <div className="expand-in border-t border-border bg-background px-4 py-4">
                                    <div className="mb-3 flex items-center justify-between">
                                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        固化动作（{actionsLoading[tpl.id] ? '...' : actions.length} 个）
                                      </h3>
                                      <button
                                        type="button"
                                        onClick={() => openCreateAction(tpl.id)}
                                        className="btn-primary btn-sm"
                                      >
                                        <Plus className="mr-1 h-3 w-3" />
                                        新增动作
                                      </button>
                                    </div>
                                    {actionsLoading[tpl.id] ? (
                                      <div className="h-20 w-full rounded skeleton-shimmer" />
                                    ) : actions.length === 0 ? (
                                      <div className="rounded-md border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                                        该模板暂无动作，点击「新增动作」补充
                                      </div>
                                    ) : (
                                      <div className="overflow-x-auto rounded-md border border-border">
                                        <table className="w-full min-w-[900px] table-fixed border-collapse text-sm">
                                          <thead className="bg-card text-muted-foreground">
                                            <tr>
                                              <th className="w-12 px-3 py-2.5 text-left font-medium">ID</th>
                                              <th className="w-56 px-3 py-2.5 text-left font-medium">动作名称</th>
                                              <th className="w-20 px-3 py-2.5 text-left font-medium">分类</th>
                                              <th className="w-16 px-3 py-2.5 text-left font-medium">方法</th>
                                              <th className="px-3 py-2.5 text-left font-medium">API 路径</th>
                                              <th className="w-20 px-3 py-2.5 text-right font-medium">参数</th>
                                              <th className="w-16 px-3 py-2.5 text-center font-medium">风险</th>
                                              <th className="w-16 px-3 py-2.5 text-center font-medium">启用</th>
                                              <th className="w-32 px-3 py-2.5 text-left font-medium">操作</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {actions.map((a) => (
                                              <tr key={a.id} className="border-t border-border hover:bg-accent">
                                                <td className="px-3 py-2.5 font-mono text-[11px] text-primary">#{a.id}</td>
                                                <td className="truncate px-3 py-2.5 text-foreground" title={a.name}>
                                                  {a.name}
                                                </td>
                                                <td className="px-3 py-2.5">
                                                  <CategoryBadge category={a.category} />
                                                </td>
                                                <td className="px-3 py-2.5">
                                                  <MethodBadge method={a.http_method} />
                                                </td>
                                                <td className="truncate px-3 py-2.5 font-mono text-[11px] text-muted-foreground" title={a.api_path}>
                                                  {a.api_path || '-'}
                                                </td>
                                                <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                                                  {actionParamCount(a)}
                                                </td>
                                                <td className="px-3 py-2.5 text-center">
                                                  <RiskBadge level={a.risk_level} />
                                                </td>
                                                <td className="px-3 py-2.5 text-center">
                                                  <span
                                                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                                                      a.enabled ? 'bg-success' : 'bg-muted-foreground'
                                                    }`}
                                                    title={a.enabled ? '已启用' : '已停用'}
                                                  />
                                                </td>
                                                <td className="px-3 py-2.5">
                                                  <div className="flex items-center gap-1 whitespace-nowrap">
                                                    <button
                                                      type="button"
                                                      onClick={() => openEditAction(tpl.id, a)}
                                                      className="btn-secondary btn-sm"
                                                    >
                                                      编辑
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() => handleDeleteAction(tpl.id, a)}
                                                      className="btn-danger btn-sm"
                                                    >
                                                      删除
                                                    </button>
                                                  </div>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <TemplateFormModal
        open={formOpen}
        initial={editingTemplate}
        onClose={() => {
          setFormOpen(false)
          setEditingTemplate(null)
        }}
        onSubmit={handleSaveTemplate}
        saving={savingTemplate}
      />

      <ImportFromDeviceModal
        open={importOpen}
        devices={importDevices}
        loading={importLoading}
        onClose={() => setImportOpen(false)}
        onSubmit={handleImport}
        saving={importSaving}
      />

      <InstantiateModal
        open={instantiateOpen}
        template={instantiateTemplate}
        onClose={() => {
          setInstantiateOpen(false)
          setInstantiateTemplate(null)
        }}
        onSubmit={handleInstantiate}
        saving={instantiating}
      />

      <ActionFormModal
        open={actionModalOpen}
        initial={editingAction}
        onClose={() => {
          setActionModalOpen(false)
          setEditingAction(null)
        }}
        onSubmit={handleSaveAction}
        saving={savingAction}
      />

      <LogsModal
        open={logsOpen}
        template={logsTemplate}
        logs={logs}
        loading={logsLoading}
        onClose={() => setLogsOpen(false)}
      />
    </PageContainer>
  )
}
