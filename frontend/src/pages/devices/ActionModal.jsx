// 动作表单、模板选择/创建、动作测试抽屉、动作历史弹窗
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Files, TestTube, X } from 'lucide-react'
import { Modal } from '../../components/Dialog'
import { toast } from '../../store/toastStore'
import { inputCls, textareaCls } from '../../components/property/FormControls'
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges'
import useLockBackgroundScroll from '../../hooks/useLockBackgroundScroll'
import { CompactSelect } from '../../components/ui'
import { devices as devicesApi } from '../../api/client'
import { validateIPExpression, validateCidrList, validateSingleIP } from '../../utils/ipValidation'
import {
  ACTION_AUTH_TYPES,
  ACTION_CATEGORIES,
  ACTION_TYPES,
  DEVICE_TYPE_LABELS,
  HTTP_METHODS,
  RISK_OPTIONS,
  fmtRelative,
  fmtTime,
  safeParseJson,
  truncate,
} from './constants'
import { DeviceTypeIcon, MethodBadge, Section, Switch } from './Badges'
import { HeadersEditor, ParamsEditor } from './DeviceModal'

// ============ 动作表单弹窗 ============
export function ActionFormModal({ open, initial, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(() => buildInitialActionForm(initial))
  const [dirty, setDirty] = useState(false)
  const bypassGuard = useUnsavedChanges(dirty)

  useEffect(() => {
    if (open) {
      setForm(buildInitialActionForm(initial))
      setDirty(false)
    }
  }, [open, initial])

  function buildInitialActionForm(src) {
    return {
      name: '',
      action_type: 'block_ip',
      http_method: 'POST',
      api_path: '',
      params_schema: '[]',
      headers: '{}',
      body_template: '',
      auth_type: 'inherit',
      enabled: true,
      description: '',
      category: 'block',
      risk_level: 'readonly',
      example_payload: '',
      example_response: '',
      version: 1,
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
    if (!form.name) {
      toast.warning('请填写动作名称')
      return false
    }
    // 验证 params_schema
    const params = safeParseJson(form.params_schema, null)
    if (params === null) {
      toast.error('参数定义不是合法的 JSON')
      return false
    }
    const headers = safeParseJson(form.headers, null)
    if (headers === null) {
      toast.error('请求头不是合法的 JSON')
      return false
    }
    // 编辑时版本号 +1
    const finalForm = { ...form }
    if (initial) {
      finalForm.version = (initial.version || 1) + 1
    }
    const ok = await onSubmit(finalForm)
    if (ok) {
      setDirty(false)
      bypassGuard()
    }
  }

  // 从 body_template 中提取 {{param}} 占位符
  const bodyPlaceholders = useMemo(() => {
    const matches = (form.body_template || '').matchAll(/\{\{(\w+)\}\}/g)
    const set = new Set()
    for (const m of matches) set.add(m[1])
    return Array.from(set)
  }, [form.body_template])

  return (
    <Modal
      open={open}
      title={initial ? `编辑动作：${initial.name || ''}` : '新建设备动作'}
      onClose={handleClose}
      maxWidth="max-w-4xl"
      footer={
        <>
          <button type="button" onClick={handleClose} className="btn-secondary">
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving} className="btn-primary">
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
                动作名称 <span className="text-destructive">*</span>
              </div>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
                placeholder="如：封禁 IP"
              />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">动作类型</div>
              <CompactSelect
                value={form.action_type}
                onChange={(e) => set('action_type')(e.target.value)}
                size="lg"
                block
              >
                {ACTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">分类</div>
              <CompactSelect
                value={form.category}
                onChange={(e) => set('category')(e.target.value)}
                size="lg"
                block
              >
                {Object.entries(ACTION_CATEGORIES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">风险等级</div>
              <CompactSelect
                value={form.risk_level}
                onChange={(e) => set('risk_level')(e.target.value)}
                size="lg"
                block
              >
                {RISK_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label className="col-span-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">动作描述</div>
              <input
                className={inputCls}
                value={form.description}
                onChange={(e) => set('description')(e.target.value)}
                placeholder="可选，说明此动作的作用"
              />
            </label>
          </div>
        </Section>

        {/* 请求配置 */}
        <Section title="请求配置">
          <div className="grid grid-cols-[110px_1fr_140px] gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">HTTP 方法</div>
              <CompactSelect
                value={form.http_method}
                onChange={(e) => set('http_method')(e.target.value)}
                size="sm"
                block
              >
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </CompactSelect>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">API 路径</div>
              <input
                className={inputCls}
                value={form.api_path}
                onChange={(e) => set('api_path')(e.target.value)}
                placeholder="/block/ip"
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
                {ACTION_AUTH_TYPES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </CompactSelect>
            </label>
          </div>
        </Section>

        {/* 参数定义 */}
        <Section title="参数定义" hint="表单化编辑，自动生成 JSON Schema">
          <ParamsEditor
            value={form.params_schema}
            onChange={(v) => set('params_schema')(v)}
          />
        </Section>

        {/* 请求头 */}
        <Section title="请求头" defaultOpen={false}>
          <HeadersEditor value={form.headers} onChange={(v) => set('headers')(v)} />
        </Section>

        {/* 请求体模板 */}
        <Section title="请求体模板" defaultOpen={false}>
          <label className="block">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                请求体模板（支持 {`{{参数名}}`} 占位符）
              </span>
              {bodyPlaceholders.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>检测到变量：</span>
                  {bodyPlaceholders.map((p) => (
                    <code
                      key={p}
                      className="rounded bg-primary/10 px-1 py-0.5 font-mono text-primary"
                    >
                      {`{{${p}}}`}
                    </code>
                  ))}
                </div>
              )}
            </div>
            <textarea
              className={`${textareaCls} text-xs`}
              rows={5}
              value={form.body_template}
              onChange={(e) => set('body_template')(e.target.value)}
              placeholder={'{"ip": "{{ip}}", "duration": {{duration}}}'}
            />
          </label>
        </Section>

        {/* 示例与返回 */}
        <Section title="示例与返回" defaultOpen={false}>
          <label className="mb-3 block">
            <div className="mb-1 text-xs font-medium text-muted-foreground">示例 Payload</div>
            <textarea
              className={`${textareaCls} text-xs`}
              rows={3}
              value={form.example_payload}
              onChange={(e) => set('example_payload')(e.target.value)}
              placeholder='{"ip": "198.51.100.1"}'
            />
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-medium text-muted-foreground">示例返回结果</div>
            <textarea
              className={`${textareaCls} text-xs`}
              rows={3}
              value={form.example_response}
              onChange={(e) => set('example_response')(e.target.value)}
              placeholder='{"code": 0, "message": "ok"}'
            />
          </label>
        </Section>

        {/* 其他 */}
        <Section title="其他" defaultOpen={false}>
          <label className="flex items-center gap-2">
            <Switch checked={!!form.enabled} onChange={(v) => set('enabled')(v)} />
            <span className="text-sm text-muted-foreground">启用此动作</span>
          </label>
          {initial && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              当前版本：v{initial.version || 1}（保存后将升级为 v{(initial.version || 1) + 1}）
            </div>
          )}
        </Section>
      </div>
    </Modal>
  )
}

// ============ 模板选择弹窗 ============
export function TemplateModal({ open, templates, onClose, onSelect }) {
  const [loading, setLoading] = useState(false)
  return (
    <Modal
      open={open}
      title="从模板创建设备"
      onClose={onClose}
      maxWidth="max-w-4xl"
      footer={
        <button type="button" onClick={onClose} className="btn-secondary">
          取消
        </button>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : !templates || templates.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Files className="h-8 w-8" />
          <div className="text-sm">暂无可用模板</div>
        </div>
      ) : (
        <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto p-1">
          {templates.map((tpl, idx) => (
            <button
              key={tpl.id || idx}
              type="button"
              onClick={() => onSelect(tpl)}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition hover:border-primary hover:bg-primary/5"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <DeviceTypeIcon type={tpl.type} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{tpl.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {tpl.vendor || '未知厂商'} · {DEVICE_TYPE_LABELS[tpl.type] || tpl.type}
                  </div>
                </div>
              </div>
              {tpl.description && (
                <div className="line-clamp-2 text-[11px] text-muted-foreground">
                  {tpl.description}
                </div>
              )}
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                  预置 {tpl.action_count ?? tpl.actions?.length ?? 0} 个动作
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ============ 从模板创建设备弹窗 ============
export function TemplateCreateModal({ open, template, onClose, onSubmit, saving }) {
  const [form, setForm] = useState({ name: '', api_url: '', api_key: '', vendor: '', ip_address: '' })
  const [ipTouched, setIpTouched] = useState(false)
  const ipError = validateSingleIP(form.ip_address, '设备 IP 地址', { allowEmpty: true })

  useEffect(() => {
    if (open && template) {
      setForm({
        name: template.name || '',
        api_url: '',
        api_key: '',
        vendor: template.vendor || '',
        ip_address: '',
      })
      setIpTouched(false)
    }
  }, [open, template])

  if (!open || !template) return null

  const handleCreate = () => {
    const ipMsg = validateSingleIP(form.ip_address, '设备 IP 地址', { allowEmpty: true })
    if (ipMsg) {
      setIpTouched(true)
      toast.warning(ipMsg)
      return
    }
    onSubmit({ ...form, ip_address: (form.ip_address || '').trim() })
  }

  return (
    <Modal
      open={open}
      title={`从模板创建：${template.name || ''}`}
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving || !form.name}
            className="btn-primary"
          >
            {saving ? '创建中…' : '一键创建'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            设备名称 <span className="text-destructive">*</span>
          </div>
          <input
            className={inputCls}
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="设备名称"
          />
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            API 地址
          </div>
          <input
            className={inputCls}
            value={form.api_url}
            onChange={(e) => setForm((p) => ({ ...p, api_url: e.target.value }))}
            placeholder="https://203.0.113.1:8443/api"
          />
          <div className="mt-1 text-xs text-muted-foreground">
            可选。仅用于被动接收日志（syslog/kafka）的设备可留空，创建后到「日志接收」页配置接收方式。
          </div>
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">API Key</div>
          <input
            className={inputCls}
            type="password"
            value={form.api_key}
            onChange={(e) => setForm((p) => ({ ...p, api_key: e.target.value }))}
            placeholder="API Key"
          />
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">厂商</div>
          <input
            className={inputCls}
            value={form.vendor}
            onChange={(e) => setForm((p) => ({ ...p, vendor: e.target.value }))}
            placeholder="厂商"
          />
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">设备 IP 地址</div>
          <input
            className={`${inputCls}${ipTouched && ipError ? ' border-destructive ring-1 ring-destructive' : ''}`}
            value={form.ip_address}
            onChange={(e) => setForm((p) => ({ ...p, ip_address: e.target.value }))}
            onBlur={() => setIpTouched(true)}
            placeholder="如：192.168.1.10"
          />
          {ipTouched && ipError && (
            <div className="mt-1 text-[11px] text-destructive">{ipError}</div>
          )}
        </label>
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-primary/80">
          将自动创建设备和预置的 {template.action_count ?? template.actions?.length ?? 0} 个动作。
        </div>
      </div>
    </Modal>
  )
}

// ============ 动作测试抽屉 ============
export function ActionTestDrawer({ open, action, onClose, onRun, running, result }) {
  const [params, setParams] = useState({})
  const [paramTouched, setParamTouched] = useState({})
  useLockBackgroundScroll(open)

  useEffect(() => {
    if (open && action) {
      const init = {}
      const schema = safeParseJson(action.params_schema, [])
      schema.forEach((p) => {
        init[p.name] = p.default !== undefined ? p.default : ''
      })
      setParams(init)
      setParamTouched({})
    }
  }, [open, action])

  if (!open || !action) return null

  const schema = safeParseJson(action.params_schema, [])

  // 即时校验：type=ip/cidr 的参数（与后端硬拦截口径一致，不允许通配）
  const paramErrors = {}
  schema.forEach((p) => {
    if (!['ip', 'cidr'].includes(p.type)) return
    const raw = params[p.name]
    if (!raw?.toString().trim()) {
      if (p.required) paramErrors[p.name] = `参数「${p.name}」为必填项`
      return
    }
    const msg = p.type === 'cidr'
      ? validateCidrList(raw, p.name)
      : validateIPExpression(raw, p.name, { allowWildcard: false })
    if (msg) paramErrors[p.name] = msg
  })
  const hasParamErrors = Object.keys(paramErrors).length > 0

  const renderParamInput = (p) => {
    const val = params[p.name] ?? ''
    const setVal = (v) => setParams((prev) => ({ ...prev, [p.name]: v }))
    if (p.type === 'boolean') {
      return (
        <label className="flex items-center gap-2">
          <Switch checked={!!val} onChange={setVal} />
          <span className="text-xs text-muted-foreground">{val ? 'true' : 'false'}</span>
        </label>
      )
    }
    if (p.type === 'enum' && Array.isArray(p.options)) {
      return (
        <CompactSelect value={val} onChange={(e) => setVal(e.target.value)} size="lg" block>
          <option value="">请选择</option>
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </CompactSelect>
      )
    }
    const touched = !!paramTouched[p.name]
    const err = paramErrors[p.name]
    return (
      <div className="w-full">
        <input
          className={`${inputCls}${touched && err ? ' border-destructive ring-1 ring-destructive' : ''}`}
          type={p.type === 'number' ? 'number' : 'text'}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => setParamTouched((prev) => ({ ...prev, [p.name]: true }))}
          placeholder={p.description || `请输入 ${p.name}`}
        />
        {touched && err && <div className="mt-1 text-[11px] text-destructive">{err}</div>}
      </div>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[9000] flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-background shadow-2xl ring-1 ring-border">
        {/* 头部 */}
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <TestTube className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              测试动作：{action.name}
            </h2>
            <MethodBadge method={action.http_method} />
            <code className="text-xs text-muted-foreground">{action.api_path}</code>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* 内容 */}
        <div data-allow-scroll className="flex-1 overflow-y-auto overscroll-contain p-6">
          <div className="flex flex-col gap-4">
            {/* 参数输入 */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                参数输入
              </h3>
              {schema.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-background px-3 py-3 text-center text-xs text-muted-foreground">
                  此动作未定义参数
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {schema.map((p) => (
                    <label key={p.name}>
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <span>{p.name}</span>
                        <code className="rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                          {p.type}
                        </code>
                        {p.required && <span className="text-destructive">*</span>}
                        {p.description && (
                          <span className="text-muted-foreground">— {p.description}</span>
                        )}
                      </div>
                      {renderParamInput(p)}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* 请求预览 */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                请求预览
              </h3>
              <pre className="overflow-auto rounded-md bg-card p-3 font-mono text-[11px] text-foreground ring-1 ring-border">
                {action.http_method} {action.api_path}
                {'\n'}
                {(() => {
                  const headers = safeParseJson(action.headers, {})
                  const hArr = Array.isArray(headers)
                    ? headers.map((h) => [h.key, h.value])
                    : Object.entries(headers)
                  return hArr.map(([k, v]) => `${k}: ${v}`).join('\n')
                })()}
                {action.body_template ? '\n\n' + action.body_template.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? '') : ''}
              </pre>
            </div>

            {/* 响应结果 */}
            {result && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  响应结果
                </h3>
                <div
                  className={`mb-2 flex items-center gap-3 rounded-md border px-3 py-2 ${
                    result.success
                      ? 'border-success/40 bg-success/10'
                      : 'border-destructive/40 bg-destructive/10'
                  }`}
                >
                  <span
                    className={`inline-flex items-center gap-1 text-sm font-medium ${
                      result.success ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {result.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                    {result.success ? '成功' : '失败'}
                  </span>
                  {result.status_code != null && (
                    <span className="font-mono text-xs text-muted-foreground">
                      HTTP {result.status_code}
                    </span>
                  )}
                  {result.latency_ms != null && (
                    <span className="font-mono text-xs text-muted-foreground">
                      耗时 {result.latency_ms}ms
                    </span>
                  )}
                </div>
                {result.error && (
                  <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    {result.error}
                  </div>
                )}
                <pre className="max-h-72 overflow-auto rounded-md bg-card p-3 font-mono text-[11px] text-foreground ring-1 ring-border">
                  {result.response_body == null
                    ? '(空)'
                    : typeof result.response_body === 'string'
                    ? result.response_body
                    : JSON.stringify(result.response_body, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* 底部操作 */}
        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            关闭
          </button>
          <button
            type="button"
            onClick={() => {
              if (hasParamErrors) {
                setParamTouched(Object.fromEntries(Object.keys(paramErrors).map((k) => [k, true])))
                toast.warning(Object.values(paramErrors)[0])
                return
              }
              onRun(params)
            }}
            disabled={running}
            className="btn-primary btn-sm"
          >
            {running ? '测试中…' : '开始测试'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// ============ 动作历史弹窗 ============
export function ActionHistoryModal({ open, deviceId, actionId, actionName, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!deviceId || !actionId) return
    setLoading(true)
    try {
      const res = await devicesApi.actionHistory(deviceId, actionId, 50)
      setHistory(Array.isArray(res) ? res : res?.history || [])
    } catch (err) {
      toast.error(`加载历史失败：${err.message || err}`)
      setHistory([])
    } finally {
      setLoading(false)
    }
  }, [deviceId, actionId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  return (
    <Modal
      open={open}
      title={`执行历史：${actionName || ''}`}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <button type="button" onClick={onClose} className="btn-primary">
          关闭
        </button>
      }
    >
      {loading ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : history.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          暂无执行记录
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="w-40 px-3 py-2 text-left font-medium">时间</th>
                <th className="w-20 px-3 py-2 text-left font-medium">状态</th>
                <th className="w-24 px-3 py-2 text-right font-medium">耗时</th>
                <th className="px-3 py-2 text-left font-medium">来源 / 错误</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, idx) => (
                <tr
                  key={h.id || idx}
                  className={`border-t border-border ${
                    h.status === 'failed' || h.success === false
                      ? 'bg-destructive/5'
                      : idx % 2 === 0
                      ? 'bg-card'
                      : ''
                  }`}
                >
                  <td className="px-3 py-2 text-[11px] text-muted-foreground" title={fmtTime(h.created_at)}>
                    {fmtRelative(h.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        h.status === 'success' || h.success === true
                          ? 'bg-success/20 text-success'
                          : 'bg-destructive/20 text-destructive'
                      }`}
                    >
                      {h.status === 'success' || h.success === true ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">
                    {h.latency_ms != null ? `${h.latency_ms}ms` : '-'}
                  </td>
                  <td className="truncate px-3 py-2 text-[11px] text-muted-foreground" title={h.error_message || h.source || ''}>
                    {h.source && <span className="mr-2 text-primary">{h.source}</span>}
                    {h.error_message ? (
                      <span className="text-destructive">{truncate(h.error_message, 60)}</span>
                    ) : (
                      '-'
                    )}
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
