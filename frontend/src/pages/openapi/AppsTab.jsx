// 应用管理：创建/编辑应用、配置数据授权与限流、一次性密钥展示、启停/轮换/删除
//
// 设计规范（B端设计系统）：
// - 多字段表单用右侧中抽屉（Drawer），保留列表背景上下文；遮罩/ESC 不会静默丢弃录入
// - 高危操作（删除/重置密钥）用小尺寸确认弹窗：标题中立陈述对象、描述写清后果、按钮动宾明确
// - 数值/时间列右对齐（tabular-nums），Badge 浅底深字
// - 密钥一次性展示弹窗：仅显式按钮可关闭，防止误关丢失 Secret
import { useCallback, useEffect, useMemo, useState } from 'react'
import { openAdminApi } from '../../api/openApi'
import { Modal, Drawer } from '../../components/Dialog'
import { Badge } from '../../components/ui'
import {
  Plus, Copy, RefreshCw, Trash2, Pencil, Power, KeyRound, Check,
} from 'lucide-react'
import { toast } from '../../store/toastStore'
import { validateSingleIP } from '../../utils/ipValidation'

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '-')

// 轻量二次确认弹窗（小尺寸 400px 档）：标题中立、描述交代后果、按钮动宾明确
function ConfirmDialog({ open, title, description, confirmText, danger, onConfirm, onClose, busy }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className={`${danger ? 'btn-danger' : 'btn-primary'} btn-sm`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中...' : confirmText}
          </button>
        </>
      }
    >
      {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
    </Modal>
  )
}

