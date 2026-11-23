// 来源系统管理：列表 / 新建 / 编辑 / 轮换密钥 / 停用 / 删除
import { useCallback, useEffect, useState } from 'react'
import { Copy, Info, KeyRound, Loader2, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { Badge, Button, CompactSelect, DataTable } from '../../components/ui'
import { Drawer, Modal } from '../../components/Dialog'
import { confirm } from '../../components/ConfirmDialog'
import { inputCls, labelCls, textareaCls } from '../../components/property/FormControls'
import { toast } from '../../store/toastStore'
import { fileReceiveApi } from '../../api/fileReceive'
import { formatTime } from './constants'

const DEFAULT_FORM = {
  source_code: '',
  source_name: '',
  status: 'active',
  allowed_exts: 'doc,docx,xls,xlsx,ppt,pptx,pdf,zip,rar,7z,txt,csv,md,json,xml',
  allowed_ips: '',
  qps: 20,
  burst: 40,
  max_concurrent_sessions: 8,
  max_file_size_mb: 200,
  session_ttl_minutes: 120,
  dedupe_scope: 'content',
  scan_required: false,
  contact: '',
  remark: '',
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function SecretModal({ info, onClose }) {
  if (!info) return null
  return (
    <Modal
      open
      title="来源凭证（仅展示一次）"
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={<Button variant="primary" onClick={onClose}>我已保存</Button>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            请立即保存以下凭证。关闭本窗口后，Secret 将不再展示；如遗失只能轮换密钥。
          </div>
        </div>
        <div>
          <div className={labelCls}>来源编码</div>
          <div className="rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.source_code}</div>
        </div>
        <div>
          <div className={labelCls}>Access Key</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.access_key}</div>
            <Button variant="secondary" size="sm" onClick={() => copyText(info.access_key)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> 复制
            </Button>
          </div>
        </div>
        <div>
          <div className={labelCls}>Secret</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.secret}</div>
            <Button variant="secondary" size="sm" onClick={() => copyText(info.secret)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> 复制
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function AccessInfoModal({ info, onClose, onRotate }) {
  if (!info) return null
  const baseUrl = `${window.location.origin}/api/v1/file-receive/open`
  return (
    <Modal
      open
      title="接入信息"
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={(
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { onClose(); onRotate(info) }}
          >
            <KeyRound className="mr-1 h-3.5 w-3.5" /> 轮换密钥
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          Secret 仅在生成/轮换时展示一次，平台不回显明文。如遗失请直接轮换密钥。
        </div>
        <div>
          <div className={labelCls}>来源编码</div>
          <div className="rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.source_code}</div>
        </div>
        <div>
          <div className={labelCls}>接入地址</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs">{baseUrl}</div>
            <Button variant="secondary" size="sm" onClick={() => copyText(baseUrl)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> 复制
            </Button>
          </div>
        </div>
        <div>
          <div className={labelCls}>Access Key</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.access_key}</div>
            <Button variant="secondary" size="sm" onClick={() => copyText(info.access_key)}>
              <Copy className="mr-1 h-3.5 w-3.5" /> 复制
            </Button>
          </div>
        </div>
        <div>
          <div className={labelCls}>Secret</div>
          <div className="rounded-md bg-secondary px-3 py-2 font-mono text-xs">{info.secret_hint || '****'}</div>
        </div>
        <div>
          <div className={labelCls}>IP 白名单</div>
          <div className="rounded-md bg-secondary px-3 py-2 text-xs">
            {(info.allowed_ips || []).length ? info.allowed_ips.join('、') : '未限制'}
          </div>
        </div>
        <div>
          <div className={labelCls}>允许格式</div>
          <div className="rounded-md bg-secondary px-3 py-2 text-xs">{(info.allowed_exts || []).join('、') || '—'}</div>
        </div>
      </div>
    </Modal>
  )
}

export default function FileReceiveSourcesDrawer({ open, onClose, startCreate = false, onChanged }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [secretInfo, setSecretInfo] = useState(null)
  const [accessInfo, setAccessInfo] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fileReceiveApi.sources())
    } catch (err) {
      toast.error(err.message || '加载来源系统失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    load()
    if (startCreate) {
      setEditing(null)
      setForm({ ...DEFAULT_FORM })
      setFormOpen(true)
    }
  }, [open, startCreate, load])

  const openCreate = () => {
    setEditing(null)
    setForm({ ...DEFAULT_FORM })
    setFormOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      ...DEFAULT_FORM,
      ...row,
      allowed_exts: (row.allowed_exts || []).join(','),
      allowed_ips: (row.allowed_ips || []).join('\n'),
    })
    setFormOpen(true)
  }

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    if (!form.source_code.trim() || !form.source_name.trim()) {
      toast.warning('请填写来源编码与名称')
      return
    }
    const payload = {
      source_code: form.source_code.trim(),
      source_name: form.source_name.trim(),
      status: form.status,
      allowed_exts: String(form.allowed_exts || '')
        .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      allowed_ips: String(form.allowed_ips || '')
        .split(/[\n,，\s]+/).map((x) => x.trim()).filter(Boolean),
      qps: Number(form.qps) || 20,
      burst: Number(form.burst) || 40,
      max_concurrent_sessions: Number(form.max_concurrent_sessions) || 8,
      max_file_size_mb: Number(form.max_file_size_mb) || 200,
      session_ttl_minutes: Number(form.session_ttl_minutes) || 120,
      dedupe_scope: form.dedupe_scope,
      scan_required: Boolean(form.scan_required),
      contact: form.contact || '',
      remark: form.remark || '',
    }
    setSaving(true)
    try {
      if (editing) {
        await fileReceiveApi.updateSource(editing.id, payload)
        toast.success('来源已更新')
        setFormOpen(false)
        await load()
        onChanged?.()
      } else {
        const created = await fileReceiveApi.createSource(payload)
        setFormOpen(false)
        setSecretInfo(created)
        await load()
        onChanged?.()
      }
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const rotate = async (row) => {
    const ok = await confirm({
      title: `轮换「${row.source_name}」的密钥？`,
      message: '新密钥立即生效，旧密钥保留 24 小时宽限。请确保对接方同步更新。',
      confirmText: '确认轮换',
    })
    if (!ok) return
    try {
      const result = await fileReceiveApi.rotateSecret(row.id)
      setSecretInfo({
        source_code: row.source_code,
        access_key: result.access_key,
        secret: result.secret,
      })
      await load()
    } catch (err) {
      toast.error(err.message || '轮换失败')
    }
  }

  const remove = async (row) => {
    const ok = await confirm({
      title: `删除来源「${row.source_name}」？`,
      message: '仅无接收记录的来源可删除；否则请使用停用。删除后不可恢复。',
      confirmText: '确认删除',
    })
    if (!ok) return
    setDeletingId(row.id)
    try {
      await fileReceiveApi.deleteSource(row.id)
      toast.success('来源已删除')
      await load()
      onChanged?.()
    } catch (err) {
      toast.error(err.message || '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  const columns = [
    {
      key: 'source',
      header: '来源系统',
      width: '180px',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{row.source_name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{row.source_code}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: '80px',
      render: (row) => (
        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
          {row.status === 'active' ? '启用' : '停用'}
        </Badge>
      ),
    },
    {
      key: 'quota',
      header: '配额',
      width: '150px',
      render: (row) => (
        <div className="text-[11px] text-muted-foreground">
          {row.qps} QPS / 突发 {row.burst}
          <br />
          并发会话 {row.max_concurrent_sessions}
        </div>
      ),
    },
    {
      key: 'exts',
      header: '允许格式',
      width: '160px',
      render: (row) => (
        <div className="truncate text-[11px] text-muted-foreground" title={(row.allowed_exts || []).join(', ')}>
          {(row.allowed_exts || []).join(', ') || '—'}
        </div>
      ),
    },
    {
      key: 'last_push_at',
      header: '最近推送',
      width: '140px',
      render: (row) => <span className="text-[11px] text-muted-foreground">{formatTime(row.last_push_at)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: '150px',
      render: (row) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setAccessInfo(row)} title="接入信息">
            <Info className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="编辑">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => rotate(row)} title="轮换密钥">
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => remove(row)}
            disabled={deletingId === row.id}
            title="删除"
          >
            {deletingId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <Drawer
        open={open}
        title="来源系统管理"
        onClose={onClose}
        width="w-[900px]"
        footer={<Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>}
      >
        <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
          新建来源时平台会自动生成 <span className="font-medium text-foreground">Access Key / Secret</span>。
          Secret 仅展示一次；外部系统必须使用 Secret 生成签名，仅携带 Access Key 不能上传成功。
        </div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            外部系统需使用 Access Key + Secret 签名后推送文件。
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 新建来源
            </Button>
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          loading={loading}
          rowKey="id"
          onRowClick={openEdit}
          rowClickHint="点击编辑"
          emptyIcon={ShieldAlert}
          emptyText="暂无来源系统"
          emptyDescription="新建来源后，外部系统才能推送文件"
        />
      </Drawer>

      <Modal
        open={formOpen}
        title={editing ? `编辑来源：${editing.source_name}` : '新建来源系统'}
        onClose={() => setFormOpen(false)}
        maxWidth="max-w-3xl"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={save}>保存</Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelCls}>来源编码 *</label>
            <input
              className={inputCls}
              value={form.source_code}
              onChange={(e) => update('source_code', e.target.value)}
              disabled={Boolean(editing)}
              placeholder="如 SOC_REPORT_CENTER"
            />
          </div>
          <div>
            <label className={labelCls}>来源名称 *</label>
            <input className={inputCls} value={form.source_name} onChange={(e) => update('source_name', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>状态</label>
            <CompactSelect block value={form.status} onChange={(e) => update('status', e.target.value)}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </CompactSelect>
          </div>
          <div>
            <label className={labelCls}>去重策略</label>
            <CompactSelect block value={form.dedupe_scope} onChange={(e) => update('dedupe_scope', e.target.value)}>
              <option value="content">内容重复标记</option>
              <option value="request_id">仅请求级幂等</option>
            </CompactSelect>
          </div>
          <div>
            <label className={labelCls}>QPS</label>
            <input type="number" min="1" className={inputCls} value={form.qps} onChange={(e) => update('qps', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>令牌桶容量（突发）</label>
            <input type="number" min="1" className={inputCls} value={form.burst} onChange={(e) => update('burst', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>并发会话上限</label>
            <input type="number" min="1" className={inputCls} value={form.max_concurrent_sessions} onChange={(e) => update('max_concurrent_sessions', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>单文件上限（MiB）</label>
            <input type="number" min="1" max="200" className={inputCls} value={form.max_file_size_mb} onChange={(e) => update('max_file_size_mb', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>会话有效期（分钟）</label>
            <input type="number" min="30" max="1440" className={inputCls} value={form.session_ttl_minutes} onChange={(e) => update('session_ttl_minutes', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>联系人</label>
            <input className={inputCls} value={form.contact} onChange={(e) => update('contact', e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>允许扩展名（逗号分隔）</label>
            <input className={inputCls} value={form.allowed_exts} onChange={(e) => update('allowed_exts', e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>IP 白名单（每行一个，支持 CIDR；留空不限制）</label>
            <textarea rows={3} className={textareaCls} value={form.allowed_ips} onChange={(e) => update('allowed_ips', e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>备注</label>
            <textarea rows={2} className={textareaCls} value={form.remark} onChange={(e) => update('remark', e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={Boolean(form.scan_required)}
              onChange={(e) => update('scan_required', e.target.checked)}
            />
            强制病毒扫描（需部署扫描服务）
          </label>
        </div>
      </Modal>

      <AccessInfoModal
        info={accessInfo}
        onClose={() => setAccessInfo(null)}
        onRotate={rotate}
      />
      <SecretModal info={secretInfo} onClose={() => setSecretInfo(null)} />
    </>
  )
}
