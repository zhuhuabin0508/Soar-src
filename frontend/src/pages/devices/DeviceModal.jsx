// 设备表单弹窗与参数/请求头编辑器
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Eye, EyeOff, Plus, X } from 'lucide-react'
import { Modal } from '../../components/Dialog'
import { toast } from '../../store/toastStore'
import { inputCls } from '../../components/property/FormControls'
import { CompactSelect } from '../../components/ui'
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges'
import {
  DEVICE_AUTH_TYPES,
  DEVICE_TYPES,
  PARAM_TYPES,
  copyText,
  parseTags,
  safeParseJson,
} from './constants'
import { Section, Switch } from './Badges'
import { validateSingleIP } from '../../utils/ipValidation'

// ============ 设备表单弹窗 ============
export function DeviceFormModal({ open, initial, onClose, onSubmit, saving, onTest }) {
  const [form, setForm] = useState(() => buildInitialDeviceForm(initial))
  const [dirty, setDirty] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [tagsInput, setTagsInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [ipTouched, setIpTouched] = useState(false)
  const bypassGuard = useUnsavedChanges(dirty)
  // 即时校验设备 IP（单 IPv4/IPv6，允许留空）
  const ipError = validateSingleIP(form.ip_address, '设备 IP 地址', { allowEmpty: true })

  useEffect(() => {
    if (open) {
      setForm(buildInitialDeviceForm(initial))
      setDirty(false)
      setShowApiKey(false)
      setTestResult(null)
      setIpTouched(false)
      const tags = parseTags(initial?.tags)
      setTagsInput(tags.join(', '))
    }
  }, [open, initial])

  function buildInitialDeviceForm(src) {
    return {
      name: '',
      type: 'firewall',
      vendor: '',
      version: '',
      ip_address: '',
      api_url: '',
      api_key: '',
      username: '',
      password: '',
      auth_type: 'api_key',
      timeout: 30,
      max_retries: 2,
      verify_tls: true,
      enabled: true,
      description: '',
      icon: '',
      tags: '[]',
      ...(src || {}),
    }
  }

  const set = (k) => (v) => {
    setForm((p) => ({ ...p, [k]: v }))
    setDirty(true)
  }

  const handleClose = () => {
    setDirty(false)
    bypassGuard()
    onClose()
  }

  const handleSubmit = async () => {
    // 同步 tags 到 form
    const tagsArr = tagsInput.split(',').map((s) => s.trim()).filter(Boolean)
    // 校验设备 IP 地址格式（单 IPv4/IPv6，与后端统一规则）
    const ipMsg = validateSingleIP(form.ip_address, '设备 IP 地址', { allowEmpty: true })
    if (ipMsg) {
      setIpTouched(true)
      toast.warning(ipMsg)
      return
    }
    const normalizedIp = (form.ip_address || '').trim()
    const finalForm = { ...form, ip_address: normalizedIp, tags: tagsArr }
    const ok = await onSubmit(finalForm)
    if (ok) {
      setDirty(false)
      bypassGuard()
    }
  }

  const handleTestInDialog = async () => {
    if (!form.api_url) {
      toast.warning('请先填写 API 地址')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      // 先保存再测试，或直接传表单给父组件测试
      const res = await onTest(form)
      setTestResult(res)
    } catch (err) {
      setTestResult({ success: false, error: err.message || String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={initial ? `编辑设备：${initial.name || ''}` : '新建安全设备'}
      onClose={handleClose}
      maxWidth="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={handleTestInDialog}
            disabled={testing || !form.api_url}
            className="mr-auto btn-secondary btn-sm"
            title="测试设备连接"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" onClick={handleClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !form.name}
            className="btn-primary"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 基础信息 */}
        <Section title="基础信息">
          <div className="grid grid-cols-2 gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                设备名称 <span className="text-destructive">*</span>
              </div>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
                placeholder="如：核心防火墙-A"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">设备类型</div>
              <CompactSelect
                value={form.type}
                onChange={(e) => set('type')(e.target.value)}
                size="lg"
                block
              >
                {DEVICE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">厂商</div>
              <input
                className={inputCls}
                value={form.vendor}
                onChange={(e) => set('vendor')(e.target.value)}
                placeholder="如：深信服 / 绿盟 / paloalto"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">版本</div>
              <input
                className={inputCls}
                value={form.version || ''}
                onChange={(e) => set('version')(e.target.value)}
                placeholder="如：V6.1R3 / 3.5.2"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">设备 IP 地址</div>
              <input
                className={`${inputCls}${ipTouched && ipError ? ' border-destructive ring-1 ring-destructive' : ''}`}
                value={form.ip_address || ''}
                onChange={(e) => set('ip_address')(e.target.value)}
                onBlur={() => setIpTouched(true)}
                placeholder="如：192.168.1.10"
              />
              {ipTouched && ipError && (
                <div className="mt-1 text-[11px] text-destructive">{ipError}</div>
              )}
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">设备图标（emoji 或 URL）</div>
              <input
                className={inputCls}
                value={form.icon || ''}
                onChange={(e) => set('icon')(e.target.value)}
                placeholder="🛡️ 或留空使用默认图标"
              />
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">设备描述</div>
              <input
                className={inputCls}
                value={form.description}
                onChange={(e) => set('description')(e.target.value)}
                placeholder="可选，对设备的简短说明"
              />
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                标签（逗号分隔，如：核心, 生产环境）
              </div>
              <input
                className={inputCls}
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="核心, 生产, 北京机房"
              />
            </label>
          </div>
        </Section>

        {/* 连接配置 */}
        <Section title="连接配置">
          <label className="mb-3 block">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              API 基地址
            </div>
            <input
              className={inputCls}
              value={form.api_url}
              onChange={(e) => set('api_url')(e.target.value)}
              placeholder="https://203.0.113.1:8443/api"
            />
            <div className="mt-1 text-xs text-muted-foreground">
              可选。仅需通过 API 主动调用（封禁/下发动作）的设备填写；仅用于被动接收日志（syslog/kafka）的设备可留空，在「日志接收」页配置接收方式即可。
            </div>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">超时时间（秒）</div>
              <input
                type="number"
                className={inputCls}
                value={form.timeout ?? 30}
                onChange={(e) => set('timeout')(Number(e.target.value))}
                placeholder="30"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">最大重试次数</div>
              <input
                type="number"
                className={inputCls}
                value={form.max_retries ?? 2}
                onChange={(e) => set('max_retries')(Number(e.target.value))}
                placeholder="2"
              />
            </label>
            <label className="flex items-end gap-2 pb-1">
              <Switch checked={!!form.verify_tls} onChange={(v) => set('verify_tls')(v)} />
              <span className="text-xs text-muted-foreground">TLS 证书校验</span>
            </label>
          </div>
        </Section>

        {/* 认证配置 */}
        <Section title="认证配置">
          <label className="mb-3 block">
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

          {form.auth_type === 'api_key' && (
            <label className="block">
              <div className="mb-1 text-xs font-medium text-muted-foreground">API Key</div>
              <div className="flex items-center gap-1">
                <input
                  className={inputCls}
                  type={showApiKey ? 'text' : 'password'}
                  value={form.api_key}
                  onChange={(e) => set('api_key')(e.target.value)}
                  placeholder="API Key"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((p) => !p)}
                  className="rounded-md border border-border bg-secondary px-2 py-2 text-muted-foreground hover:text-foreground"
                  title={showApiKey ? '隐藏' : '显示'}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => copyText(form.api_key)}
                  disabled={!form.api_key}
                  className="rounded-md border border-border bg-secondary px-2 py-2 text-muted-foreground hover:text-primary disabled:opacity-40"
                  title="复制"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </label>
          )}

          {form.auth_type === 'basic' && (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">用户名</div>
                <input
                  className={inputCls}
                  value={form.username}
                  onChange={(e) => set('username')(e.target.value)}
                  placeholder="Basic Auth 用户名"
                />
              </label>
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">密码</div>
                <input
                  type="password"
                  className={inputCls}
                  value={form.password}
                  onChange={(e) => set('password')(e.target.value)}
                  placeholder="Basic Auth 密码"
                />
              </label>
            </div>
          )}

          {form.auth_type === 'qingteng' && (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">用户名</div>
                <input
                  className={inputCls}
                  value={form.username}
                  onChange={(e) => set('username')(e.target.value)}
                  placeholder="青藤 Console 用户名"
                />
              </label>
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">密码</div>
                <input
                  type="password"
                  className={inputCls}
                  value={form.password}
                  onChange={(e) => set('password')(e.target.value)}
                  placeholder="青藤 Console 密码"
                />
              </label>
            </div>
          )}

          {form.auth_type === 'bearer' && (
            <label className="block">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Bearer Token</div>
              <input
                className={inputCls}
                type={showApiKey ? 'text' : 'password'}
                value={form.api_key}
                onChange={(e) => set('api_key')(e.target.value)}
                placeholder="Bearer Token"
              />
            </label>
          )}

          {form.auth_type === 'none' && (
            <div className="text-xs text-muted-foreground">无认证模式，直接访问 API。</div>
          )}

          {(form.auth_type === 'oauth2' || form.auth_type === 'mtls') && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {form.auth_type === 'oauth2'
                ? 'OAuth2 需在服务端配置客户端凭证、Token URL 等参数。'
                : 'mTLS 双向认证需在服务端配置客户端证书。'}
            </div>
          )}
        </Section>

        {/* 其他设置 */}
        <Section title="其他设置" defaultOpen={false}>
          <label className="flex items-center gap-2">
            <Switch checked={!!form.enabled} onChange={(v) => set('enabled')(v)} />
            <span className="text-sm text-muted-foreground">启用设备</span>
          </label>
        </Section>

        {/* 弹窗内测试结果 */}
        {testResult && (
          <div
            className={`rounded-md border px-4 py-3 ${
              testResult.success
                ? 'border-success/40 bg-success/10'
                : 'border-destructive/40 bg-destructive/10'
            }`}
          >
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <X className="h-4 w-4 text-destructive" />
              )}
              <span
                className={`text-sm ${
                  testResult.success ? 'text-success' : 'text-destructive'
                }`}
              >
                {testResult.success
                  ? `连接成功 · 延迟 ${testResult.latency_ms ?? testResult.latency ?? '-'}ms`
                  : '连接失败'}
              </span>
            </div>
            {!testResult.success && testResult.error && (
              <pre className="mt-2 overflow-auto rounded bg-background p-2 font-mono text-[11px] text-destructive ring-1 ring-border">
                {testResult.error}
              </pre>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ============ 参数行编辑器 ============
export function ParamsEditor({ value, onChange }) {
  const rows = useMemo(() => {
    const arr = safeParseJson(value, [])
    return Array.isArray(arr) ? arr : []
  }, [value])

  const update = (next) => {
    onChange(JSON.stringify(next, null, 2))
  }
  const addRow = () => {
    update([...rows, { name: '', type: 'string', required: false, default: '', description: '' }])
  }
  const removeRow = (idx) => {
    update(rows.filter((_, i) => i !== idx))
  }
  const editRow = (idx, patch) => {
    update(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-3 text-center text-xs text-muted-foreground">
          暂无参数，点击下方按钮添加
        </div>
      )}
      {rows.map((row, idx) => (
        <div
          key={idx}
          className="grid grid-cols-[1fr_100px_60px_1fr_1.2fr_28px] items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5"
        >
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            placeholder="参数名"
            value={row.name}
            onChange={(e) => editRow(idx, { name: e.target.value })}
          />
          <CompactSelect
            value={row.type}
            onChange={(e) => editRow(idx, { type: e.target.value })}
            size="sm"
            block
          >
            {PARAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </CompactSelect>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={!!row.required}
              onChange={(e) => editRow(idx, { required: e.target.checked })}
            />
            必填
          </label>
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            placeholder="默认值"
            value={row.default ?? ''}
            onChange={(e) => editRow(idx, { default: e.target.value })}
          />
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            placeholder="说明"
            value={row.description ?? ''}
            onChange={(e) => editRow(idx, { description: e.target.value })}
          />
          <button
            type="button"
            onClick={() => removeRow(idx)}
            className="text-muted-foreground hover:text-destructive"
            title="删除参数"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addRow} className="btn-secondary btn-sm self-start">
        <Plus className="mr-1 h-3 w-3" /> 添加参数
      </button>
    </div>
  )
}

// ============ 请求头编辑器 ============
export function HeadersEditor({ value, onChange }) {
  const rows = useMemo(() => {
    const obj = safeParseJson(value, {})
    if (Array.isArray(obj)) return obj
    return Object.entries(obj).map(([k, v]) => ({ key: k, value: v }))
  }, [value])

  const update = (next) => {
    onChange(JSON.stringify(next, null, 2))
  }
  const addRow = () => {
    update([...rows, { key: '', value: '' }])
  }
  const removeRow = (idx) => {
    update(rows.filter((_, i) => i !== idx))
  }
  const editRow = (idx, patch) => {
    update(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-3 text-center text-xs text-muted-foreground">
          暂无自定义请求头
        </div>
      )}
      {rows.map((row, idx) => (
        <div
          key={idx}
          className="grid grid-cols-[1fr_1fr_28px] items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5"
        >
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            placeholder="Header Key"
            value={row.key}
            onChange={(e) => editRow(idx, { key: e.target.value })}
          />
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            placeholder="Header Value"
            value={row.value}
            onChange={(e) => editRow(idx, { value: e.target.value })}
          />
          <button
            type="button"
            onClick={() => removeRow(idx)}
            className="text-muted-foreground hover:text-destructive"
            title="删除"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addRow} className="btn-secondary btn-sm self-start">
        <Plus className="mr-1 h-3 w-3" /> 添加请求头
      </button>
    </div>
  )
}
