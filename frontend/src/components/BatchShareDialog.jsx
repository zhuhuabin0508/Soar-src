// 批量授权弹窗：在资源列表页（工具/技能/智能体/工作流/知识库）多选若干资源后，
// 把所选全部资源一次性授权给多位用户、某一权限级别。
//
// 设计目标：跨资源批量授权，避免「一个一个资源点击共享」。
// 后端调用：对每个 (resourceId × userId) 组合调用一次 resourceShares.add。
//
// 用法：
//   <BatchShareDialog
//     open={batchShareOpen}
//     onClose={() => setBatchShareOpen(false)}
//     resourceType="tool"            // workflow / agent / tool / skill / knowledge_base
//     resources={selectedRows}      // [{ id, name }, ...] 选中的资源
//     onDone={() => clear()}        // 授权完成后清空选择
//   />
import { useState, useEffect, useCallback } from 'react'
import {
  Share2, UserPlus, Trash2, Loader2, Eye, Pencil, Users,
} from 'lucide-react'
import { Modal } from './Dialog'
import { resourceShares } from '../api/client'
import { usersApi } from '../api/users'
import { toast } from '../store/toastStore'

// 用户名首字母头像：与 ShareDialog 保持一致
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

// 权限切换：segmented control（与 ShareDialog 视觉一致）
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

export default function BatchShareDialog({
  open,
  onClose,
  resourceType,
  resources,
  onDone,
}) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 批量授权：用 Set 存放已选中的用户 ID，支持一次给多人授权
  const [selectedUserIds, setSelectedUserIds] = useState(new Set())
  const [selectedPermission, setSelectedPermission] = useState('view')

  // 拉取可选用户列表
  const loadUsers = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const list = await usersApi.list().catch(() => [])
      setUsers(Array.isArray(list) ? list : [])
    } finally {
      setLoading(false)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setSelectedUserIds(new Set())
      setSelectedPermission('view')
      loadUsers()
    }
  }, [open, loadUsers])

  // 当前登录用户 ID（owner 不应出现在可选列表里）
  const currentUserId = (() => {
    try {
      const u = JSON.parse(localStorage.getItem('soar_user') || 'null')
      return u?.id
    } catch {
      return null
    }
  })()
  // 可选用户：启用且非自己
  const availableUsers = users.filter((u) => u.is_active && u.id !== currentUserId)

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
    if (!enable) {
      setSelectedUserIds(new Set())
      return
    }
    const next = new Set()
    availableUsers.forEach((u) => next.add(u.id))
    setSelectedUserIds(next)
  }

  // 批量授权：对每个 (resourceId × userId) 调用 add
  const handleAdd = async () => {
    if (selectedUserIds.size === 0) {
      toast.warning('请选择要授权的用户')
      return
    }
    if (!resources || resources.length === 0) {
      toast.warning('未选择任何资源')
      return
    }
    setSubmitting(true)
    let okCount = 0
    let failCount = 0
    const uids = Array.from(selectedUserIds)
    try {
      // 外层遍历资源、内层遍历用户：避免并发触发后端重复权限校验时的竞态
      for (const r of resources) {
        if (!r?.id) continue
        for (const uid of uids) {
          try {
            await resourceShares.add(resourceType, r.id, Number(uid), selectedPermission)
            okCount += 1
          } catch (_err) {
            failCount += 1
          }
        }
      }
      const permLabel = selectedPermission === 'edit' ? '编辑' : '查看'
      const total = uids.length * resources.length
      if (okCount > 0) {
        toast.success(
          `已为 ${uids.length} 位用户批量添加${permLabel}授权，共 ${okCount}/${total} 项成功`
        )
      }
      if (failCount > 0) {
        toast.error(`${failCount} 项授权失败，请重试`)
      }
      setSelectedUserIds(new Set())
      setSelectedPermission('view')
      if (typeof onDone === 'function') onDone()
      if (typeof onClose === 'function') onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const resCount = resources?.length || 0
  const userCount = selectedUserIds.size
  const total = resCount * userCount

  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      size="md"
      title={
        <span className="flex items-center gap-1.5">
          <Share2 className="h-4 w-4 text-primary" />
          批量授权{resCount ? ` · ${resCount} 个资源` : ''}
        </span>
      }
    >
      <p className="text-xs text-muted-foreground">
        把所选的全部资源一次性授权给多位用户。不改变创建者归属，被授权用户也不能再转授。
      </p>

      {/* 资源信息卡：折叠展示已选资源列表 */}
      <details className="mt-3 rounded-md border border-border bg-secondary px-3 py-2">
        <summary className="flex cursor-pointer items-center justify-between text-xs font-medium text-card-foreground">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-primary" />
            已选资源（{resCount}）
          </span>
          <span className="text-xs font-normal text-muted-foreground">点击展开</span>
        </summary>
        <ul className="mt-2 max-h-40 overflow-auto border-t border-border pt-2">
          {(resources || []).map((r, idx) => (
            <li key={r.id ?? idx} className="truncate py-0.5 text-xs text-muted-foreground">
              {idx + 1}. {r.name || `资源#${r.id}`}
            </li>
          ))}
        </ul>
      </details>

      {/* 添加授权区（支持多选用户） */}
      <div className="mt-3 rounded-md border border-border bg-background p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-card-foreground">
            <UserPlus className="h-3.5 w-3.5 text-primary" />
            选择授权用户
            {availableUsers.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                （已选 {userCount} / 可选 {availableUsers.length}）
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
            {loading ? '加载用户中…' : '暂无可授权用户'}
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
                    userCount === availableUsers.length
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
                  disabled={submitting || userCount === 0}
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
        <div className="mt-2.5">
          <button
            type="button"
            onClick={handleAdd}
            disabled={submitting || userCount === 0 || resCount === 0}
            className="btn-primary btn-sm inline-flex w-full items-center justify-center gap-1 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                授权中…
              </>
            ) : (
              <>
                <UserPlus className="h-3.5 w-3.5" />
                {total > 0
                  ? `批量授权（${resCount} 个资源 × ${userCount} 位用户 = ${total} 项）`
                  : '授权'}
              </>
            )}
          </button>
        </div>

        {/* 权限说明随选择切换 */}
        <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          {selectedPermission === 'edit' ? (
            <>
              <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
              <span>编辑：被授权用户可查看并修改、保存所有选中资源</span>
            </>
          ) : (
            <>
              <Eye className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
              <span>查看：被授权用户可进入所有选中资源的详情页查看，保存按钮禁用</span>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
