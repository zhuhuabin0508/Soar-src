import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { systemConfigApi } from '../api/systemConfig'
import { toast } from '../store/toastStore'
import { hasPermission } from '../utils/permissions'
import {
  TextInput,
  TextArea,
  NumberInput,
  CheckRow,
  SelectInput,
  inputBaseCls,
  labelCls,
} from '../components/property/FormControls'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { confirm } from '../components/ConfirmDialog'
import InfoTip from '../components/InfoTip'
import { validateIPExpression } from '../utils/ipValidation'
import {
  Eye, Smartphone, Network, Bell, CheckSquare, Link2,
  X, Check, RotateCcw, ShieldCheck, AlertTriangle, Palette, Globe,
  ChevronDown, ChevronRight, Type, SlidersHorizontal, Database, Monitor,
  ExternalLink, KeyRound, Lock, ShieldAlert,
} from 'lucide-react'

// 安全策略默认值（与后端 DEFAULT_SECURITY_POLICY 对应）
const DEFAULT_SECURITY_POLICY = {
  'security.session_timeout_minutes': 480,
  'security.max_login_attempts': 5,
  'security.lockout_duration_minutes': 15,
  'security.lockout_auto_unlock': true,
  'security.password_min_length': 8,
  'security.password_require_uppercase': true,
  'security.password_require_lowercase': true,
  'security.password_require_digit': true,
  'security.password_require_special': true,
  'security.password_expiry_days': 0,
  'security.password_history_count': 3,
  'security.mfa_enabled': false,
  'security.login_ip_whitelist': '',
  'security.login_notification': true,
  'security.audit_log_retention_days': 90,
  'security.sensitive_op_confirm': true,
  'security.sso_enabled': false,
  'security.sso_provider': '',
  'security.sso_config': '',
}

// 等保合规模板：二级 / 三级 / 自定义
const COMPLIANCE_TEMPLATES = {
  level2: {
    label: '等保二级',
    desc: '适用于一般业务系统，基础安全要求',
    summary: '密码 8 位 · MFA 关闭 · 90天过期',
    policy: {
      'security.session_timeout_minutes': 480,
      'security.max_login_attempts': 5,
      'security.lockout_duration_minutes': 15,
      'security.lockout_auto_unlock': true,
      'security.password_min_length': 8,
      'security.password_require_uppercase': true,
      'security.password_require_lowercase': true,
      'security.password_require_digit': true,
      'security.password_require_special': false,
      'security.password_expiry_days': 90,
      'security.password_history_count': 3,
      'security.mfa_enabled': false,
      'security.login_notification': true,
      'security.audit_log_retention_days': 90,
      'security.sensitive_op_confirm': true,
    },
  },
  level3: {
    label: '等保三级',
    desc: '适用于重要业务系统，增强安全要求',
    summary: '密码 12 位 · MFA 开启 · 60天过期',
    policy: {
      'security.session_timeout_minutes': 240,
      'security.max_login_attempts': 3,
      'security.lockout_duration_minutes': 30,
      'security.lockout_auto_unlock': true,
      'security.password_min_length': 12,
      'security.password_require_uppercase': true,
      'security.password_require_lowercase': true,
      'security.password_require_digit': true,
      'security.password_require_special': true,
      'security.password_expiry_days': 60,
      'security.password_history_count': 5,
      'security.mfa_enabled': true,
      'security.login_notification': true,
      'security.audit_log_retention_days': 180,
      'security.sensitive_op_confirm': true,
    },
  },
  custom: { label: '自定义', desc: '按需自由配置', summary: '按需自由配置', policy: null },
}

// 主题色预设色板（8 个常用品牌色）
const PRESET_COLORS = [
  '#22D3EE', '#6366F1', '#10B981', '#F59E0B',
  '#EF4444', '#8B5CF6', '#EC4899', '#3B82F6',
]

// ============ 本地通用组件 ============

// 带可选 InfoTip 的字段标签（复刻 FormControls 里的 LabelWithTip）
function FieldLabel({ label, hint, required, badge }) {
  if (!label) return null
  const requiredMark = required ? <span className="text-destructive">*</span> : null
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <label className={labelCls + ' mb-0'}>{label}{requiredMark}</label>
      {hint && <InfoTip text={hint} />}
      {badge && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {badge}
        </span>
      )}
    </div>
  )
}

// 分组容器：卡片分区（图标 + 标题 + 描述 + InfoTip + 可选折叠），替代引入的 Section
// collapsible + defaultCollapsed：非核心分区默认折叠，点击标题行展开/收起；
// 折叠仅隐藏子内容，表单值由父组件受控 state 持有，展开后不丢失
function SettingsSection({ title, description, icon: Icon, hint, collapsible = false, defaultCollapsed = false, className = '', children }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className={`rounded-lg border border-border bg-card p-5 shadow-sm ${className}`}>
      <div className={`flex items-center gap-2 ${collapsed ? 'mb-0' : 'mb-4'}`}>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-primary" />}
        {collapsible ? (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="truncate text-sm font-semibold text-foreground transition hover:text-primary">{title}</span>
            {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
            {collapsed
              ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </button>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description && <span className="text-xs text-muted-foreground">{description}</span>}
          </>
        )}
        {hint && <InfoTip text={hint} />}
      </div>
      {!collapsed && <div className="flex flex-col gap-5">{children}</div>}
    </div>
  )
}

