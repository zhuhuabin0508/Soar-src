import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Lock, MoreHorizontal, Copy, Users, Trash2, Eye, Pencil, ChevronDown, ChevronRight,
  Search, Filter, CopyPlus, ShieldCheck, AlertTriangle,
} from 'lucide-react'
import { rolesApi } from '../api/roles'
import { usersApi } from '../api/users'
import { hasPermission } from '../utils/permissions'
import { Drawer, Modal } from '../components/Dialog'
import { Section, TextInput } from '../components/property/FormControls'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'

// 后端 /roles/modules 未及时热更新时，仍保证矩阵能画出这些行
const LOCAL_MODULE_FALLBACK = {
  asset_discovery: ['view', 'edit', 'delete'],
  bigscreen: ['view'],
  bigscreen2: ['view'],
}
const LOCAL_MODULE_LABELS = {
  asset_discovery: '资产发现',
  bigscreen: '盾立方W',
  bigscreen2: '盾立方指挥大屏',
}

function mergeModuleDef(modData) {
  const modules = { ...LOCAL_MODULE_FALLBACK, ...(modData?.modules || {}) }
  const module_labels = { ...LOCAL_MODULE_LABELS, ...(modData?.module_labels || {}) }
  return {
    modules,
    module_labels,
    action_labels: modData?.action_labels || {},
  }
}

/** 把接口多出来的资产类模块插进「资源管理」，避免只改了后端却不在分组里显示 */
function resolveModuleGroups(modules) {
  const groups = MODULE_GROUPS.map((g) => ({ ...g, modules: [...g.modules] }))
  const listed = new Set(groups.flatMap((g) => g.modules))
  const resources = groups.find((g) => g.key === 'resources')
  Object.keys(modules || {}).forEach((mod) => {
    if (listed.has(mod)) return
    if (!resources) return
    if (mod === 'govcloud' || mod.startsWith('asset_')) {
      const idx = resources.modules.indexOf('deliverable')
      if (idx >= 0) resources.modules.splice(idx, 0, mod)
      else resources.modules.push(mod)
      listed.add(mod)
    }
  })
  return groups
}

// 模块分组定义：顺序与侧边栏目录（AppShell NAV_GROUPS）保持一致
const MODULE_AGENT_HINTS = {
  tool: '模块级开关，在「智能体编排」而不是「系统管理」。勾上执行后，该智能体白名单里的普通库工具才会进入对话。这里不能按单个工具授权。',
  device: '模块级开关，在「连接配置」。查看对应设备读动作，编辑对应写动作和封禁。具体哪台设备由智能体的 enabled_devices 决定。',
  knowledge_base: '控制对话里的知识库检索，需要「查看」。',
  workflow_list: '控制把已发布工作流当成工具调用，需要「执行」。',
  asset_list: '控制对话里的资产检索，需要「查看」。',
}

const MODULE_GROUPS = [
  {
    key: 'workspace',
    label: '运营中心',
    modules: ['dashboard', 'bigscreen', 'bigscreen2', 'approval', 'chat'],
  },
  {
    key: 'orchestration',
    label: '智能体编排',
    modules: ['agent', 'workflow_list', 'workflow_editor', 'ban_workflow', 'skill', 'tool', 'knowledge_base'],
  },
  {
    key: 'resources',
    label: '资源管理',
    modules: ['asset_overview', 'asset_list', 'asset_templates', 'asset_discovery', 'deliverable'],
  },
  {
    key: 'operations',
    label: '运营管理',
    modules: ['duty_member', 'duty_schedule', 'duty_leave', 'duty_log', 'duty_dashboard'],
  },
  {
    key: 'config',
    label: '连接配置',
    modules: ['llm_config', 'device', 'strategy', 'alert', 'monitor'],
  },
  {
    key: 'monitor',
    label: '运行监控',
    modules: ['execution', 'notification'],
  },
  {
    key: 'system',
    label: '系统管理',
    modules: ['user', 'role', 'feedback', 'system_config', 'system_monitor', 'audit_log'],
  },
]

