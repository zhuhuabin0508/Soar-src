// 工单处理分组管理页：把系统人员账号自定义分组，供流程模板节点绑定与工单流转使用
// - 分组卡片列表：名称/启停/描述/成员标签 + 编辑/成员管理/删除
// - 成员管理弹窗：全量用户勾选（复选框本身触发），支持搜索过滤
import { useState, useEffect, useMemo } from 'react'
import { Users, Plus, Pencil, Trash2, UserCog, Search, RefreshCw } from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Modal } from '../components/Dialog'
import { inputCls, inputBaseCls, labelCls } from '../components/property/FormControls'
import { Button, PageContainer, EmptyState } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import ticketApi from '../api/tickets'
import { usersApi } from '../api/users'

export default function TicketGroupManage() {
  const canEdit = hasPermission('ticket_config', 'edit')

  const [groups, setGroups] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  // 新建/编辑弹窗
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新建
  const [form, setForm] = useState({ name: '', description: '', enabled: true })
  const [saving, setSaving] = useState(false)

  // 成员管理弹窗
  const [memberTarget, setMemberTarget] = useState(null) // 当前分组
  const [memberIds, setMemberIds] = useState([])
  const [memberSearch, setMemberSearch] = useState('')
  const [memberSaving, setMemberSaving] = useState(false)

  const load = () => {
    setLoading(true)
    ticketApi.listGroups()
      .then((res) => setGroups(res.items || []))
      .catch((e) => toast.error(e.message || '加载分组失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    usersApi.list().then((res) => setUsers(res.items || res || [])).catch(() => {})
  }, [])

  const userById = useMemo(() => {
    const m = new Map()
    users.forEach((u) => m.set(u.id, u))
    return m
  }, [users])

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', description: '', enabled: true })
    setEditOpen(true)
  }

  const openEdit = (g) => {
    setEditing(g)
    setForm({ name: g.name, description: g.description || '', enabled: g.enabled })
    setEditOpen(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) return toast.error('请输入分组名称')
    setSaving(true)
    const body = { name: form.name.trim(), description: form.description.trim(), enabled: form.enabled }
    const req = editing ? ticketApi.updateGroup(editing.id, body) : ticketApi.createGroup(body)
    req
      .then(() => { toast.success(editing ? '分组已更新' : '分组已创建'); setEditOpen(false); load() })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  const handleDelete = (g) => {
    confirm({
      title: '删除处理分组',
      message: `确认删除分组「${g.name}」？删除后流程模板中绑定该分组的节点将无法发布，进行中工单不受影响。不可恢复。`,
      variant: 'danger',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return
      ticketApi.deleteGroup(g.id)
        .then(() => { toast.success('分组已删除'); load() })
        .catch((e) => toast.error(e.message || '删除失败'))
    })
  }

  const openMembers = (g) => {
    setMemberTarget(g)
    setMemberIds((g.members || []).map((m) => m.user_id))
    setMemberSearch('')
  }

  const toggleMember = (uid) => {
    setMemberIds((s) => (s.includes(uid) ? s.filter((x) => x !== uid) : [...s, uid]))
  }

  const handleSaveMembers = () => {
    setMemberSaving(true)
    ticketApi.updateGroupMembers(memberTarget.id, memberIds)
      .then(() => { toast.success('分组成员已更新'); setMemberTarget(null); load() })
      .catch((e) => toast.error(e.message || '保存成员失败'))
      .finally(() => setMemberSaving(false))
  }

  const filteredUsers = useMemo(() => {
    const kw = memberSearch.trim().toLowerCase()
    if (!kw) return users
    return users.filter(
      (u) => (u.username || '').toLowerCase().includes(kw)
        || (u.display_name || '').toLowerCase().includes(kw)
        || (u.department || '').toLowerCase().includes(kw),
    )
  }, [users, memberSearch])

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">处理分组</h1>
            {!loading && (
              <span className="text-sm font-medium tabular-nums text-foreground">
                共 {groups.length.toLocaleString()} 个分组
              </span>
            )}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">将系统人员账号自定义分组（如监测预警组、研判分析组、应急处置组），流程节点绑定分组后，组内全员可见、任一成员提交即代表全组</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新分组列表">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
          {canEdit && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />新建分组
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card-stagger grid grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex h-[168px] flex-col rounded-lg border border-border bg-card px-6 py-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="h-9 w-9 shrink-0 rounded-md skeleton-shimmer" />
                  <div className="flex-1">
                    <div className="h-4 w-1/3 rounded skeleton-shimmer" />
                    <div className="mt-2 h-3 w-1/2 rounded skeleton-shimmer" />
                  </div>
                </div>
                <div className="h-7 w-24 rounded skeleton-shimmer" />
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
                <div className="h-3 w-16 rounded skeleton-shimmer" />
                <div className="flex gap-1.5">
                  <div className="h-6 w-14 rounded skeleton-shimmer" />
                  <div className="h-6 w-14 rounded skeleton-shimmer" />
                  <div className="h-6 w-14 rounded skeleton-shimmer" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !groups.length ? (
        <EmptyState
          icon={Users}
          title="暂无处理分组"
          description="创建分组后即可在流程模板中绑定节点，开始编排工单流转"
          action={canEdit && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />新建分组
            </Button>
          )}
        />
      ) : (
        <div className="card-stagger grid grid-cols-1 gap-4 xl:grid-cols-2">
          {groups.map((g) => (
            <div key={g.id} className="card-hover flex flex-col rounded-lg border border-border bg-card p-6 transition-colors hover:border-primary/40">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Users className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-foreground">{g.name}</span>
                      <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${g.enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                        {g.enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[13px] text-muted-foreground">{g.description || '暂无描述'}</p>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => openEdit(g)} className="btn-secondary btn-sm" title="编辑分组">
                      <Pencil className="h-3 w-3" />编辑
                    </button>
                    <button onClick={() => openMembers(g)} className="btn-secondary btn-sm" title="管理成员">
                      <UserCog className="h-3 w-3" />成员
                    </button>
                    <button onClick={() => handleDelete(g)} className="btn-danger btn-sm" title="删除分组">
                      <Trash2 className="h-3 w-3" />删除
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-1 flex-col justify-end">
                <div className="text-xs text-muted-foreground">
                  成员（<span className={`font-medium tabular-nums ${g.member_count ? 'text-foreground' : 'text-muted-foreground'}`}>{(g.member_count || 0).toLocaleString()}</span>）
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(g.members || []).length ? g.members.slice(0, 8).map((m) => (
                    <span key={m.user_id} className="whitespace-nowrap rounded bg-muted px-2 py-1 text-xs text-foreground">
                      {m.display_name || m.username}
                    </span>
                  )) : <span className="text-xs text-muted-foreground">暂无成员</span>}
                  {(g.members || []).length > 8 && (
                    <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">等 <span className="tabular-nums">{g.members.length.toLocaleString()}</span> 人</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建/编辑分组 */}
      <Modal
        open={editOpen}
        title={editing ? '编辑分组' : '新建分组'}
        onClose={() => setEditOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>保存</Button>
          </>
        }
      >
        <div className="space-y-4 py-2">
          <div>
            <label className={labelCls}>分组名称<span className="text-red-500">*</span></label>
            <input className={inputCls} placeholder="如：监测预警组" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>描述</label>
            <textarea className={`${inputCls} resize-y`} rows={2} placeholder="分组职责说明（选填）"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>启用状态</label>
            <div className="flex items-center gap-5">
              {[true, false].map((b) => (
                <label key={String(b)} className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="group-enabled" className="h-4 w-4 accent-primary" checked={form.enabled === b}
                    onChange={() => setForm({ ...form, enabled: b })} />
                  <span className="text-sm text-foreground">{b ? '启用' : '停用'}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* 成员管理：全量勾选 */}
      <Modal
        open={!!memberTarget}
        title={`管理成员${memberTarget ? ` - ${memberTarget.name}` : ''}`}
        onClose={() => setMemberTarget(null)}
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setMemberTarget(null)}>取消</Button>
            <Button variant="primary" size="sm" loading={memberSaving} onClick={handleSaveMembers}>
              保存（已选 {memberIds.length} 人）
            </Button>
          </>
        }
      >
        {memberTarget && (
          <div className="py-2">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={`${inputBaseCls} h-9 w-full pl-9`}
                placeholder="搜索账号 / 姓名 / 部门"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
              />
            </div>
            <div className="max-h-[420px] space-y-0.5 overflow-y-auto rounded-md border border-border p-2">
              {filteredUsers.length ? filteredUsers.map((u) => {
                const checked = memberIds.includes(u.id)
                return (
                  <label
                    key={u.id}
                    className={`flex cursor-pointer items-center gap-3 rounded px-3 py-2 ${checked ? 'bg-primary/5' : 'hover:bg-muted'}`}
                  >
                    {/* 复选框本身触发选择，整行仅作视觉反馈 */}
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked}
                      onChange={() => toggleMember(u.id)} onClick={(e) => e.stopPropagation()} />
                    <span className="font-medium text-foreground">{u.display_name || u.username}</span>
                    <span className="text-xs text-muted-foreground">{u.username}</span>
                    {u.department && <span className="ml-auto text-xs text-muted-foreground">{u.department}</span>}
                  </label>
                )
              }) : (
                <div className="py-8 text-center text-sm text-muted-foreground">未找到匹配用户</div>
              )}
            </div>
            {!!users.length && (
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>共 {users.length} 个账号，已选 {memberIds.length} 人</span>
                {!!memberIds.length && (
                  <button className="hover:text-foreground" onClick={() => setMemberIds([])}>清空选择</button>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