// 主题色选择器：色块按钮 + popover（原生取色器 + 预设色板 + Hex 输入校验）
function ColorPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [hexInput, setHexInput] = useState(value || '')
  const btnRef = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => { setHexInput(value || '') }, [value])

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      const popoverW = 256
      const popoverH = 260
      const spaceBelow = window.innerHeight - rect.bottom
      const showBelow = spaceBelow > popoverH
      setPos({
        top: showBelow ? rect.bottom + 6 : Math.max(8, rect.top - popoverH - 6),
        left: Math.min(Math.max(8, rect.left), window.innerWidth - popoverW - 8),
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    const handler = (e) => {
      if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      document.removeEventListener('mousedown', handler)
    }
  }, [open])

  const isValidHex = (h) => /^#[0-9A-Fa-f]{6}$/.test(h)
  const current = isValidHex(value) ? value : '#6366f1'
  const hexInvalid = hexInput !== '' && !isValidHex(hexInput)

  const handleHexChange = (v) => {
    setHexInput(v)
    if (isValidHex(v)) onChange(v)
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm transition hover:border-primary/50 ${open ? 'border-primary ring-1 ring-primary' : ''}`}
      >
        <span className="h-5 w-5 shrink-0 rounded border border-border" style={{ background: current }} />
        <span className="flex-1 text-left text-foreground">{value || '点击选择颜色'}</span>
        <Palette className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && createPortal(
        <div
          className="fixed z-[9999] w-60 rounded-lg border border-border bg-card p-3 shadow-xl"
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 原生取色器 */}
          <div className="mb-3">
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">取色器</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={current}
                onChange={(e) => { onChange(e.target.value); setHexInput(e.target.value) }}
                className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
              />
              <span className="text-xs text-muted-foreground">{current.toUpperCase()}</span>
            </div>
          </div>
          {/* 预设色板 */}
          <div className="mb-3">
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">预设色板</span>
            <div className="grid grid-cols-8 gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { onChange(c); setHexInput(c) }}
                  className={`h-6 w-6 rounded border-2 transition hover:scale-110 ${value?.toLowerCase() === c.toLowerCase() ? 'border-foreground' : 'border-transparent'}`}
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
          {/* Hex 输入 */}
          <div>
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">Hex 值</span>
            <input
              className={`${inputBaseCls} w-full ${hexInvalid ? 'border-destructive ring-1 ring-destructive' : ''}`}
              value={hexInput}
              onChange={(e) => handleHexChange(e.target.value)}
              placeholder="#6366F1"
            />
            {hexInvalid && <p className="mt-1 text-[10px] text-destructive">格式无效，需为 #RRGGBB</p>}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// Tag 输入：逗号分隔字符串 ↔ 标签数组，支持回车添加 / 粘贴拆分 / 单个删除
function TagInput({ value, onChange, placeholder, validateTag }) {
  const tags = useMemo(() => {
    if (!value) return []
    return String(value).split(',').map((s) => s.trim()).filter(Boolean)
  }, [value])

  const [input, setInput] = useState('')

  const commit = (newTags) => onChange(newTags.join(','))

  const addTags = (text) => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length === 0) return
    // 可选：提交前逐项校验（如登录 IP 白名单）
    if (validateTag) {
      for (const p of parts) {
        const msg = validateTag(p)
        if (msg) { toast.error(msg); return }
      }
    }
    const merged = [...tags]
    parts.forEach((p) => { if (!merged.includes(p)) merged.push(p) })
    commit(merged)
    setInput('')
  }

  const removeTag = (tag) => commit(tags.filter((t) => t !== tag))

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTags(input)
    } else if (e.key === 'Backspace' && !input && tags.length) {
      removeTag(tags[tags.length - 1])
    }
  }

  const handlePaste = (e) => {
    e.preventDefault()
    addTags(e.clipboardData.getData('text'))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background p-1.5 transition focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
          <span className="max-w-[200px] truncate">{tag}</span>
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="flex items-center transition hover:text-destructive"
            title="删除"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => { if (input) addTags(input) }}
        placeholder={tags.length === 0 ? placeholder : ''}
      />
    </div>
  )
}

// 带后缀的数字输入：input[type=number] + 右侧灰色后缀
function BigscreenDockFields({ prefix, configs, setField }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <TextInput label="免登账号" value={configs[`${prefix}.username`] || ''} onChange={setField(`${prefix}.username`)} placeholder="CIM 登录用户名" required hint="对方平台登录账号，不要填到 code 里" />
      <div>
        <FieldLabel label="免登密码" hint="填明文密码，保存后由后端调用加密接口再换 token" required />
        <input
          type="password"
          autoComplete="new-password"
          className={inputBaseCls}
          value={configs[`${prefix}.password`] || ''}
          onChange={(e) => setField(`${prefix}.password`)(e.target.value)}
          placeholder="CIM 登录明文密码"
        />
      </div>
      <TextInput label="平台基址" value={configs[`${prefix}.base_url`] || ''} onChange={setField(`${prefix}.base_url`)} placeholder="http://10.132.109.75" />
      <TextInput label="跳转路径" value={configs[`${prefix}.path`] || ''} onChange={setField(`${prefix}.path`)} placeholder="/city/#/bigscreen" />
      <TextInput label="大屏编号 code" value={configs[`${prefix}.code`] || ''} onChange={setField(`${prefix}.code`)} placeholder="对方提供的大屏 ID" hint="对接文档里的 code，不是用户名" />
      <TextInput label="应用 ID appid" value={configs[`${prefix}.appid`] || ''} onChange={setField(`${prefix}.appid`)} placeholder="对方提供的应用 ID" hint="对接文档里的 appid，不是密码" />
      <SelectInput
        label="登录方式"
        value={configs[`${prefix}.usergroupid`] || '0'}
        onChange={setField(`${prefix}.usergroupid`)}
        options={[
          { value: '0', label: '账号登录' },
          { value: '1', label: '市认证登录' },
        ]}
      />
    </div>
  )
}

function NumberWithSuffix({ label, value, onChange, min, max, step, hint, suffix, badge }) {
  return (
    <div>
      <FieldLabel label={label} hint={hint} badge={badge} />
      <div className="flex items-center gap-2">
        <input
          type="number"
          className={`${inputBaseCls} flex-1`}
          value={value ?? 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  )
}

// ============ 主组件 ============

function SystemSettings() {
  const [activeTab, setActiveTab] = useState('basic')

  // 基础配置
  const [configs, setConfigs] = useState({})
  const [origConfigs, setOrigConfigs] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 安全策略
  const [security, setSecurity] = useState({ ...DEFAULT_SECURITY_POLICY })
  const [origSecurity, setOrigSecurity] = useState({ ...DEFAULT_SECURITY_POLICY })
  const [securityLoading, setSecurityLoading] = useState(false)
  const [securitySaving, setSecuritySaving] = useState(false)
  const [securityLoaded, setSecurityLoaded] = useState(false)
  const [securityError, setSecurityError] = useState('')

  // 测试连接状态
  const [corsTesting, setCorsTesting] = useState(false)
  const [corsTestResult, setCorsTestResult] = useState(null)
  const [corsTestOrigin, setCorsTestOrigin] = useState('')
  const [webhookTesting, setWebhookTesting] = useState(false)
  const [webhookTestResult, setWebhookTestResult] = useState(null)

  const canView = hasPermission('system_config', 'view')
  const canEdit = hasPermission('system_config', 'edit')

  const load = useCallback(async () => {
    if (!canView) { setError('您没有查看系统配置的权限'); setLoading(false); return }
    try {
      const data = await systemConfigApi.list()
      const map = {}
      ;(Array.isArray(data) ? data : []).forEach((c) => { map[c.key] = c.value || '' })
      setConfigs(map); setOrigConfigs(map); setError('')
    } catch (err) { setError(err.message || '加载失败') } finally { setLoading(false) }
  }, [canView])

  const loadSecurity = useCallback(async () => {
    if (!canView) { setSecurityError('您没有查看系统配置的权限'); return }
    setSecurityLoading(true)
    try {
      const data = await systemConfigApi.getSecurity()
      const policy = { ...DEFAULT_SECURITY_POLICY, ...(data?.policy || {}) }
      setSecurity(policy); setOrigSecurity(policy); setSecurityError(''); setSecurityLoaded(true)
    } catch (err) { setSecurityError(err.message || '加载安全策略失败') } finally { setSecurityLoading(false) }
  }, [canView])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (activeTab === 'security' && !securityLoaded) loadSecurity() }, [activeTab, securityLoaded, loadSecurity])

  const setField = (key) => (value) => setConfigs((prev) => ({ ...prev, [key]: value }))
  const setSecurityField = (key) => (value) => setSecurity((prev) => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    const changed = {}
    Object.keys(configs).forEach((k) => { if (configs[k] !== origConfigs[k]) changed[k] = configs[k] })
    if (Object.keys(changed).length === 0) { toast.warning('没有需要保存的变更'); return }
    setSaving(true)
    try {
      await systemConfigApi.update(changed); setOrigConfigs({ ...configs })
      toast.success(`已保存 ${Object.keys(changed).length} 项配置`)
      if (changed.primary_color) applyThemeColor(changed.primary_color)
      bypassGuard()
    } catch (err) { toast.error(`保存失败：${err.message || err}`) } finally { setSaving(false) }
  }

  const handleSaveSecurity = async () => {
    // IP 白名单格式硬拦截（与后端统一规则）
    const wlMsg = validateIPExpression(
      security['security.login_ip_whitelist'], '登录 IP 白名单',
    )
    if (wlMsg) { toast.error(wlMsg); return }
    const changed = {}
    Object.keys(security).forEach((k) => { if (security[k] !== origSecurity[k]) changed[k] = security[k] })
    if (Object.keys(changed).length === 0) { toast.warning('没有需要保存的变更'); return }
    setSecuritySaving(true)
    try {
      await systemConfigApi.updateSecurity(changed); setOrigSecurity({ ...security })
      toast.success(`安全策略已保存（共 ${Object.keys(changed).length} 项）`); bypassGuard()
    } catch (err) { toast.error(`保存失败：${err.message || err}`) } finally { setSecuritySaving(false) }
  }

  const applyThemeColor = (color) => { try { document.documentElement.style.setProperty('--brand-color', color) } catch { /* ignore */ } }

  const basicDirty = Object.keys(configs).some((k) => configs[k] !== origConfigs[k])
  const securityDirty = Object.keys(security).some((k) => security[k] !== origSecurity[k])
  const dirty = activeTab === 'security' ? securityDirty : basicDirty
  const bypassGuard = useUnsavedChanges(dirty)
  const isSaving = activeTab === 'security' ? securitySaving : saving
  const tabError = activeTab === 'security' ? securityError : error

  const handleRefresh = () => { if (activeTab === 'security') loadSecurity(); else load() }
  const handleSaveClick = () => { if (activeTab === 'security') handleSaveSecurity(); else handleSave() }

  // 恢复默认配置
  const handleRestoreDefault = async () => {
    const ok = await confirm({
      title: '恢复默认配置',
      message: '确定要将当前 Tab 的所有配置恢复为默认值吗？此操作不可撤销。',
      confirmText: '恢复默认',
      cancelText: '取消',
      variant: 'danger',
    })
    if (!ok) return
    if (activeTab === 'security') {
      setSecurity({ ...DEFAULT_SECURITY_POLICY })
      toast.info('已恢复为默认安全策略，请确认后保存')
    } else {
      const cleared = {}
      Object.keys(configs).forEach((k) => { cleared[k] = '' })
      setConfigs(cleared)
      toast.info('已清空基础配置，请确认后保存')
    }
  }

  // Tab 切换前确认未保存更改
  const handleTabChange = async (key) => {
    if (key === activeTab) return
    if (dirty) {
      const ok = await confirm({
        title: '切换确认',
        message: '当前有未保存的更改，切换 Tab 将丢失这些更改，是否继续？',
        confirmText: '继续切换',
        cancelText: '取消',
        variant: 'warning',
      })
      if (!ok) return
    }
    setActiveTab(key)
  }

  // 应用等保模板（需二次确认）
  const handleTemplateClick = async (tmplKey) => {
    if (tmplKey === 'custom') return
    const tmpl = COMPLIANCE_TEMPLATES[tmplKey]
    const ok = await confirm({
      title: '应用合规模板',
      message: `将应用「${tmpl.label}」默认配置并覆盖当前安全设置，确定继续？`,
      confirmText: '应用模板',
      cancelText: '取消',
      variant: 'warning',
    })
    if (!ok) return
    setSecurity((prev) => ({ ...prev, ...tmpl.policy }))
    toast.info(`已套用「${tmpl.label}」模板，请确认后保存`)
  }

  // 自动检测当前配置匹配哪个模板
  const activeTemplate = useMemo(() => {
    for (const [key, tmpl] of Object.entries(COMPLIANCE_TEMPLATES)) {
      if (!tmpl.policy) continue
      const allMatch = Object.entries(tmpl.policy).every(([k, v]) => security[k] === v)
      if (allMatch) return key
    }
    return 'custom'
  }, [security])

  // 密码强度评估（用于密码策略可视化）
  const passwordStrength = useMemo(() => {
    const minLen = security['security.password_min_length'] || 0
    const reqs = [
      security['security.password_require_uppercase'],
      security['security.password_require_lowercase'],
      security['security.password_require_digit'],
      security['security.password_require_special'],
    ].filter(Boolean).length
    let score = 0
    if (minLen >= 8) score += 1
    if (minLen >= 12) score += 1
    if (reqs >= 2) score += 1
    if (reqs >= 4) score += 1
    if (security['security.password_expiry_days'] > 0) score += 1
    if (security['security.password_history_count'] > 0) score += 1
    const level = score <= 2 ? '弱' : score <= 4 ? '中' : '强'
    const levelColor = score <= 2 ? 'bg-destructive' : score <= 4 ? 'bg-warning' : 'bg-success'
    const parts = []
    parts.push(`${minLen} 位以上`)
    const types = []
    if (security['security.password_require_uppercase']) types.push('大写')
    if (security['security.password_require_lowercase']) types.push('小写')
    if (security['security.password_require_digit']) types.push('数字')
    if (security['security.password_require_special']) types.push('特殊字符')
    if (types.length) parts.push(`包含${types.join('、')}`)
    if (security['security.password_expiry_days'] > 0) parts.push(`每 ${security['security.password_expiry_days']} 天更换`)
    else parts.push('永不过期')
    if (security['security.password_history_count'] > 0) parts.push(`近 ${security['security.password_history_count']} 次不可重复`)
    else parts.push('不检查历史')
    return { score, level, levelColor, desc: parts.join('，') }
  }, [security])

  // 安全评分（总分 100，逐项扣分）
  const securityScore = useMemo(() => {
    let score = 100
    const failed = []
    const minLen = security['security.password_min_length'] || 0
    if (minLen < 8) { score -= 15; failed.push('密码最小长度不足 8 位') }
    else if (minLen < 12) { score -= 5; failed.push('密码最小长度不足 12 位（建议）') }
    if (!security['security.mfa_enabled']) { score -= 20; failed.push('MFA 未开启') }
    if ((security['security.password_expiry_days'] || 0) === 0) { score -= 10; failed.push('密码有效期未设置') }
    if ((security['security.password_history_count'] || 0) === 0) { score -= 5; failed.push('历史密码不检查') }
    if (!(security['security.login_ip_whitelist'] || '').trim()) { score -= 10; failed.push('IP 白名单未配置') }
    if (!security['security.login_notification']) { score -= 5; failed.push('登录通知未开启') }
    if ((security['security.audit_log_retention_days'] || 0) < 90) { score -= 10; failed.push('审计日志保留 < 90 天') }
    if (!security['security.sensitive_op_confirm']) { score -= 10; failed.push('敏感操作未确认') }
    score = Math.max(0, Math.min(100, score))
    const level = score >= 80 ? '高' : score >= 50 ? '中' : '低'
    const levelColor = score >= 80 ? 'success' : score >= 50 ? 'warning' : 'destructive'
    return { score, level, levelColor, failed }
  }, [security])

  // 测试 CORS
  const handleTestCors = async () => {
    if (!corsTestOrigin.trim()) { toast.warning('请输入要测试的 Origin'); return }
    setCorsTesting(true); setCorsTestResult(null)
    try {
      const res = await systemConfigApi.testCors(corsTestOrigin)
      setCorsTestResult(res)
    } catch (err) { setCorsTestResult({ ok: false, message: `测试失败：${err.message || err}` }) }
    finally { setCorsTesting(false) }
  }

  // 测试 Webhook 限流
  const handleTestWebhook = async () => {
    setWebhookTesting(true); setWebhookTestResult(null)
    try {
      const res = await systemConfigApi.testWebhook(configs.webhook_rate_limit || '')
      setWebhookTestResult(res)
    } catch (err) { setWebhookTestResult({ ok: false, message: `测试失败：${err.message || err}` }) }
    finally { setWebhookTesting(false) }
  }

  const tabs = [
    { key: 'basic', label: '基础配置' },
    { key: 'security', label: '安全设置' },
  ]

  // 评分等级对应的样式类
  const scoreLevelTextCls = securityScore.levelColor === 'success' ? 'text-success'
    : securityScore.levelColor === 'warning' ? 'text-warning' : 'text-destructive'
  const scoreLevelBarCls = securityScore.levelColor === 'success' ? 'bg-success'
    : securityScore.levelColor === 'warning' ? 'bg-warning' : 'bg-destructive'
  const scoreLevelBgCls = securityScore.levelColor === 'success' ? 'bg-success/10'
    : securityScore.levelColor === 'warning' ? 'bg-warning/10' : 'bg-destructive/10'

  // 当前主题色（用于预览）
  const previewColor = (() => {
    const c = configs.primary_color
    return /^#[0-9A-Fa-f]{6}$/.test(c) ? c : '#6366f1'
  })()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* ===== Header ===== */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">系统设置</h1>
          {dirty && (
            <span className="flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              有未保存的更改
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {activeTab === 'security' ? '等保安全策略配置' : `平台级配置（共 ${Object.keys(configs).length} 项）`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleRefresh} className="btn-secondary btn-sm">刷新</button>
          {canEdit && (
            <button type="button" onClick={handleRestoreDefault} className="btn-secondary btn-sm inline-flex items-center hover:!border-destructive/40 hover:!text-destructive">
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              恢复默认
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={isSaving || !dirty}
              className={`btn-primary btn-sm ${dirty ? 'ring-2 ring-primary/30' : ''}`}
            >
              {isSaving ? '保存中…' : '保存变更'}
            </button>
          )}
        </div>
      </header>

      {/* ===== Tab 栏 ===== */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-6">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => handleTabChange(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${activeTab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ===== 内容区 ===== */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {tabError && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{tabError}</div>
        )}

        {/* ===== 基础配置 Tab ===== */}
        {activeTab === 'basic' && (loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : (
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
            {/* 左：表单区 */}
            <div className="flex flex-col gap-4">
              {/* 平台基础 */}
              <SettingsSection title="平台基础" icon={Type} hint="控制顶栏品牌显示">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput label="平台名称" value={configs.platform_name || ''} onChange={setField('platform_name')} placeholder="如：SOAR 平台" />
                  <TextInput label="Logo URL" value={configs.logo_url || ''} onChange={setField('logo_url')} placeholder="https://example.com/logo.png" hint="留空则使用默认文字 Logo" />
                </div>
              </SettingsSection>

              {/* 主题色 */}
              <SettingsSection title="主题色" icon={Palette} hint="应用于按钮、链接等强调色">
                <ColorPicker value={configs.primary_color || ''} onChange={setField('primary_color')} />
              </SettingsSection>

              {/* 常用基础项 */}
              <SettingsSection title="常用基础项" icon={SlidersHorizontal} hint="系统语言、时区、上传限制等">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <SelectInput label="系统默认语言" value={configs['system.default_language'] || 'zh-CN'} onChange={setField('system.default_language')}
                    options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]} />
                  <SelectInput label="默认时区" value={configs['system.default_timezone'] || 'Asia/Shanghai'} onChange={setField('system.default_timezone')}
                    options={[{ value: 'Asia/Shanghai', label: '亚洲/上海 (UTC+8)' }, { value: 'UTC', label: 'UTC' }, { value: 'America/New_York', label: '美东' }]} />
                  <SelectInput label="日期时间格式" value={configs['system.datetime_format'] || ''} onChange={setField('system.datetime_format')}
                    options={[{ value: 'YYYY-MM-DD HH:mm:ss', label: 'YYYY-MM-DD HH:mm:ss' }, { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' }, { value: 'DD/MM/YYYY HH:mm', label: 'DD/MM/YYYY HH:mm' }]} />
                  <NumberWithSuffix label="文件上传大小限制" value={configs['system.max_upload_size_mb'] || ''} onChange={setField('system.max_upload_size_mb')} min={1} suffix="MB" />
                  <SelectInput label="登录后默认首页" value={configs['system.home_page'] || '/dashboard'} onChange={setField('system.home_page')}
                    options={[{ value: '/dashboard', label: '运营大屏' }, { value: '/bigscreen', label: '盾立方W' }, { value: '/bigscreen2', label: '盾立方指挥大屏' }, { value: '/approvals', label: '工作台' }, { value: '/chat', label: '对话' }]} />
                </div>
              </SettingsSection>

              {/* 解析入库：模板成功率告警 */}
              <SettingsSection title="解析入库" icon={Database} collapsible defaultCollapsed>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <NumberWithSuffix label="成功率告警阈值" value={configs['parse.success_rate_threshold'] || ''} onChange={setField('parse.success_rate_threshold')} min={1} max={100} suffix="%"
                    hint="模板解析成功率持续 24 小时低于该值时，生成告警并通过通知中心提醒" />
                </div>
              </SettingsSection>

              {/* 安全配置（CORS / Webhook） + 测试连接 */}
              <SettingsSection title="连接与限流" icon={Network} hint="修改后需重启后端生效，支持即时测试" collapsible defaultCollapsed>
                {/* CORS 白名单 - Tag 输入 */}
                <div>
                  <FieldLabel label="CORS 白名单" hint="逗号分隔的源地址列表，修改后需重启后端生效" />
                  <TagInput value={configs.cors_origins || ''} onChange={setField('cors_origins')} placeholder="输入 Origin 后回车，如 http://localhost:5173" />
                </div>
                {/* CORS 即时测试 */}
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted p-2">
                  <Globe className="h-3.5 w-3.5 text-primary" />
                  <input className="min-w-[200px] flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                    value={corsTestOrigin} onChange={(e) => setCorsTestOrigin(e.target.value)} placeholder="输入 Origin 测试跨域，如 http://localhost:5173" />
                  <button type="button" onClick={handleTestCors} disabled={corsTesting} className="btn-secondary btn-sm">
                    {corsTesting ? '测试中…' : '测试跨域'}
                  </button>
                  {corsTestResult && (
                    <span className={`text-[11px] ${corsTestResult.ok ? 'text-success' : 'text-destructive'}`}>{corsTestResult.message}</span>
                  )}
                </div>

                {/* Webhook 限流 */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Webhook 限流</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min="1" max="300" value={Number(configs.webhook_rate_limit) || 30}
                        onChange={(e) => setField('webhook_rate_limit')(String(e.target.value))}
                        className="flex-1 accent-[var(--primary)]" />
                      <input type="number" min="1" className="w-20 rounded-md border border-border bg-secondary px-2 py-1 text-sm outline-none focus:border-primary"
                        value={configs.webhook_rate_limit || ''} onChange={(e) => setField('webhook_rate_limit')(e.target.value)} />
                      <span className="whitespace-nowrap text-xs text-muted-foreground">次/分钟</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {Number(configs.webhook_rate_limit) > 0 ? `每分钟最多 ${configs.webhook_rate_limit} 次调用` : '未设置'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">即时验证</label>
                    <button type="button" onClick={handleTestWebhook} disabled={webhookTesting} className="btn-secondary btn-sm self-start">
                      {webhookTesting ? '测试中…' : '测试限流配置'}
                    </button>
                    {webhookTestResult && (
                      <span className={`text-[11px] ${webhookTestResult.ok ? 'text-success' : 'text-destructive'}`}>{webhookTestResult.message}</span>
                    )}
                  </div>
                </div>
              </SettingsSection>

              <SettingsSection title="盾立方W" icon={ExternalLink} description="免登嵌入配置" hint="账号密码填下面两项，打开该大屏时自动登录，不再弹出对方登录页" collapsible defaultCollapsed>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput
                    label="免登账号"
                    value={configs['yunfang.username'] || ''}
                    onChange={setField('yunfang.username')}
                    placeholder="云防御登录用户名"
                    required
                  />
                  <div>
                    <FieldLabel label="免登密码" hint="填明文密码，保存后由后端登录换票" required />
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={inputBaseCls}
                      value={configs['yunfang.password'] || ''}
                      onChange={(e) => setField('yunfang.password')(e.target.value)}
                      placeholder="云防御登录明文密码"
                    />
                  </div>
                </div>
                <TextInput
                  label="嵌入地址"
                  value={configs['yunfang.embed_url'] || ''}
                  onChange={setField('yunfang.embed_url')}
                  placeholder="https://xingtu.yunaq.com/#/Attack/"
                />
              </SettingsSection>
              <SettingsSection title="盾立方指挥大屏" icon={Monitor} description="免登与跳转配置" hint="账号密码填下面两项；code / appid 是对方大屏编号，不是登录凭证" collapsible defaultCollapsed>
                <BigscreenDockFields prefix="bigscreen" configs={configs} setField={setField} />
              </SettingsSection>
            </div>

            {/* 右：实时预览区（sticky） */}
            <div className="flex flex-col gap-3 lg:sticky lg:top-2 lg:self-start">
              <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <Eye className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">实时预览</span>
                </div>
                {/* 顶部导航栏预览 */}
                <div className="mb-3">
                  <p className="mb-1 text-[10px] text-muted-foreground">顶部导航栏</p>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                    {configs.logo_url ? (
                      <img src={configs.logo_url} alt="logo" className="h-5 w-5 rounded object-cover" onError={(e) => { e.target.style.display = 'none' }} />
                    ) : (
                      <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold" style={{ background: previewColor, color: '#fff' }}>S</span>
                    )}
                    <span className="text-sm font-semibold" style={{ color: previewColor }}>{configs.platform_name || 'SOAR 平台'}</span>
                  </div>
                </div>
                {/* 登录页标题预览 */}
                <div className="mb-3">
                  <p className="mb-1 text-[10px] text-muted-foreground">登录页标题</p>
                  <div className="rounded-md border border-border bg-gradient-to-br from-secondary to-secondary px-4 py-6 text-center">
                    {configs.logo_url ? (
                      <img src={configs.logo_url} alt="logo" className="mx-auto mb-2 h-10 w-10 rounded object-cover" onError={(e) => { e.target.style.display = 'none' }} />
                    ) : (
                      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold" style={{ background: previewColor, color: '#fff' }}>S</div>
                    )}
                    <div className="text-lg font-bold" style={{ color: previewColor }}>{configs.platform_name || 'SOAR 平台'}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">安全编排自动化与响应平台</div>
                  </div>
                </div>
                {/* Favicon 预览 */}
                <div>
                  <p className="mb-1 text-[10px] text-muted-foreground">Favicon / Logo</p>
                  <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
                    {configs.logo_url ? (
                      <img src={configs.logo_url} alt="favicon" className="h-8 w-8 rounded object-cover" onError={(e) => { e.target.style.display = 'none' }} />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded text-sm font-bold" style={{ background: previewColor, color: '#fff' }}>S</div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      {configs.logo_url ? '已配置自定义 Logo' : '使用默认文字 Logo'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* ===== 安全设置 Tab ===== */}
        {activeTab === 'security' && (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            {securityLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
            ) : (
              <>
                {/* 安全评分摘要卡片 */}
                <div className={`grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 shadow-sm sm:grid-cols-[160px_1fr_1fr] ${scoreLevelBgCls}`}>
                  {/* 左：安全等级 */}
                  <div className="flex flex-col items-center justify-center sm:border-r sm:border-border sm:pr-4">
                    <ShieldCheck className={`mb-1 h-8 w-8 ${scoreLevelTextCls}`} />
                    <span className={`text-3xl font-bold ${scoreLevelTextCls}`}>{securityScore.level}</span>
                    <span className="text-[11px] text-muted-foreground">{securityScore.score} / 100 分</span>
                  </div>
                  {/* 中：评分进度条 */}
                  <div className="flex flex-col justify-center sm:px-4">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">安全评分</span>
                      <span className={`text-xs font-semibold ${scoreLevelTextCls}`}>{securityScore.score} 分</span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full transition-all duration-500 ${scoreLevelBarCls}`}
                        style={{ width: `${securityScore.score}%` }} />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {securityScore.score >= 80 ? '安全配置良好，继续保持' : securityScore.score >= 50 ? '存在安全隐患，建议优化' : '安全风险较高，请立即整改'}
                    </p>
                  </div>
                  {/* 右：未达标项 */}
                  <div className="flex flex-col sm:border-l sm:border-border sm:pl-4">
                    <span className="mb-2 text-xs font-medium text-muted-foreground">
                      未达标项 ({securityScore.failed.length})
                    </span>
                    {securityScore.failed.length === 0 ? (
                      <div className="flex items-center gap-1.5 text-xs text-success">
                        <Check className="h-3.5 w-3.5" />全部达标
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {securityScore.failed.map((item, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* 等保合规模板 */}
                <SettingsSection title="等保合规模板" icon={ShieldCheck} hint="选择模板自动填充推荐值">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {Object.entries(COMPLIANCE_TEMPLATES).map(([key, tmpl]) => {
                      const active = activeTemplate === key
                      return (
                        <button key={key} type="button" onClick={() => handleTemplateClick(key)}
                          className={`relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${active ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : 'border-border hover:border-primary/50 hover:bg-accent'}`}>
                          {active && (
                            <span className="absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                              <Check className="h-3 w-3 text-primary-foreground" />
                            </span>
                          )}
                          <span className={`text-sm font-semibold ${active ? 'pl-7' : ''}`}>{tmpl.label}</span>
                          <span className="text-[10px] text-muted-foreground">{tmpl.desc}</span>
                          <span className="text-[10px] text-muted-foreground">{tmpl.summary}</span>
                        </button>
                      )
                    })}
                  </div>
                  {activeTemplate !== 'custom' ? (
                    <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                      当前配置已符合「{COMPLIANCE_TEMPLATES[activeTemplate].label}」模板
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                      当前为自定义配置，未匹配任何预设模板
                    </div>
                  )}
                </SettingsSection>

                {/* 登录与会话 */}
                <SettingsSection title="登录与会话" icon={KeyRound} hint="控制登录失败锁定与 Session 超时">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberWithSuffix label="Session 超时" value={security['security.session_timeout_minutes']} onChange={setSecurityField('security.session_timeout_minutes')} min={1} suffix="分钟" hint="无操作超过该时长后自动登出" />
                    <NumberInput label="最大登录失败次数" value={security['security.max_login_attempts']} onChange={setSecurityField('security.max_login_attempts')} min={1} hint="超过该次数后账户将被锁定" />
                    <NumberWithSuffix label="账户锁定时长" value={security['security.lockout_duration_minutes']} onChange={setSecurityField('security.lockout_duration_minutes')} min={1} suffix="分钟" hint="达到最大失败次数后的锁定时长" />
                    <div className="flex flex-col">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">锁定后解锁方式</label>
                      <div className="flex items-center gap-2 pt-1.5">
                        <button type="button" onClick={() => setSecurityField('security.lockout_auto_unlock')(!security['security.lockout_auto_unlock'])}
                          className={`relative h-5 w-9 cursor-pointer rounded-full transition-all hover:ring-2 hover:ring-primary/30 ${security['security.lockout_auto_unlock'] ? 'bg-primary' : 'bg-input'}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${security['security.lockout_auto_unlock'] ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                        <span className="text-xs text-muted-foreground">{security['security.lockout_auto_unlock'] ? '自动解锁' : '需人工解锁'}</span>
                      </div>
                    </div>
                  </div>
                </SettingsSection>

                {/* 密码策略（可视化） */}
                <SettingsSection title="密码策略" icon={Lock} hint="控制新密码与修改密码时的复杂度要求">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberInput label="密码最小长度" value={security['security.password_min_length']} onChange={setSecurityField('security.password_min_length')} min={1} />
                    <NumberWithSuffix label="密码有效期" value={security['security.password_expiry_days']} onChange={setSecurityField('security.password_expiry_days')} min={0} suffix="天" hint="超过该天数后密码强制更换；0 表示永不过期" badge={security['security.password_expiry_days'] === 0 ? '永不过期' : null} />
                    <NumberWithSuffix label="历史密码不可重复次数" value={security['security.password_history_count']} onChange={setSecurityField('security.password_history_count')} min={0} suffix="次" hint="新密码不能与最近 N 次旧密码相同；0 表示不检查" badge={security['security.password_history_count'] === 0 ? '不检查历史' : null} />
                  </div>
                  <div className="mt-1 rounded-md border border-border bg-muted p-2.5">
                    <div className="mb-1.5 block text-xs font-medium text-muted-foreground">密码复杂度要求</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <CheckRow label="必须包含大写字母" checked={security['security.password_require_uppercase']} onChange={setSecurityField('security.password_require_uppercase')} />
                      <CheckRow label="必须包含小写字母" checked={security['security.password_require_lowercase']} onChange={setSecurityField('security.password_require_lowercase')} />
                      <CheckRow label="必须包含数字" checked={security['security.password_require_digit']} onChange={setSecurityField('security.password_require_digit')} />
                      <CheckRow label="必须包含特殊字符" checked={security['security.password_require_special']} onChange={setSecurityField('security.password_require_special')} />
                    </div>
                  </div>
                  {/* 强度可视化 */}
                  <div className="mt-1 rounded-md border border-border bg-secondary p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">当前策略强度</span>
                      <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${passwordStrength.level === '弱' ? 'bg-destructive/20 text-destructive' : passwordStrength.level === '中' ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'}`}>
                        {passwordStrength.level}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full transition-all ${passwordStrength.levelColor}`} style={{ width: `${Math.min(100, passwordStrength.score / 6 * 100)}%` }} />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">策略说明：{passwordStrength.desc}</p>
                  </div>
                </SettingsSection>

                {/* 高级安全功能 */}
                <SettingsSection title="高级安全功能" icon={ShieldAlert} hint="登录二次验证、IP 白名单、审计日志、敏感操作、单点登录" collapsible defaultCollapsed>
                  <div className="flex flex-col gap-3">
                    {/* MFA */}
                    <SecurityToggleRow icon={Smartphone} label="登录二次验证（MFA）" desc="管理员强制开启 OTP 验证" checked={security['security.mfa_enabled']} onChange={setSecurityField('security.mfa_enabled')}>
                      {security['security.mfa_enabled'] && (
                        <div className="mt-2.5 ml-6 rounded-md border border-border bg-background p-3">
                          <p className="mb-2 text-xs font-medium text-foreground">MFA 配置说明</p>
                          <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
                            <div>• 验证方式：TOTP（Google Authenticator / 微信身份验证器等）</div>
                            <div>• 备用码：每个用户绑定 MFA 时生成 10 个一次性备用码</div>
                            <div>• 强制范围：所有管理员账户必须开启，普通用户可选</div>
                            <div>• 恢复流程：遗失设备时联系超级管理员重置 MFA</div>
                          </div>
                        </div>
                      )}
                    </SecurityToggleRow>

                    {/* 登录 IP 白名单 - TagInput */}
                    <div className="rounded-md border border-border bg-muted p-2.5">
                      <div className="mb-1.5 flex items-center gap-2">
                        <Network className="h-3.5 w-3.5 text-primary" />
                        <span className="text-xs font-medium text-muted-foreground">登录 IP 白名单</span>
                      </div>
                      <TagInput
                        value={security['security.login_ip_whitelist'] || ''}
                        onChange={setSecurityField('security.login_ip_whitelist')}
                        placeholder="输入 IP/CIDR 后回车，如 203.0.113.0/24（空表示不限制）"
                        validateTag={(v) => validateIPExpression(v, '登录 IP 白名单')}
                      />
                      {validateIPExpression(security['security.login_ip_whitelist'], '登录 IP 白名单') && (
                        <div className="mt-1 text-[11px] text-destructive">
                          {validateIPExpression(security['security.login_ip_whitelist'], '登录 IP 白名单')}
                        </div>
                      )}
                    </div>

                    {/* 登录通知 */}
                    <SecurityToggleRow icon={Bell} label="异常登录通知" desc="异常登录时发送告警" checked={security['security.login_notification']} onChange={setSecurityField('security.login_notification')} />

                    {/* 审计日志保留时长 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <NumberWithSuffix label="审计日志保留时长" value={security['security.audit_log_retention_days']} onChange={setSecurityField('security.audit_log_retention_days')} min={0} suffix="天" hint="超过该天数的审计日志将被清理；0 表示永久保留" badge={security['security.audit_log_retention_days'] === 0 ? '永久保留' : null} />
                    </div>

                    {/* 敏感操作二次确认 */}
                    <SecurityToggleRow icon={CheckSquare} label="敏感操作二次确认" desc="删除、重置、导出等操作需二次确认" checked={security['security.sensitive_op_confirm']} onChange={setSecurityField('security.sensitive_op_confirm')}>
                      {security['security.sensitive_op_confirm'] && (
                        <div className="mt-2.5 ml-6 rounded-md border border-border bg-background p-3">
                          <p className="mb-2 text-xs font-medium text-foreground">受保护的敏感操作</p>
                          <div className="flex flex-wrap gap-1.5">
                            {['删除资源', '批量删除', '导出数据', '修改用户角色', '重置密码', '修改安全策略', '删除流程', '清空日志'].map((op) => (
                              <span key={op} className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">{op}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </SecurityToggleRow>

                    {/* SSO */}
                    <SecurityToggleRow icon={Link2} label="单点登录（SSO）" desc="对接企业 LDAP / OIDC" checked={security['security.sso_enabled']} onChange={setSecurityField('security.sso_enabled')}>
                      {security['security.sso_enabled'] && (
                        <div className="mt-2.5 ml-6 flex flex-col gap-2 rounded-md border border-border bg-background p-2.5">
                          <SelectInput label="SSO 提供商" value={security['security.sso_provider'] || ''} onChange={setSecurityField('security.sso_provider')}
                            options={[{ value: '', label: '请选择' }, { value: 'LDAP', label: 'LDAP' }, { value: 'OIDC', label: 'OIDC' }]} />
                          <TextArea label="SSO 配置（JSON）" value={security['security.sso_config'] || ''} onChange={setSecurityField('security.sso_config')} rows={3}
                            placeholder='{"server_url":"","client_id":"","client_secret":""}' />
                        </div>
                      )}
                    </SecurityToggleRow>
                  </div>
                </SettingsSection>

                {/* 安全设置 dirty 提示（保留） */}
                {securityDirty && canEdit && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning">
                    您有未保存的安全策略变更，点击右上角「保存变更」生效。
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 安全开关行（带图标 + 描述 + 可展开子内容）
function SecurityToggleRow({ icon: Icon, label, desc, checked, onChange, children }) {
  return (
    <div className="rounded-md border border-border bg-muted p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-primary" />
          <div className="flex flex-col">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <span className="text-[10px] text-muted-foreground">{desc}</span>
          </div>
        </div>
        <button type="button" onClick={() => onChange(!checked)}
          className={`relative h-5 w-9 cursor-pointer rounded-full transition-all hover:ring-2 hover:ring-primary/30 ${checked ? 'bg-primary' : 'bg-input'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>
      {children}
    </div>
  )
}

export default SystemSettings