// 所有动作列表（用于表头）
const ALL_ACTIONS = ['view', 'edit', 'delete', 'execute', 'approve', 'export']

// 检查是否拥有全部权限
function hasAllPermissions(permissions, moduleDef) {
  const modules = moduleDef.modules || {}
  for (const [mod, actions] of Object.entries(modules)) {
    const userActions = permissions[mod] || []
    if (!actions.every((a) => userActions.includes(a))) return false
  }
  return true
}

// 统计权限数
function countPermissions(permissions) {
  return Object.values(permissions || {}).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0
  )
}

// ============ 行操作下拉菜单 ============
function RowActions({ row, handlers, canEdit, canDelete }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onMouse = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return
      const menu = document.getElementById('role-actions-menu')
      if (menu && menu.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const menuW = 176
      const menuH = 240
      const left = Math.min(rect.right - menuW, window.innerWidth - menuW - 8)
      const top = Math.min(rect.bottom + 4, window.innerHeight - menuH - 8)
      setMenuPos({ top, left })
    }
    setOpen((v) => !v)
  }

  const handleAction = (fn) => () => {
    setOpen(false)
    fn()
  }

  const items = []
  if (canEdit) {
    items.push({ icon: Copy, label: '克隆角色', onClick: handleAction(() => handlers.onClone(row)) })
  }
  items.push({ icon: Users, label: '查看已分配用户', onClick: handleAction(() => handlers.onViewUsers(row)) })
  const dangerItems = []
  if (canDelete && !row.is_system) {
    dangerItems.push({ icon: Trash2, label: '删除角色', onClick: handleAction(() => handlers.onDelete(row)) })
  }

  const renderItem = (it, danger = false) => (
    <button
      key={it.label}
      type="button"
      onClick={it.onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition hover:bg-secondary ${danger ? 'text-destructive' : 'text-foreground'}`}
    >
      <it.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{it.label}</span>
    </button>
  )

  return (
    <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => handlers.onEdit(row)} className="btn-secondary btn-sm inline-flex items-center gap-1" title={canEdit ? '编辑' : '查看'}>
        {canEdit ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        <span>{canEdit ? '编辑' : '查看'}</span>
      </button>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition hover:bg-secondary ${open ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
        aria-label="更多操作"
      >
        更多
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          id="role-actions-menu"
          className="fixed z-[9999] w-44 overflow-hidden rounded-md border border-border bg-card py-1 shadow-2xl"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {items.map((it) => renderItem(it))}
          {dangerItems.length > 0 && <div className="my-1 border-t border-border" />}
          {dangerItems.map((it) => renderItem(it, true))}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ============ 权限矩阵表格 ============
function PermissionMatrixTable({ form, moduleDef, onToggle, onSetModuleAll, onSetActionAll, onSetAll, search }) {
  const moduleLabels = moduleDef.module_labels || {}
  const actionLabels = moduleDef.action_labels || {}
  const modules = moduleDef.modules || {}

  // 获取实际出现的动作列表（去重）
  const actionsInUse = useMemo(() => {
    const set = new Set()
    Object.values(modules).forEach((arr) => arr.forEach((a) => set.add(a)))
    return ALL_ACTIONS.filter((a) => set.has(a))
  }, [modules])

  const groupedModules = useMemo(() => resolveModuleGroups(modules), [modules])

  // 按分组过滤
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groupedModules
    const q = search.toLowerCase()
    return groupedModules.map((g) => ({
      ...g,
      modules: g.modules.filter((m) =>
        (moduleLabels[m] || m).toLowerCase().includes(q) || m.toLowerCase().includes(q)
      ),
    })).filter((g) => g.modules.length > 0)
  }, [search, moduleLabels, groupedModules])

  // 某动作是否全选（所有模块都勾选了该动作）
  const isActionAllChecked = (action) => {
    return Object.entries(modules).every(([mod, actions]) => {
      if (!actions.includes(action)) return true
      return (form.permissions[mod] || []).includes(action)
    })
  }

  // 某模块是否全选
  const isModuleAllChecked = (modName, actions) => {
    const userActions = form.permissions[modName] || []
    return actions.length > 0 && actions.every((a) => userActions.includes(a))
  }

  // 是否所有权限都勾选
  const isAllChecked = useMemo(() => {
    return Object.entries(modules).every(([mod, actions]) => {
      const userActions = form.permissions[mod] || []
      return actions.every((a) => userActions.includes(a))
    })
  }, [form.permissions, modules])

  const toggleActionAll = (action) => {
    const shouldSelect = !isActionAllChecked(action)
    onSetActionAll(action, shouldSelect)
  }

  // 计算分组已授权权限数 X/Y
  const getGroupPermCount = (group) => {
    let authorized = 0
    let total = 0
    group.modules.forEach((modName) => {
      const actions = modules[modName] || LOCAL_MODULE_FALLBACK[modName]
      if (!actions) return
      total += actions.length
      authorized += (form.permissions[modName] || []).filter((a) => actions.includes(a)).length
    })
    return { authorized, total }
  }

  // 分组是否全选
  const isGroupAllChecked = (group) => {
    return group.modules.every((modName) => {
      const actions = modules[modName] || LOCAL_MODULE_FALLBACK[modName]
      if (!actions) return true
      return isModuleAllChecked(modName, actions)
    })
  }

  // 分组折叠状态：无任何已授权权限的分组默认折叠
  const [collapsed, setCollapsed] = useState(() => {
    const init = {}
    groupedModules.forEach((g) => {
      const { authorized } = getGroupPermCount(g)
      init[g.key] = authorized === 0
    })
    return init
  })

  const toggleGroup = (key) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // 全选 / 清空本组
  const setGroupAll = (group, selectAll) => {
    group.modules.forEach((modName) => {
      const actions = modules[modName] || LOCAL_MODULE_FALLBACK[modName]
      if (!actions) return
      onSetModuleAll(modName, actions, selectAll)
    })
  }

  return (
    <div className="space-y-4">
      {/* 顶部全选操作 */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 p-2">
        <button
          type="button"
          onClick={() => onSetAll(!isAllChecked)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition ${
            isAllChecked
              ? 'bg-primary/20 text-primary'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
        >
          {isAllChecked ? '✓ 全部权限已开启' : '一键开启全部权限'}
        </button>
        <span className="text-[11px] text-muted-foreground/70">|</span>
        <button
          type="button"
          onClick={() => toggleActionAll('view')}
          className="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          {isActionAllChecked('view') ? '取消' : '勾选'}全部查看
        </button>
      </div>

      {/* 分组表格 */}
      {filteredGroups.map((group) => {
        const { authorized, total } = getGroupPermCount(group)
        const isCollapsed = collapsed[group.key]
        const groupAllChecked = isGroupAllChecked(group)
        return (
          <div key={group.key} className="overflow-hidden rounded-md border border-border">
            {/* 分组标题（可折叠） */}
            <div className="flex items-center justify-between bg-secondary/60 px-3 py-2">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="flex items-center gap-2 text-xs font-semibold text-foreground transition hover:text-primary"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {group.label}
                <span className="text-[10px] font-normal text-muted-foreground/70">
                  已授权 {authorized}/{total} 项
                </span>
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setGroupAll(group, !groupAllChecked)}
                  className="rounded px-2 py-0.5 text-[10px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  {groupAllChecked ? '清空本组' : '全选本组'}
                </button>
              </div>
            </div>
            {/* 表格（折叠时隐藏） */}
            {!isCollapsed && (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-3 py-2 text-left text-[11px] font-medium text-muted-foreground">模块</th>
                    {actionsInUse.map((action) => (
                      <th key={action} className="px-2 py-2 text-center text-[11px] font-medium text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => toggleActionAll(action)}
                          className={`transition hover:text-primary ${isActionAllChecked(action) ? 'text-primary' : ''}`}
                          title={`${isActionAllChecked(action) ? '取消' : '勾选'}所有模块的${actionLabels[action] || action}权限`}
                        >
                          {actionLabels[action] || action}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.modules.map((modName) => {
                    const actions = modules[modName] || LOCAL_MODULE_FALLBACK[modName]
                    if (!actions) return null
                    const userActions = form.permissions[modName] || []
                    return (
                      <tr key={modName} className="border-b border-border/50 last:border-0 hover:bg-secondary/20">
                        <td className="px-3 py-3 text-xs text-foreground">
                          <div className="font-medium">{moduleLabels[modName] || LOCAL_MODULE_LABELS[modName] || modName}</div>
                          {MODULE_AGENT_HINTS[modName] ? (
                            <div className="mt-0.5 max-w-[280px] text-[10px] leading-4 text-muted-foreground">{MODULE_AGENT_HINTS[modName]}</div>
                          ) : (
                            <div className="text-[10px] text-muted-foreground/60">{modName}</div>
                          )}
                        </td>
                        {actionsInUse.map((action) => {
                          const supported = actions.includes(action)
                          const checked = userActions.includes(action)
                          return (
                            <td key={action} className="px-2 py-3 text-center">
                              <label
                                className={`inline-flex h-6 w-6 items-center justify-center ${supported ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                                title={supported ? undefined : '该模块不支持此操作'}
                              >
                                <input
                                  type="checkbox"
                                  checked={supported ? checked : false}
                                  disabled={!supported}
                                  onChange={() => onToggle(modName, action)}
                                  className="h-4 w-4 rounded border-border bg-secondary text-primary focus:ring-1 focus:ring-primary disabled:opacity-30"
                                />
                              </label>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
      {filteredGroups.length === 0 && (
        <div className="py-8 text-center text-xs text-muted-foreground/70">
          未找到匹配「{search}」的权限模块
        </div>
      )}
    </div>
  )
}

// ============ 角色管理页面 ============
function RoleManagement() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [moduleDef, setModuleDef] = useState({
    modules: {},
    module_labels: {},
    action_labels: {},
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 搜索和筛选
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  // 编辑相关
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    display_name: '',
    description: '',
    permissions: {},
  })
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [permSearch, setPermSearch] = useState('')
  const bypassGuard = useUnsavedChanges(dirty)

  // 已分配用户弹窗
  const [usersModalOpen, setUsersModalOpen] = useState(false)
  const [usersModalRole, setUsersModalRole] = useState(null)
  const [usersList, setUsersList] = useState([])
  const [usersLoading, setUsersLoading] = useState(false)

  const canView = hasPermission('role', 'view')
  const canEdit = hasPermission('role', 'edit')
  const canDelete = hasPermission('role', 'delete')

  const load = useCallback(async () => {
    if (!canView) {
      setError('您没有查看角色列表的权限')
      setLoading(false)
      return
    }
    try {
      const [roleData, modData] = await Promise.all([
        rolesApi.list(),
        rolesApi.modules(),
      ])
      setRows(Array.isArray(roleData) ? roleData : [])
      setModuleDef(mergeModuleDef(modData))
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    load()
  }, [load])

  // 筛选
  const filteredRows = useMemo(() => {
    let result = rows
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      )
    }
    if (typeFilter === 'system') {
      result = result.filter((r) => r.is_system)
    } else if (typeFilter === 'custom') {
      result = result.filter((r) => !r.is_system)
    }
    return result
  }, [rows, search, typeFilter])

  const openCreate = () => {
    setEditing(null)
    const initPerms = {}
    Object.keys(moduleDef.modules || {}).forEach((m) => {
      initPerms[m] = []
    })
    setForm({
      name: '',
      display_name: '',
      description: '',
      permissions: initPerms,
    })
    setPermSearch('')
    setDirty(false)
    setEditOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      name: row.name || '',
      display_name: row.name || '',
      description: row.description || '',
      permissions: { ...(row.permissions || {}) },
    })
    setPermSearch('')
    setDirty(false)
    setEditOpen(true)
  }

  const openClone = (row) => {
    setEditing(null)
    setForm({
      name: `${row.name}_copy`,
      display_name: `${row.name}_copy`,
      description: row.description ? `克隆自 ${row.name}：${row.description}` : `克隆自 ${row.name}`,
      permissions: JSON.parse(JSON.stringify(row.permissions || {})),
    })
    setPermSearch('')
    setDirty(true)
    setEditOpen(true)
  }

  // 切换某个模块的某个动作（含权限依赖：勾选 edit/delete/execute/approve 时自动勾选 view）
  const togglePermission = (moduleName, action) => {
    setForm((prev) => {
      const currentActions = prev.permissions[moduleName] || []
      const willSelect = !currentActions.includes(action)
      let nextActions
      if (willSelect) {
        // 勾选 edit/delete/execute/approve 时自动勾选 view
        nextActions = [...currentActions, action]
        if (action !== 'view' && !nextActions.includes('view')) {
          const modActions = (moduleDef.modules || {})[moduleName] || []
          if (modActions.includes('view')) {
            nextActions.push('view')
          }
        }
      } else {
        // 取消 view 时自动取消 edit/delete/execute/approve
        nextActions = currentActions.filter((a) => a !== action)
        if (action === 'view') {
          nextActions = nextActions.filter((a) => a === 'view')
        }
      }
      return {
        ...prev,
        permissions: { ...prev.permissions, [moduleName]: nextActions },
      }
    })
    setDirty(true)
  }

  const setModuleAll = (moduleName, actions, selectAll) => {
    setForm((prev) => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [moduleName]: selectAll ? [...actions] : [],
      },
    }))
    setDirty(true)
  }

  // 勾选/取消所有模块的某个动作
  const setActionAll = (action, selectAll) => {
    setForm((prev) => {
      const newPerms = { ...prev.permissions }
      Object.entries(moduleDef.modules || {}).forEach(([mod, actions]) => {
        if (!actions.includes(action)) return
        const current = new Set(newPerms[mod] || [])
        if (selectAll) {
          current.add(action)
          // 依赖：勾选非 view 时自动加 view
          if (action !== 'view' && actions.includes('view')) {
            current.add('view')
          }
        } else {
          current.delete(action)
          if (action === 'view') {
            // 取消 view 时移除所有依赖 view 的动作
            ALL_ACTIONS.forEach((a) => { if (a !== 'view') current.delete(a) })
          }
        }
        newPerms[mod] = Array.from(current)
      })
      return { ...prev, permissions: newPerms }
    })
    setDirty(true)
  }

  // 一键全选/清空所有权限
  const setAll = (selectAll) => {
    setForm((prev) => {
      const newPerms = {}
      Object.entries(moduleDef.modules || {}).forEach(([mod, actions]) => {
        newPerms[mod] = selectAll ? [...actions] : []
      })
      return { ...prev, permissions: newPerms }
    })
    setDirty(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.warning('请填写角色名')
      return
    }
    if (!/^[a-z0-9_]+$/.test(form.name.trim())) {
      toast.warning('角色名仅支持小写字母、数字、下划线')
      return
    }
    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        description: form.description || null,
        permissions: form.permissions,
      }
      if (editing) {
        await rolesApi.update(editing.id, body)
      } else {
        await rolesApi.create(body)
      }
      setDirty(false)
      bypassGuard()
      setEditOpen(false)
      await load()
      toast.success(editing ? '角色已更新' : '角色已创建')
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row) => {
    // 先查询该角色下是否有用户
    if (row.user_count > 0) {
      toast.error(`该角色已分配给 ${row.user_count} 个用户，请先移除或转移用户后再删除`)
      return
    }
    const _ok = await confirm({
      message: `确定删除角色「${row.name}」吗？删除后无法恢复。`,
      variant: 'danger',
      confirmText: '确定删除',
    })
    if (!_ok) return
    try {
      await rolesApi.remove(row.id)
      await load()
      toast.success('角色已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 查看已分配用户
  const handleViewUsers = async (row) => {
    setUsersModalRole(row)
    setUsersModalOpen(true)
    setUsersLoading(true)
    setUsersList([])
    try {
      const allUsers = await usersApi.list()
      const filtered = (Array.isArray(allUsers) ? allUsers : []).filter(
        (u) => u.role_id === row.id
      )
      setUsersList(filtered)
    } catch (err) {
      toast.error(`加载用户列表失败：${err.message || err}`)
    } finally {
      setUsersLoading(false)
    }
  }

  const handleCopyName = (name) => {
    navigator.clipboard?.writeText(name)
    toast.success(`角色标识「${name}」已复制`)
  }

  // 统计信息
  const totalPermCount = useMemo(
    () => countPermissions({}),
    []
  )
  const totalModules = Object.keys(moduleDef.modules || {}).length

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card/60 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">角色管理</h1>
          <span className="text-xs text-muted-foreground/70">共 {rows.length} 个角色</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm">刷新</button>
          {canEdit && (
            <button type="button" onClick={openCreate} className="btn-primary btn-sm">+ 新建角色</button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* 搜索筛选 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索角色名 / 描述..."
              className="w-full rounded-md border border-border bg-secondary py-2 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary"
          >
            <option value="">全部类型</option>
            <option value="system">系统内置</option>
            <option value="custom">自定义</option>
          </select>
          {(search || typeFilter) && (
            <button
              type="button"
              onClick={() => { setSearch(''); setTypeFilter('') }}
              className="btn-secondary btn-sm"
            >
              重置
            </button>
          )}
        </div>

        {/* 角色列表 */}
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground/70">
            加载中...
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground/70">
            <ShieldCheck className="h-10 w-10" />
            <div className="text-sm">
              {search || typeFilter ? '未匹配到符合条件的角色' : '暂无自定义角色'}
            </div>
            {!search && !typeFilter && canEdit && (
              <button type="button" onClick={openCreate} className="btn-primary btn-sm mt-1">+ 新建角色</button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filteredRows.map((r) => {
              const permCount = countPermissions(r.permissions)
              const isFull = hasAllPermissions(r.permissions || {}, moduleDef)
              const moduleCount = Object.entries(r.permissions || {}).filter(
                ([, arr]) => Array.isArray(arr) && arr.length > 0
              ).length
              const moduleLabels = moduleDef.module_labels || {}
              const actionLabels = moduleDef.action_labels || {}
              const moduleEntries = Object.entries(moduleDef.modules || {})

              return (
                <div
                  key={r.id}
                  className={`rounded-lg border bg-card/40 p-4 transition hover:border-primary/40 ${
                    r.is_system ? 'border-warning/30' : 'border-border'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {/* 标题行 */}
                      <div className="flex items-center gap-2">
                        {r.is_system && (
                          <Lock className="h-3.5 w-3.5 shrink-0 text-warning" title="系统内置角色" />
                        )}
                        <button
                          type="button"
                          onClick={() => handleCopyName(r.name)}
                          className="min-w-0 truncate text-base font-semibold text-foreground hover:text-primary"
                          title="点击复制角色标识"
                        >
                          {r.name}
                        </button>
                        {r.is_system && (
                          <span className="rounded bg-warning/20 px-2 py-0.5 text-[10px] font-medium text-warning">
                            系统内置
                          </span>
                        )}
                      </div>

                      {/* 描述 */}
                      {r.description && (
                        <div className="mt-1 truncate text-sm text-muted-foreground">
                          {r.description}
                        </div>
                      )}

                      {/* 权限总览 */}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {isFull ? (
                          <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                            全部权限 · {permCount} 项 / {totalModules} 模块
                          </span>
                        ) : (
                          <span className="rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                            {permCount} 项权限 · {moduleCount} 个模块
                          </span>
                        )}
                        <span className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                          <Users className="h-3 w-3" />
                          已分配 {r.user_count || 0} 人
                        </span>
                      </div>

                      {/* 权限模块标签（按模块聚合） */}
                      {!isFull && permCount > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {moduleEntries.map(([modName, actions]) => {
                            const userActions = r.permissions?.[modName] || []
                            if (userActions.length === 0) return null
                            return (
                              <span
                                key={modName}
                                className="rounded border border-border bg-secondary/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                                title={`${moduleLabels[modName] || modName}：${userActions.map((a) => actionLabels[a] || a).join(' / ')}`}
                              >
                                <span className="text-foreground/80">{moduleLabels[modName] || modName}</span>
                                <span className="mx-1 text-muted-foreground/40">·</span>
                                <span className="text-primary">{userActions.length}/{actions.length}</span>
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* 操作 */}
                    <div className="shrink-0">
                      <RowActions
                        row={r}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        handlers={{
                          onEdit: openEdit,
                          onClone: openClone,
                          onViewUsers: handleViewUsers,
                          onDelete: handleDelete,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建/编辑角色抽屉 */}
      <Drawer
        open={editOpen}
        title={editing ? `编辑角色：${editing.name}` : '新建角色'}
        onClose={() => { setDirty(false); setEditOpen(false) }}
        width="w-[760px]"
        footer={
          <>
            <button
              type="button"
              onClick={() => { setDirty(false); setEditOpen(false) }}
              className="btn-secondary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canEdit}
              className="btn-primary"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {/* 系统内置角色警告 */}
        {editing?.is_system && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning/90">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">系统内置角色，修改后将影响所有使用该角色的用户</div>
              <div className="mt-0.5 text-warning/70">该角色已分配给 {editing.user_count || 0} 个用户</div>
            </div>
          </div>
        )}

        <Section title="角色基础">
          <TextInput
            label="角色名（唯一标识）"
            value={form.name}
            onChange={(v) => { setForm((p) => ({ ...p, name: v })); setDirty(true) }}
            placeholder="如：soc_lead"
            hint={editing?.is_system ? '系统内置角色名建议不修改' : '仅支持小写字母、数字、下划线，创建后不可修改'}
          />
          <TextInput
            label="描述"
            value={form.description}
            onChange={(v) => { setForm((p) => ({ ...p, description: v })); setDirty(true) }}
            placeholder="角色职责说明，便于其他管理员理解"
          />
        </Section>

        <Section title="权限矩阵" hint="勾选对应模块下的动作，编辑权限会自动勾选查看权限">
          {/* 权限搜索 */}
          <div className="mb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <input
                type="text"
                value={permSearch}
                onChange={(e) => setPermSearch(e.target.value)}
                placeholder="搜索权限模块..."
                className="w-full rounded-md border border-border bg-secondary py-2 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <PermissionMatrixTable
            form={form}
            moduleDef={moduleDef}
            onToggle={togglePermission}
            onSetModuleAll={setModuleAll}
            onSetActionAll={setActionAll}
            onSetAll={setAll}
            search={permSearch}
          />
        </Section>
      </Drawer>

      {/* 已分配用户弹窗 */}
      <Modal
        open={usersModalOpen}
        title={usersModalRole ? `已分配用户：${usersModalRole.name}` : '已分配用户'}
        onClose={() => setUsersModalOpen(false)}
        maxWidth="max-w-lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setUsersModalOpen(false)
                navigate(`/users?role=${usersModalRole?.name}`)
              }}
              className="btn-secondary"
            >
              在用户管理中查看
            </button>
            <button
              type="button"
              onClick={() => setUsersModalOpen(false)}
              className="btn-primary"
            >
              关闭
            </button>
          </>
        }
      >
        {usersLoading ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground/70">
            加载中...
          </div>
        ) : usersList.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center gap-1 text-muted-foreground/70">
            <Users className="h-8 w-8" />
            <div className="text-xs">该角色暂无已分配用户</div>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            <div className="mb-2 text-xs text-muted-foreground">共 {usersList.length} 个用户</div>
            <div className="space-y-2">
              {usersList.map((u) => (
                <div key={u.id} className="flex items-center gap-3 rounded-md border border-border bg-secondary/40 p-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-sm font-bold text-primary">
                    {(u.username || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {u.display_name || u.username}
                    </div>
                    <div className="text-xs text-muted-foreground">@{u.username}</div>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-[10px] ${
                    u.is_active
                      ? 'bg-success/20 text-success'
                      : 'bg-destructive/20 text-destructive'
                  }`}>
                    {u.is_active ? '启用' : '禁用'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default RoleManagement