export default function AppsTab() {
  const [apps, setApps] = useState([])
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 编辑抽屉状态：null=关闭；{__new__}=新建；其余=编辑
  const [editor, setEditor] = useState(null)
  const [snapshot, setSnapshot] = useState('') // 打开抽屉时的表单快照（脏检查）
  const [secretModal, setSecretModal] = useState(null)
  const [busy, setBusy] = useState(false)
  // 确认弹窗：{kind: 'delete'|'rotate'|'discard', app}
  const [confirmState, setConfirmState] = useState(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [a, r] = await Promise.all([openAdminApi.listApps(), openAdminApi.listResources()])
      setApps(a?.data?.items || [])
      setResources(r?.data?.items || [])
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const resourceName = useMemo(() => {
    const m = {}
    resources.forEach((r) => { m[r.code] = r })
    return m
  }, [resources])

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制到剪贴板')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  const isDirty = useMemo(() => {
    if (!editor || editor.__new__) return false
    const current = JSON.stringify({
      app_name: editor.app_name, description: editor.description,
      resource_codes: [...(editor.resource_codes || [])].sort(),
      rate_limit_per_minute: Number(editor.rate_limit_per_minute) || 60,
      allowed_ips: editor.allowed_ips || [],
      expires_at: editor.expires_at || '',
    })
    return current !== snapshot
  }, [editor, snapshot])

  // ---- 抽屉打开/关闭（脏数据拦截） ----
  const openEditor = (app) => {
    if (app) {
      const next = { ...app, allowed_ips: app.allowed_ips || [], ip_input: '' }
      setEditor(next)
      setSnapshot(JSON.stringify({
        app_name: next.app_name, description: next.description,
        resource_codes: [...(next.resource_codes || [])].sort(),
        rate_limit_per_minute: Number(next.rate_limit_per_minute) || 60,
        allowed_ips: next.allowed_ips,
        expires_at: next.expires_at || '',
      }))
    } else {
      setEditor({ __new__: true, app_name: '', description: '', resource_codes: [], rate_limit_per_minute: 60, allowed_ips: [], ip_input: '', expires_at: '' })
      setSnapshot('')
    }
  }

  const closeEditor = () => {
    if (busy) return
    if (isDirty) { setConfirmState({ kind: 'discard' }); return }
    setEditor(null)
  }

  // ---- 创建 / 更新 ----
  const saveApp = async () => {
    if (!editor.app_name || editor.app_name.trim().length < 2) {
      toast.error('应用名称至少 2 个字符')
      return
    }
    setBusy(true)
    try {
      const body = {
        app_name: editor.app_name.trim(),
        description: editor.description || '',
        resource_codes: editor.resource_codes || [],
        rate_limit_per_minute: Number(editor.rate_limit_per_minute) || 60,
        allowed_ips: (editor.allowed_ips || []).filter(Boolean),
      }
      if (editor.expires_at) body.expires_at = editor.expires_at
      if (editor.__new__) {
        const res = await openAdminApi.createApp(body)
        const app = res?.data
        if (app?.access_key && app?.secret) {
          setSecretModal({ app_name: app.app_name, access_key: app.access_key, secret: app.secret })
        } else {
          // 2xx 但响应缺密钥数据：应用已创建成功，提示走重置流程，避免误报“保存失败”导致重复创建
          toast.success('应用已创建，密钥数据缺失请联系管理员重置后获取')
        }
      } else {
        const body2 = { ...body }
        if (!editor.expires_at) body2.clear_expires = true
        await openAdminApi.updateApp(editor.id, body2)
        toast.success('应用已更新')
      }
      setEditor(null)
      load()
    } catch (e) {
      toast.error(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  // ---- 启停 ----
  const toggleStatus = async (app) => {
    try {
      await openAdminApi.updateApp(app.id, { status: app.status === 'active' ? 'disabled' : 'active' })
      toast.success(app.status === 'active' ? '应用已停用，密钥立即失效' : '应用已启用')
      load()
    } catch (e) {
      toast.error(e.message || '操作失败')
    }
  }

  // ---- 确认弹窗动作 ----
  const runConfirm = async () => {
    if (!confirmState) return
    const { kind, app } = confirmState
    setConfirmBusy(true)
    try {
      if (kind === 'delete') {
        await openAdminApi.deleteApp(app.id)
        toast.success('应用已删除')
        load()
      } else if (kind === 'rotate') {
        const res = await openAdminApi.rotateSecret(app.id)
        const d = res?.data
        setSecretModal({ app_name: d.app_name, access_key: d.access_key, secret: d.secret })
        load()
      } else if (kind === 'discard') {
        setEditor(null)
      }
      setConfirmState(null)
    } catch (e) {
      toast.error(e.message || '操作失败')
    } finally {
      setConfirmBusy(false)
    }
  }

  const toggleResource = (code) => {
    setEditor((p) => {
      const has = p.resource_codes.includes(code)
      return { ...p, resource_codes: has ? p.resource_codes.filter((c) => c !== code) : [...p.resource_codes, code] }
    })
  }

  const addIp = () => {
    const ip = (editor.ip_input || '').trim()
    if (!ip) return
    // 即时格式校验（IPv4/IPv6，与后端 _validate_ips 口径一致），避免整表单提交时才被 400 拒绝
    const ipErr = validateSingleIP(ip, 'IP')
    if (ipErr) { toast.error(ipErr); return }
    if (editor.allowed_ips.includes(ip)) { setEditor((p) => ({ ...p, ip_input: '' })); return }
    setEditor((p) => ({ ...p, allowed_ips: [...p.allowed_ips, ip], ip_input: '' }))
  }

  const confirmMeta = confirmState && {
    delete: {
      title: `删除应用「${confirmState.app?.app_name}」？`,
      description: '删除后该应用的密钥立即失效，第三方调用将全部失败；历史调用日志会保留。此操作不可恢复。',
      confirmText: '删除应用', danger: true,
    },
    rotate: {
      title: `重置「${confirmState.app?.app_name}」的密钥？`,
      description: '旧密钥（Access Key + Secret）将立即失效，使用旧密钥的集成会在下次调用时收到 401，需用新密钥替换。',
      confirmText: '重置密钥', danger: false,
    },
    discard: {
      title: '放弃未保存的修改？',
      description: '抽屉内有未保存的修改，关闭后将丢失本次全部录入内容。',
      confirmText: '放弃修改', danger: true,
    },
  }[confirmState?.kind]

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作栏：主操作唯一（新建应用为 Primary） */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          共 {apps.length} 个接入应用；密钥采用「仅展示一次」策略，请妥善保存
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={() => openEditor(null)}>
            <Plus className="h-3.5 w-3.5" /> 新建应用
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* 应用列表 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
      ) : apps.length === 0 ? (
        <div className="flex h-60 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground">
          <KeyRound className="h-10 w-10" />
          <div className="text-sm">暂无接入应用，为第三方系统签发 API Key 后即可开放数据调用</div>
          <button type="button" className="btn-primary btn-sm" onClick={() => openEditor(null)}>
            <Plus className="h-3.5 w-3.5" /> 新建应用
          </button>
        </div>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="w-40 px-4 py-3 text-left font-medium">应用名称</th>
                <th className="w-64 px-4 py-3 text-left font-medium">Access Key</th>
                <th className="w-20 px-4 py-3 text-left font-medium">状态</th>
                <th className="w-72 px-4 py-3 text-left font-medium">授权资源（开放的数据）</th>
                <th className="w-24 px-4 py-3 text-right font-medium">限流/分</th>
                <th className="w-24 px-4 py-3 text-right font-medium">累计调用</th>
                <th className="w-36 px-4 py-3 text-right font-medium">最近调用</th>
                <th className="px-4 py-3 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app, idx) => (
                <tr key={app.id} className={`border-t border-border ${idx % 2 === 0 ? 'bg-muted' : 'bg-card'}`}>
                  <td className="px-4 py-3">
                    <div className="truncate font-medium text-foreground" title={app.app_name}>{app.app_name}</div>
                    <div className="truncate text-xs text-muted-foreground" title={app.description}>{app.description || '-'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-primary" title={app.access_key}>{app.access_key}</span>
                      <button type="button" title="复制" onClick={() => copyText(app.access_key)} className="text-muted-foreground hover:text-primary">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {app.expires_at && (
                      <div className={`text-[11px] ${new Date(app.expires_at) < new Date() ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {new Date(app.expires_at) < new Date() ? '已过期 ' : '过期至 '}{fmtTime(app.expires_at)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={app.status === 'active' ? 'success' : 'neutral'}>
                      {app.status === 'active' ? '启用' : '停用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(app.resource_codes || []).length === 0 ? (
                        <span className="text-xs text-destructive">未授权任何资源</span>
                      ) : (
                        app.resource_codes.map((c) => (
                          <span key={c} className="rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-[11px] text-primary" title={resourceName[c]?.description || ''}>
                            {resourceName[c]?.name || c}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  {/* 数值列右对齐：个十百千精准竖直对齐 */}
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">{app.rate_limit_per_minute}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">{app.total_calls ?? 0}</td>
                  <td className="px-4 py-3 text-right text-xs tabular-nums text-muted-foreground">{fmtTime(app.last_call_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button type="button" title="编辑" onClick={() => openEditor(app)} className="text-muted-foreground hover:text-primary"><Pencil className="h-4 w-4" /></button>
                      <button type="button" title={app.status === 'active' ? '停用' : '启用'} onClick={() => toggleStatus(app)} className="text-muted-foreground hover:text-primary"><Power className="h-4 w-4" /></button>
                      <button type="button" title="重置密钥" onClick={() => setConfirmState({ kind: 'rotate', app })} className="text-muted-foreground hover:text-primary"><RefreshCw className="h-4 w-4" /></button>
                      <button type="button" title="删除" onClick={() => setConfirmState({ kind: 'delete', app })} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 编辑/新建：右侧中抽屉（保留列表上下文；遮罩/ESC 不静默丢弃） */}
      <Drawer
        open={!!editor}
        title={editor?.__new__ ? '新建接入应用' : `编辑应用：${editor?.app_name || ''}`}
        onClose={closeEditor}
        width="w-[640px]"
        footer={
          <>
            <button type="button" disabled={busy} onClick={closeEditor} className="btn-secondary btn-sm">取消</button>
            <button type="button" disabled={busy} onClick={saveApp} className="btn-primary btn-sm">
              <Check className="h-3.5 w-3.5" /> {busy ? '保存中...' : editor?.__new__ ? '创建并生成密钥' : '保存'}
            </button>
          </>
        }
      >
        {editor && (
          <div className="flex flex-col gap-5">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">应用名称 *</span>
              <input
                value={editor.app_name}
                onChange={(e) => setEditor((p) => ({ ...p, app_name: e.target.value }))}
                placeholder="如：SOC 集成系统"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">描述 / 用途</span>
              <input
                value={editor.description}
                onChange={(e) => setEditor((p) => ({ ...p, description: e.target.value }))}
                placeholder="说明该应用的使用场景"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-xs text-muted-foreground">
                授权资源 *（勾选该应用可调取的数据；未勾选的资源调用将返回 403）
              </span>
              <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-background p-3 sm:grid-cols-2">
                {resources.map((r) => {
                  const checked = editor.resource_codes.includes(r.code)
                  return (
                    <label
                      key={r.code}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors ${
                        checked ? 'border-primary/60 bg-primary/5' : 'border-border hover:border-primary/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleResource(r.code)}
                        className="mt-0.5 h-4 w-4 accent-primary"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">{r.name}</span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">{r.description}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">每分钟调用配额</span>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={editor.rate_limit_per_minute}
                  onChange={(e) => setEditor((p) => ({ ...p, rate_limit_per_minute: e.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-right text-sm tabular-nums outline-none focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">过期时间（可选）</span>
                <input
                  type="datetime-local"
                  value={editor.expires_at ? String(editor.expires_at).slice(0, 16) : ''}
                  onChange={(e) => setEditor((p) => ({ ...p, expires_at: e.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
            </div>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">IP 白名单（可选；为空则不限制来源 IP）</span>
              <div className="flex flex-wrap items-center gap-2">
                {editor.allowed_ips.map((ip) => (
                  <span key={ip} className="flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
                    {ip}
                    <button type="button" onClick={() => setEditor((p) => ({ ...p, allowed_ips: p.allowed_ips.filter((x) => x !== ip) }))}>
                      ×
                    </button>
                  </span>
                ))}
                <div className="flex items-center gap-1">
                  <input
                    value={editor.ip_input}
                    onChange={(e) => setEditor((p) => ({ ...p, ip_input: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addIp())}
                    placeholder="输入 IP 后回车"
                    className="w-44 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                  />
                  <button type="button" onClick={addIp} className="btn-secondary btn-sm">添加</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Drawer>

      {/* 确认弹窗（删除/重置密钥/放弃修改） */}
      {confirmState && confirmMeta && (
        <ConfirmDialog
          open
          title={confirmMeta.title}
          description={confirmMeta.description}
          confirmText={confirmMeta.confirmText}
          danger={confirmMeta.danger}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onClose={() => !confirmBusy && setConfirmState(null)}
        />
      )}

      {/* 一次性密钥弹窗：仅显式按钮关闭，防误关丢失 Secret */}
      {secretModal && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4" role="presentation">
          <div
            className="w-full max-w-xl rounded-lg border border-border bg-card p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="API 密钥"
          >
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              <h3 className="text-base font-semibold text-foreground">「{secretModal.app_name}」的 API 密钥</h3>
            </div>
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Secret 仅此一次显示，关闭后无法再查看！请立即复制并妥善保存。
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Access Key（公开标识）</div>
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <code className="break-all font-mono text-xs text-foreground">{secretModal.access_key}</code>
                  <button type="button" onClick={() => copyText(secretModal.access_key)} className="shrink-0 text-muted-foreground hover:text-primary"><Copy className="h-4 w-4" /></button>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Secret（仅此一次显示）</div>
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <code className="break-all font-mono text-xs text-foreground">{secretModal.secret}</code>
                  <button type="button" onClick={() => copyText(`${secretModal.access_key}:${secretModal.secret}`)} className="shrink-0 text-muted-foreground hover:text-primary" title="复制完整 X-API-Key"><Copy className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                调用方式：请求头携带 <code className="text-primary">X-API-Key: {'{access_key}:{secret}'}</code>，
                访问 <code className="text-primary">GET /api/v1/open/&#123;resource&#125;</code>（资源列表见「授权资源」列或
                <code className="text-primary"> GET /api/v1/open</code>）。
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setSecretModal(null)} className="btn-primary btn-sm">我已保存，关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
