// 资源共享设置弹窗：owner/admin 可将资源的查看或编辑权限共享给其他用户。
//
// 资源级 owner 权限控制的补充：
// - permission=view：被授权用户对该资源获得查看权限（可进详情页，保存禁用）
// - permission=edit：被授权用户对该资源获得编辑权限（可编辑、保存）
// 不改变 owner 归属，被授权用户也不能再转授或撤销共享。
//
// 用法：
//   <ShareDialog
//     open={shareOpen}
//     onClose={() => setShareOpen(false)}
//     resourceType="workflow"      // workflow / agent / tool / skill / knowledge_base
//     resourceId={r.id}
//     resourceName={r.name}
//   />
import { useState, useEffect, useCallback } from 'react'
import {
  Share2, UserPlus, Trash2, Loader2, Eye, Pencil,
  Users, Workflow, Bot, Wrench, BrainCircuit, BookOpen,
} from 'lucide-react'
import { Modal } from './Dialog'
import { CompactSelect } from './ui'
import { resourceShares } from '../api/client'
import { usersApi } from '../api/users'
import { rolesApi } from '../api/roles'
import { toast } from '../store/toastStore'
import { confirm } from './ConfirmDialog'

// 资源类型 → 中文标签 + 图标
const TYPE_META = {
  workflow: { label: '工作流', Icon: Workflow },
  agent: { label: '智能体', Icon: Bot },
  tool: { label: '工具', Icon: Wrench },
  skill: { label: '技能', Icon: BrainCircuit },
  knowledge_base: { label: '知识库', Icon: BookOpen },
}

// 用户名首字母头像：取首字符（中英文皆可）转大写，配主色背景
function Avatar({ name, color }) {
  const ch = String(name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${color || 'bg-primary'}`}
      aria-hidden="true"
    >
      {ch}
    </span>
  )
}

// 权限切换：segmented control（按钮组，比 select 更直观）
function PermissionPicker({ value, onChange, disabled }) {
  const opts = [
    { value: 'view', label: '查看', Icon: Eye, active: 'bg-blue-500/15 text-blue-400' },
    { value: 'edit', label: '编辑', Icon: Pencil, active: 'bg-primary/15 text-primary' },
  ]
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border bg-muted p-0.5">
      {opts.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
              active ? o.active : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <o.Icon className="h-3 w-3" />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function ShareDialog({
  open,
  onClose,
  resourceType,
  resourceId,
  resourceName,
  // 资源真实所有者 ID（创建者 user.id）：传入后会从用户列表解析真实姓名+角色
  // 不传则兜底显示当前登录用户（仅在 owner 自己打开时正确）
  ownerUserId,
}) {
  const [shares, setShares] = useState([])
  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedUserIds, setSelectedUserIds] = useState(new Set())
  const [selectedPermission, setSelectedPermission] = useState('view')
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const [selectedRolePermission, setSelectedRolePermission] = useState('view')

  // 切换某个用户的选中状态
  const toggleUser = (uid) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }
  // 全选 / 取消全选
  const selectAll = (enable) => {
    setSelectedUserIds((prev) => {
      if (!enable) return new Set()
      const next = new Set()
      availableUsers.forEach((u) => next.add(u.id))
      return next
    })
  }

  // 拉取共享列表与用户列表
  const loadData = useCallback(async () => {
    if (!open || !resourceType || !resourceId) return
    setLoading(true)
    try {
      const [shareList, userList, roleList] = await Promise.all([
        resourceShares.list(resourceType, resourceId),
        usersApi.list().catch(() => []),
        rolesApi.list().catch(() => []),
      ])
      setShares(shareList || [])
      setUsers(userList || [])
      setRoles(roleList || [])
    } catch (err) {
      toast.error(err.message || '加载共享列表失败')
    } finally {
      setLoading(false)
    }
  }, [open, resourceType, resourceId])

  useEffect(() => {
    if (open) {
      setSelectedUserIds(new Set())
      setSelectedPermission('view')
      setSelectedRoleId('')
      setSelectedRolePermission('view')
      loadData()
    }
  }, [open, loadData])

  // 添加共享
  // 批量授权：依次调用 add，收集成功/失败结果并汇总反馈
  const handleAdd = async () => {
    if (selectedUserIds.size === 0) {
      toast.warning('请选择要授权的用户')
      return
    }
    setSubmitting(true)
    const uids = Array.from(selectedUserIds)
    let okCount = 0
    const failed = []
    try {
      // 顺序调用：避免并发触发后端重复权限校验时的竞态
      for (const uid of uids) {
        try {
          await resourceShares.add(resourceType, resourceId, Number(uid), selectedPermission)
          okCount += 1
        } catch (err) {
          failed.push({ uid, err })
        }
      }
      const permLabel = selectedPermission === 'edit' ? '编辑' : '查看'
      if (okCount > 0) {
        toast.success(`已为 ${okCount} 位用户添加${permLabel}授权`)
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} 位用户授权失败，请查看列表确认（可能已被授权或重复操作）`)
      }
      // 清空选择 + 重新加载列表
      setSelectedUserIds(new Set())
      setSelectedPermission('view')
      await loadData()
    } finally {
      setSubmitting(false)
    }
  }

  // 撤销共享
  const handleRevoke = async (userId, username) => {
    const ok = await confirm({
      title: '撤销共享',
      message: `确定撤销「${username}」对此资源的授权吗？`,
      variant: 'danger',
    })
    if (!ok) return
    try {
      await resourceShares.revoke(resourceType, resourceId, userId)
      toast.success('已撤销共享授权')
      await loadData()
    } catch (err) {
      toast.error(err.message || '撤销共享失败')
    }
  }

  // 更新已授权用户的权限级别（后端对已存在的授权做更新，如 查看 -> 编辑）
  const handleUpdatePermission = async (userId, username, permission) => {
    try {
      await resourceShares.add(resourceType, resourceId, Number(userId), permission)
      toast.success(`已将「${username}」的权限更新为${permission === 'edit' ? '编辑' : '查看'}`)
      await loadData()
    } catch (err) {
      toast.error(err.message || '更新授权权限失败')
    }
  }

  const handleAddRole = async () => {
    if (!selectedRoleId) {
      toast.warning('请选择要授权的角色')
      return
    }
    setSubmitting(true)
    try {
      await resourceShares.addRole(resourceType, resourceId, Number(selectedRoleId), selectedRolePermission)
      toast.success(`已为角色添加${selectedRolePermission === 'edit' ? '编辑' : '查看'}授权`)
      setSelectedRoleId('')
      setSelectedRolePermission('view')
      await loadData()
    } catch (err) {
      toast.error(err.message || '角色授权失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevokeRole = async (roleId, roleName) => {
    const ok = await confirm({
      title: '撤销角色共享',
      message: `确定撤销角色「${roleName}」对此资源的授权吗？`,
      variant: 'danger',
    })
    if (!ok) return
    try {
      await resourceShares.revokeRole(resourceType, resourceId, roleId)
      toast.success('已撤销角色共享授权')
      await loadData()
    } catch (err) {
      toast.error(err.message || '撤销角色共享失败')
    }
  }

  const handleUpdateRolePermission = async (roleId, roleName, permission) => {
    try {
      await resourceShares.addRole(resourceType, resourceId, Number(roleId), permission)
      toast.success(`已将角色「${roleName}」的权限更新为${permission === 'edit' ? '编辑' : '查看'}`)
      await loadData()
    } catch (err) {
      toast.error(err.message || '更新角色授权失败')
    }
  }

  const sharedUserIds = new Set(shares.filter((s) => s.shared_with).map((s) => s.shared_with))
  const sharedRoleIds = new Set(shares.filter((s) => s.shared_with_role).map((s) => s.shared_with_role))
  // 可选用户：启用且未被共享且非自己（owner 已有权限）
  const currentUserId = (() => {
    try {
      const u = JSON.parse(localStorage.getItem('soar_user') || 'null')
      return u?.id
    } catch {
      return null
    }
  })()
  const availableUsers = users.filter(
    (u) => u.is_active && !sharedUserIds.has(u.id) && u.id !== currentUserId
  )
  const availableRoles = roles.filter((r) => !sharedRoleIds.has(r.id))

  // 用户 ID → 用户对象映射（用于展示共享列表中的用户名）
  const userMap = new Map(users.map((u) => [u.id, u]))
  const resolveUsername = (uid) => {
    const u = userMap.get(uid)
    return u ? (u.display_name ? `${u.display_name}（${u.username}）` : u.username) : `用户#${uid}`
  }

  // 资源类型元信息（带兜底）
  const typeMeta = TYPE_META[resourceType] || { label: '资源', Icon: Share2 }
  const TypeIcon = typeMeta.Icon

  // 资源所有者（创建者）解析：优先用 ownerUserId 从用户列表查真实姓名+角色；
  // 没传 ownerUserId 时兜底用 localStorage 当前用户（仅在 owner 自己打开时正确）
  const currentUserObj = (() => {
    try {
      return JSON.parse(localStorage.getItem('soar_user') || 'null')
    } catch {
      return null
    }
  })()
  const ownerUser = (ownerUserId != null && userMap.get(Number(ownerUserId))) || null
  const ownerObj = ownerUser || currentUserObj
  const ownerName = ownerObj
    ? (ownerObj.display_name
        ? `${ownerObj.display_name}（${ownerObj.username}）`
        : ownerObj.username)
    : (ownerUserId != null ? `用户#${ownerUserId}` : '你自己')
  const ownerRole = ownerObj?.role || null
  const isOwnerMe = !ownerUser && (currentUserObj != null)

  // 权限分布统计
  const editCount = shares.filter((s) => s.permission === 'edit').length
  const viewCount = shares.filter((s) => s.permission === 'view').length

  // 授权人用户名解析（granted_by → 用户名）
  const resolveGrantor = (gid) => {
    if (gid == null) return null
    const u = userMap.get(Number(gid))
    return u ? (u.display_name || u.username) : `#${gid}`
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-1.5">
          <Share2 className="h-4 w-4 text-primary" />
          共享设置{resourceName ? ` · ${resourceName}` : ''}
        </span>
      }
    >
      {/* 资源信息卡：让用户清楚正在共享什么 */}
      <div className="flex items-center gap-3 rounded-md border border-border bg-secondary px-3 py-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <TypeIcon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-card-foreground">
            {resourceName || '未命名资源'}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {typeMeta.label} · 仅创建者与管理员可管理授权
          </div>
        </div>
      </div>

      {/* 添加授权区（支持批量多选） */}
      <div className="mt-3 rounded-md border border-border bg-background p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-card-foreground">
            <UserPlus className="h-3.5 w-3.5 text-primary" />
            添加授权
            {availableUsers.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                （已选 {selectedUserIds.size} / 可选 {availableUsers.length}）
              </span>
            )}
          </div>
          <PermissionPicker
            value={selectedPermission}
            onChange={setSelectedPermission}
            disabled={submitting}
          />
        </div>

        {/* 用户多选列表 */}
        {availableUsers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
            暂无可授权用户
          </div>
        ) : (
          <>
            {/* 全选 / 反选 / 清空 工具条 */}
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
              <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
                <input
                  type="checkbox"
                  className="h-3 w-3 rounded border-border accent-primary"
                  checked={
                    availableUsers.length > 0 &&
                    selectedUserIds.size === availableUsers.length
                  }
                  onChange={(e) => selectAll(e.target.checked)}
                  disabled={submitting}
                />
                全选
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedUserIds((prev) => {
                      const next = new Set()
                      availableUsers.forEach((u) => {
                        if (!prev.has(u.id)) next.add(u.id)
                      })
                      return next
                    })
                  }
                  disabled={submitting}
                  className="hover:text-foreground disabled:cursor-not-allowed"
                >
                  反选
                </button>
                <span className="text-border">|</span>
                <button
                  type="button"
                  onClick={() => setSelectedUserIds(new Set())}
                  disabled={submitting || selectedUserIds.size === 0}
                  className="hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  清空
                </button>
              </div>
            </div>

            {/* 可滚动用户列表 */}
            <div className="max-h-52 overflow-auto rounded-md border border-border">
              {availableUsers.map((u) => {
                const checked = selectedUserIds.has(u.id)
                return (
                  <label
                    key={u.id}
                    className={`flex cursor-pointer items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0 hover:bg-secondary ${
                      checked ? 'bg-primary/5' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                      checked={checked}
                      onChange={() => toggleUser(u.id)}
                      disabled={submitting}
                    />
                    <Avatar
                      name={u.display_name || u.username}
                      color={checked ? (selectedPermission === 'edit' ? 'bg-primary' : 'bg-blue-500') : 'bg-muted-foreground'}
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate text-xs text-card-foreground">
                        {u.display_name || u.username}
                      </span>
                      {u.display_name && (
                        <span className="truncate text-xs text-muted-foreground">
                          （{u.username}）
                        </span>
                      )}
                      {u.role && (
                        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                          {u.role}
                        </span>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          </>
        )}

        {/* 批量授权按钮 */}
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAdd}
            disabled={submitting || selectedUserIds.size === 0}
            className="btn-primary btn-sm inline-flex flex-1 items-center justify-center gap-1 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                授权中…
              </>
            ) : (
              <>
                <UserPlus className="h-3.5 w-3.5" />
                {selectedUserIds.size > 0
                  ? `批量授权（${selectedUserIds.size} 人）`
                  : '授权'}
              </>
            )}
          </button>
        </div>

        {/* 权限说明随选择切换，更直观 */}
        <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          {selectedPermission === 'edit' ? (
            <>
              <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
              <span>编辑：被授权用户可查看并修改、保存此资源</span>
            </>
          ) : (
            <>
              <Eye className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
              <span>查看：被授权用户可进入详情页查看，保存按钮禁用</span>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-md border border-border bg-background p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-card-foreground">
            <Users className="h-3.5 w-3.5 text-primary" />
            按角色授权
          </div>
          <PermissionPicker
            value={selectedRolePermission}
            onChange={setSelectedRolePermission}
            disabled={submitting}
          />
        </div>
        <div className="flex gap-2">
          <CompactSelect
            size="lg"
            block
            className="flex-1"
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
            disabled={submitting}
          >
            <option value="">选择角色…</option>
            {availableRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </CompactSelect>
          <button
            type="button"
            onClick={handleAddRole}
            disabled={submitting || !selectedRoleId}
            className="btn-primary btn-sm shrink-0"
          >
            授权角色
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          该角色下所有用户将获得对应权限（查看或编辑）。
        </p>
      </div>

      {/* 已授权列表：所有者 + 已授权用户 + 权限分布 */}
      <div className="mt-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-card-foreground">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            已授权用户 / 角色
            <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-secondary px-1.5 text-xs font-medium text-muted-foreground">
              {shares.length}
            </span>
          </div>
          {/* 权限分布统计：编辑 N · 查看 M，让管理员快速了解授权结构 */}
          {shares.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-0.5 text-primary">
                <Pencil className="h-2.5 w-2.5" />
                编辑 {editCount}
              </span>
              <span className="text-border">|</span>
              <span className="inline-flex items-center gap-0.5 text-blue-400">
                <Eye className="h-2.5 w-2.5" />
                查看 {viewCount}
              </span>
            </div>
          )}
        </div>

        {/* 资源所有者（创建者）：始终在列表顶部高亮显示，最高权限徽标为「所有者」 */}
        <div className="mb-2 flex items-center justify-between rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Avatar name={ownerName} color="bg-primary" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm text-card-foreground">{ownerName}</span>
                {/* 所有者角色徽标（如有） */}
                {ownerRole && (
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                    {ownerRole}
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {isOwnerMe ? '资源创建者（你自己）' : '资源创建者'}
              </span>
            </div>
          </div>
          <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
            <Share2 className="h-2.5 w-2.5" />
            所有者
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-md border border-dashed border-border py-6 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : shares.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            <Users className="mb-1.5 h-5 w-5 opacity-50" />
            暂无被授权用户或角色
            <span className="mt-0.5 text-xs text-muted-foreground">
              在上方选择用户或角色并授权后，将出现在这里
            </span>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shares.map((s) => {
              const isRoleShare = Boolean(s.shared_with_role)
              const displayName = isRoleShare
                ? `角色：${s.role_name || `#${s.shared_with_role}`}`
                : resolveUsername(s.shared_with)
              const isEdit = s.permission === 'edit'
              const grantor = resolveGrantor(s.granted_by)
              return (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar
                      name={displayName}
                      color={isEdit ? 'bg-primary' : 'bg-blue-500'}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm text-card-foreground">
                        {displayName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {grantor ? `由 ${grantor} 授权` : '由所有者授权'}
                        {s.created_at ? ` · ${new Date(s.created_at).toLocaleString('zh-CN')}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <PermissionPicker
                      value={s.permission || 'view'}
                      onChange={(v) => {
                        if (v === s.permission) return
                        if (isRoleShare) {
                          handleUpdateRolePermission(s.shared_with_role, s.role_name || displayName, v)
                        } else {
                          handleUpdatePermission(s.shared_with, displayName, v)
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => (
                        isRoleShare
                          ? handleRevokeRole(s.shared_with_role, s.role_name || displayName)
                          : handleRevoke(s.shared_with, displayName)
                      )}
                      className="btn-danger btn-sm inline-flex items-center gap-1"
                      title="撤销共享"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      撤销
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
