import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Trash2, MoreHorizontal, Eye, KeyRound, Power, LogOut, UserX, UserCheck,
  ChevronUp, ChevronDown, Users, Eye as EyeIcon, EyeOff, RefreshCw,
  FileText, ChevronRight, CheckCircle2, Upload, Download, FileSpreadsheet,
  LockOpen,
} from 'lucide-react'
import { usersApi } from '../api/users'
import { rolesApi } from '../api/roles'
import { useAuthStore } from '../store/authStore'
import { authApi } from '../api/auth'
import { hasPermission } from '../utils/permissions'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { DataTable, Pagination, EmptyState, Badge, StatusBadge } from '../components/ui'
import FilterBar from '../components/FilterBar'
import BatchActions from '../components/BatchActions'
import { usePagination } from '../hooks/usePagination'
import { useSelection } from '../hooks/useSelection'
import { usePersistedFilters } from '../hooks/usePersistedFilters'
import {
  Section,
  TextInput,
  SelectInput,
} from '../components/property/FormControls'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'

// 格式化时间（紧凑，避免表格 table-fixed 把「最后登录」裁成 16:4…）
function fmtTime(t) {
  if (!t) return '-'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 角色中文映射
const ROLE_LABELS = {
  admin: '管理员',
  analyst: '分析师',
  viewer: '访客',
}

// ============ 密码强度计算 ============
function calcPasswordStrength(pwd, policy = {}) {
  if (!pwd) return { score: 0, label: '', checks: [] }
  const minLen = policy.min_length || 8
  const checks = [
    { label: `至少 ${minLen} 位`, pass: pwd.length >= minLen },
    ...(policy.require_uppercase !== false ? [{ label: '包含大写字母', pass: /[A-Z]/.test(pwd) }] : []),
    ...(policy.require_lowercase !== false ? [{ label: '包含小写字母', pass: /[a-z]/.test(pwd) }] : []),
    ...(policy.require_digit !== false ? [{ label: '包含数字', pass: /\d/.test(pwd) }] : []),
    ...(policy.require_special !== false ? [{ label: '包含特殊字符', pass: /[^A-Za-z0-9]/.test(pwd) }] : []),
  ]
  const passCount = checks.filter((c) => c.pass).length
  const totalChecks = checks.length
  let score = 0
  let label = ''
  if (pwd.length >= minLen) score = 1
  if (pwd.length >= minLen + 2 && passCount >= Math.min(3, totalChecks)) score = 2
  if (pwd.length >= minLen + 4 && passCount >= Math.min(4, totalChecks)) score = 3
  if (pwd.length >= minLen + 6 && passCount >= totalChecks) score = 4
  if (score <= 1) label = '弱'
  else if (score === 2) label = '中'
  else if (score === 3) label = '强'
  else label = '非常强'
  return { score, label, checks }
}

function _pickChar(chars) {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return chars[buf[0] % chars.length]
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// 生成符合当前密码策略的随机密码（各类字符至少各 1 个，再填充打乱）
function generateRandomPassword(policy = {}) {
  const minLen = Math.max(Number(policy.min_length) || 8, 12)
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const LOWER = 'abcdefghjkmnpqrstuvwxyz'
  const DIGIT = '23456789'
  const SPECIAL = '!@#$%^&*'
  const pools = []
  if (policy.require_uppercase !== false) pools.push(UPPER)
  if (policy.require_lowercase !== false) pools.push(LOWER)
  if (policy.require_digit !== false) pools.push(DIGIT)
  if (policy.require_special !== false) pools.push(SPECIAL)
  if (!pools.length) pools.push(UPPER, LOWER, DIGIT)
  const all = pools.join('')
  const chars = pools.map((set) => _pickChar(set))
  while (chars.length < minLen) chars.push(_pickChar(all))
  return _shuffle(chars).join('')
}

// ============ Switch 开关组件 ============
function Switch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-all hover:ring-2 hover:ring-primary/30 ${
        checked ? 'bg-primary' : 'bg-input'
      } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:ring-0`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// ============ 密码输入框（带显隐切换） ============
function PasswordField({ label, value, onChange, placeholder, hint, required, showStrength, rightSlot, policy }) {
  const [show, setShow] = useState(false)
  const strength = useMemo(() => (showStrength ? calcPasswordStrength(value, policy) : null), [value, showStrength, policy])
  const strengthColors = ['bg-muted', 'bg-destructive', 'bg-warning', 'bg-primary', 'bg-success']
  const strengthWidths = ['0%', '25%', '50%', '75%', '100%']
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive">*</span>}
      </label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input-base h-9 pr-28"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {rightSlot}
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="text-muted-foreground transition hover:text-foreground"
            tabIndex={-1}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {showStrength && value && strength && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${strengthColors[strength.score]}`}
                style={{ width: strengthWidths[strength.score] }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground">{strength.label}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {strength.checks.map((c, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-none ${
                  c.pass
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <span className="w-3 shrink-0 text-center">{c.pass ? '✓' : '○'}</span>
                {c.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 用户详情抽屉 ============
function UserDetailDrawer({ open, user, onClose, onEdit, onUnlock }) {
  useLockBackgroundScroll(open)
  if (!open || !user) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        data-allow-scroll
        className="flex h-full w-full max-w-md flex-col overflow-y-auto overscroll-contain border-l border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 text-lg font-bold text-primary-foreground">
              {(user.username || '?')[0].toUpperCase()}
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">
                {user.display_name || user.username}
              </div>
              <div className="text-xs text-muted-foreground">@{user.username}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* 标签 */}
        <div className="flex flex-wrap gap-2 px-5 py-3">
          <Badge variant="primary">
            {ROLE_LABELS[user.role_name] || user.role_name || ROLE_LABELS[user.role] || user.role || '-'}
          </Badge>
          <StatusBadge
            color={user.is_active ? 'success' : 'neutral'}
            label={user.is_active ? '启用' : '禁用'}
          />
          {user.is_locked && <StatusBadge color="warning" label="已冻结" />}
        </div>

        {/* 基本信息 */}
        <div className="px-5 py-3">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">基本信息</h3>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">用户 ID</span>
              <span className="font-mono text-foreground">#{user.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">邮箱</span>
              <span className="text-foreground">{user.email || '未绑定'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">创建时间</span>
              <span className="tabular-nums text-foreground">{fmtTime(user.created_at)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">最近登录</span>
              <span className="tabular-nums text-foreground">{fmtTime(user.last_login_at)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">登录状态</span>
              <span className={user.is_locked ? 'font-medium text-warning' : 'text-foreground'}>
                {user.is_locked
                  ? `已冻结${user.locked_until ? `（至 ${fmtTime(user.locked_until)}）` : '（需人工解锁）'}`
                  : '正常'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">连续登录失败</span>
              <span className="tabular-nums text-foreground">{user.failed_login_count ?? 0} 次</span>
            </div>
          </div>
        </div>

        {/* 操作 */}
        <div className="mt-auto border-t border-border p-5">
          {user.is_locked && onUnlock && (
            <button
              type="button"
              onClick={() => onUnlock(user)}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-warning/50 bg-warning/10 py-2 text-sm font-medium text-warning transition hover:bg-warning/20"
            >
              <LockOpen className="h-4 w-4" />
              解除冻结
            </button>
          )}
          <button
            type="button"
            onClick={() => { onClose(); onEdit(user) }}
            className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            编辑用户
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ============ 行操作下拉菜单 ============
function RowActions({ row, handlers, canEdit, canDelete, isSelf }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onMouse = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return
      // 点击菜单内部不关闭（菜单自身会处理）
      const menu = document.getElementById('row-actions-menu')
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

  const { onView, onEdit, onReset, onToggleActive, onDelete, onForceLogout, onViewLoginLogs, onUnlock } = handlers

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const menuW = 176
      const menuH = 320
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

  // 构建菜单项
  const items = []
  items.push({ icon: Eye, label: '查看详情', onClick: handleAction(() => onView(row)) })
  if (canEdit) {
    items.push({ icon: KeyRound, label: '重置密码', onClick: handleAction(() => onReset(row)) })
  }
  // 登录失败次数过多被冻结的账户：管理员可立即解除冻结
  if (canEdit && row.is_locked) {
    items.push({ icon: LockOpen, label: '解除冻结', onClick: handleAction(() => onUnlock(row)) })
  }
  if (canEdit && !isSelf) {
    items.push({
      icon: row.is_active ? Power : UserCheck,
      label: row.is_active ? '禁用账号' : '启用账号',
      onClick: handleAction(() => onToggleActive(row)),
    })
  }
  if (canEdit && !isSelf) {
    items.push({ icon: LogOut, label: '强制下线', onClick: handleAction(() => onForceLogout(row)) })
  }
  items.push({ icon: FileText, label: '查看登录日志', onClick: handleAction(() => onViewLoginLogs(row)) })
  // 分隔符 + 删除
  const dangerItems = []
  if (canDelete && !isSelf) {
    dangerItems.push({ icon: Trash2, label: '删除账号', onClick: handleAction(() => onDelete(row)) })
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
      {canEdit && (
        <button type="button" onClick={() => onEdit(row)} className="btn-secondary btn-sm">编辑</button>
      )}
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition hover:bg-secondary ${open ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
        aria-label="更多操作"
        title="更多操作"
      >
        更多
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          id="row-actions-menu"
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

// ============ 用户管理页面 ============
function UserManagement() {
  const [rows, setRows] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const currentUser = useAuthStore((s) => s.user)

  // 编辑相关
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    username: '',
    password: '',
    display_name: '',
    email: '',
    role: 'analyst',
    role_id: null,
    is_active: true,
    force_change_password: false,
    allowed_login_methods: ['password', 'otp', 'sso'], // 默认允许全部方式
  })
  const [saving, setSaving] = useState(false)
  const [formErrors, setFormErrors] = useState({})

  // 筛选 / 分页 / 批量选择
  const [{ search, roleFilter, statusFilter, loginFilter }, setFilters] = usePersistedFilters('user_mgmt', {
    search: '',
    roleFilter: '',
    statusFilter: '',
    loginFilter: '',
  })
  const setSearch = (v) => setFilters({ search: v })
  const setRoleFilter = (v) => setFilters({ roleFilter: v })
  const setStatusFilter = (v) => setFilters({ statusFilter: v })
  const setLoginFilter = (v) => setFilters({ loginFilter: v })
  const { selectedKeys, setSelectedKeys, clear } = useSelection()
  const [deleting, setDeleting] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)

  // 排序
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  // 详情抽屉
  const [detailUser, setDetailUser] = useState(null)

  // 重置密码弹窗
  const [resetOpen, setResetOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetting, setResetting] = useState(false)

  // 密码策略（从系统设置动态加载）
  const [pwdPolicy, setPwdPolicy] = useState({ min_length: 8, require_uppercase: true, require_lowercase: true, require_digit: true, require_special: true })
  useEffect(() => {
    authApi.getPasswordPolicy().then(setPwdPolicy).catch(() => {})
  }, [])

  // 批量导入
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importStrategy, setImportStrategy] = useState('skip')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)

  const canView = hasPermission('user', 'view')
  const canEdit = hasPermission('user', 'edit')
  const canDelete = hasPermission('user', 'delete')

  const load = useCallback(async () => {
    if (!canView) {
      setError('您没有查看用户列表的权限')
      setLoading(false)
      return
    }
    try {
      const [userData, roleData] = await Promise.all([
        usersApi.list(),
        rolesApi.list(),
      ])
      setRows(Array.isArray(userData) ? userData : [])
      setRoles(Array.isArray(roleData) ? roleData : [])
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

  // 筛选 + 排序
  const filteredRows = useMemo(() => {
    let result = rows
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((r) => [r.username, r.display_name, r.email].some((v) => (v || '').toLowerCase().includes(q)))
    }
    if (roleFilter) {
      result = result.filter((r) => r.role === roleFilter)
    }
    if (statusFilter) {
      result = result.filter((r) => {
        if (statusFilter === 'locked') return !!r.is_locked
        return statusFilter === 'active' ? r.is_active : !r.is_active
      })
    }
    if (loginFilter) {
      const now = Date.now()
      result = result.filter((r) => {
        if (loginFilter === 'never') return !r.last_login_at
        if (!r.last_login_at) return false
        const t = new Date(r.last_login_at).getTime()
        const days = (now - t) / 86400000
        if (loginFilter === 'today') return days < 1
        if (loginFilter === '7d') return days < 7
        if (loginFilter === '30d') return days < 30
        return true
      })
    }
    // 排序
    if (sortKey) {
      result = [...result].sort((a, b) => {
        let av = a[sortKey]
        let bv = b[sortKey]
        if (sortKey === 'last_login_at' || sortKey === 'created_at') {
          av = av ? new Date(av).getTime() : 0
          bv = bv ? new Date(bv).getTime() : 0
        }
        if (typeof av === 'string') av = av.toLowerCase()
        if (typeof bv === 'string') bv = bv.toLowerCase()
        if (av < bv) return sortDir === 'asc' ? -1 : 1
        if (av > bv) return sortDir === 'asc' ? 1 : -1
        return 0
      })
    }
    return result
  }, [rows, search, roleFilter, statusFilter, loginFilter, sortKey, sortDir])

  const { page, pageSize, paged, setPage, setPageSize } = usePagination(filteredRows, { pageSize: 20 })

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const openCreate = () => {
    setEditing(null)
    setForm({
      username: '',
      password: '',
      display_name: '',
      email: '',
      role: 'analyst',
      role_id: null,
      is_active: true,
      force_change_password: false,
      allowed_login_methods: ['password', 'otp', 'sso'],
    })
    setFormErrors({})
    setEditOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      username: row.username || '',
      password: '',
      display_name: row.display_name || '',
      email: row.email || '',
      role: row.role || 'analyst',
      role_id: row.role_id || null,
      is_active: !!row.is_active,
      force_change_password: false,
      allowed_login_methods: row.allowed_login_methods || ['password', 'otp', 'sso'],
    })
    setFormErrors({})
    setEditOpen(true)
  }

  const setField = (field) => (value) =>
    setForm((prev) => ({ ...prev, [field]: value }))

  const validateForm = () => {
    const errs = {}
    if (!form.username.trim()) errs.username = '请填写用户名'
    if (!editing && !form.password) errs.password = '请填写初始密码'
    if (!editing && form.password.length > 0 && form.password.length < (pwdPolicy.min_length || 8)) errs.password = `密码至少 ${pwdPolicy.min_length || 8} 位`
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = '邮箱格式不正确'
    setFormErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSave = async () => {
    if (!validateForm()) return
    setSaving(true)
    try {
      if (editing) {
        const body = {
          display_name: form.display_name || null,
          email: form.email || null,
          role: form.role,
          role_id: form.role_id,
          is_active: form.is_active,
          allowed_login_methods: form.allowed_login_methods,
        }
        await usersApi.update(editing.id, body)
      } else {
        const body = {
          username: form.username,
          password: form.password,
          display_name: form.display_name || null,
          email: form.email || null,
          role: form.role,
          role_id: form.role_id,
          is_active: form.is_active,
          allowed_login_methods: form.allowed_login_methods,
        }
        await usersApi.create(body)
      }
      setEditOpen(false)
      await load()
      toast.success(editing ? '用户已更新' : '用户已创建')
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row) => {
    const _ok = await confirm({ message: `确定删除用户「${row.display_name || row.username}」吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await usersApi.remove(row.id)
      setSelectedKeys((prev) => prev.filter((k) => k !== row.id))
      await load()
      toast.success('用户已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({ message: `确定删除选中的 ${selectedKeys.length} 个用户吗？此操作不可撤销。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    setDeleting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await usersApi.remove(id); ok++ } catch { fail++ }
    }
    clear()
    await load()
    setDeleting(false)
    if (fail === 0) toast.success(`已删除 ${ok} 个用户`)
    else toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  }

  // 批量启用/禁用
  const handleBatchToggle = async (active) => {
    if (selectedKeys.length === 0) return
    const _ok = await confirm({
      message: `确定${active ? '启用' : '禁用'}选中的 ${selectedKeys.length} 个用户吗？`,
      variant: 'warning',
      confirmText: active ? '启用' : '禁用',
    })
    if (!_ok) return
    setBatchLoading(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      const row = rows.find((r) => r.id === id)
      if (row && row.is_active !== active) {
        try { await usersApi.toggleActive(id); ok++ } catch { fail++ }
      } else {
        ok++
      }
    }
    clear()
    await load()
    setBatchLoading(false)
    toast.success(`${active ? '启用' : '禁用'}完成：${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ''}`)
  }

  // 批量重置密码
  const [batchResetOpen, setBatchResetOpen] = useState(false)
  const [batchResetPassword, setBatchResetPassword] = useState('')
  const [batchResetting, setBatchResetting] = useState(false)

  const handleBatchReset = async () => {
    if (!batchResetPassword || batchResetPassword.length < (pwdPolicy.min_length || 8)) {
      toast.warning(`新密码至少 ${pwdPolicy.min_length || 8} 位`)
      return
    }
    setBatchResetting(true)
    let ok = 0, fail = 0
    for (const id of selectedKeys) {
      try { await usersApi.resetPassword(id, batchResetPassword); ok++ } catch { fail++ }
    }
    setBatchResetOpen(false)
    setBatchResetPassword('')
    clear()
    setBatchResetting(false)
    toast.success(`重置完成：${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ''}`)
  }

  // ============ 批量导入 / 导出 ============
  const openImport = () => {
    setImportFile(null)
    setImportStrategy('skip')
    setImportResult(null)
    setImportOpen(true)
  }

  const handleDownloadTemplate = async () => {
    try {
      await usersApi.importTemplate()
    } catch (err) {
      toast.error(`模板下载失败：${err.message || err}`)
    }
  }

  const handleImport = async () => {
    if (!importFile) {
      toast.warning('请先选择要导入的文件')
      return
    }
    setImporting(true)
    setImportResult(null)
    try {
      const result = await usersApi.import(importFile, importStrategy)
      setImportResult(result)
      if ((result.inserted || 0) + (result.updated || 0) > 0) await load()
      toast.success(`导入完成：新增 ${result.inserted || 0} 个，更新 ${result.updated || 0} 个`)
    } catch (err) {
      toast.error(`导入失败：${err.message || err}`)
    } finally {
      setImporting(false)
    }
  }

  const handleExport = async () => {
    const hasSelected = selectedKeys.length > 0
    try {
      await usersApi.export(hasSelected ? selectedKeys : null)
      toast.success(hasSelected ? `已导出选中的 ${selectedKeys.length} 个用户` : `已导出全部 ${rows.length} 个用户`)
      if (hasSelected) clear()
    } catch (err) {
      toast.error(`导出失败：${err.message || err}`)
    }
  }

  const handleToggleActive = async (row) => {
    const _ok = await confirm({
      message: row.is_active
        ? `确定禁用用户「${row.display_name || row.username}」吗？禁用后该用户将无法登录。`
        : `确定启用用户「${row.display_name || row.username}」吗？`,
      variant: 'warning',
      confirmText: row.is_active ? '禁用' : '启用',
    })
    if (!_ok) return
    try {
      await usersApi.toggleActive(row.id)
      await load()
      toast.success(row.is_active ? '用户已禁用' : '用户已启用')
    } catch (err) {
      toast.error(`操作失败：${err.message || err}`)
    }
  }

  const openReset = (row) => {
    setResetTarget(row)
    setNewPassword('')
    setResetOpen(true)
  }

  const handleForceLogout = async (row) => {
    const _ok = await confirm({
      message: `确定强制下线用户「${row.display_name || row.username}」的所有会话吗？该用户的所有设备将立即登出。`,
      variant: 'warning',
      confirmText: '强制下线',
    })
    if (!_ok) return
    try {
      const res = await usersApi.forceLogout(row.id)
      const revoked = res?.revoked
      toast.success(
        revoked != null
          ? `已强制下线 ${row.username} 的 ${revoked} 个会话`
          : `已强制下线 ${row.username} 的所有会话`
      )
    } catch (err) {
      toast.error(`下线失败：${err.message || err}`)
    }
  }

  // 解除登录冻结：清除连续登录失败计数与锁定状态，用户可立即重新登录
  const handleUnlock = async (row) => {
    const _ok = await confirm({
      message: `确定解除用户「${row.display_name || row.username}」的登录冻结吗？解除后该用户可立即重新登录。`,
      variant: 'warning',
      confirmText: '解除冻结',
    })
    if (!_ok) return
    try {
      await usersApi.unlock(row.id)
      await load()
      toast.success(`已解除 ${row.username} 的登录冻结`)
    } catch (err) {
      toast.error(`解除冻结失败：${err.message || err}`)
    }
  }

  const handleViewLoginLogs = (row) => {
    // 跳转到日志中心，查看该用户的操作日志
    const url = `/logs?username=${encodeURIComponent(row.username)}`
    window.open(url, '_blank')
  }

  const handleReset = async () => {
    if (!newPassword || newPassword.length < (pwdPolicy.min_length || 8)) {
      toast.warning(`新密码至少 ${pwdPolicy.min_length || 8} 位`)
      return
    }
    setResetting(true)
    try {
      await usersApi.resetPassword(resetTarget.id, newPassword)
      setResetOpen(false)
      toast.success(`已重置 ${resetTarget.username} 的密码`)
    } catch (err) {
      toast.error(`重置失败：${err.message || err}`)
    } finally {
      setResetting(false)
    }
  }

  const handleResetFilters = () => {
    setSearch('')
    setRoleFilter('')
    setStatusFilter('')
    setLoginFilter('')
    setPage(1)
  }

  // 角色选项
  const roleOptions = roles.map((r) => ({
    value: String(r.id),
    label: `${r.name}${r.is_system ? '（系统）' : ''}`,
  }))
  const legacyRoleOptions = [
    { value: 'admin', label: '管理员' },
    { value: 'analyst', label: '分析师' },
    { value: 'viewer', label: '访客' },
  ]

  // 排序图标
  const SortIcon = ({ colKey }) => {
    if (sortKey !== colKey) return <ChevronUp className="h-3 w-3 opacity-30" />
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-primary" />
      : <ChevronDown className="h-3 w-3 text-primary" />
  }

  // 表格列定义
  const columns = [
    {
      key: 'id', header: 'ID', width: '56px', numeric: true,
      render: (r) => <span className="font-mono text-xs text-muted-foreground">#{r.id}</span>,
    },
    {
      key: 'username', header: (
        <button type="button" onClick={() => handleSort('username')} className="flex items-center gap-1 hover:text-foreground">
          用户 <SortIcon colKey="username" />
        </button>
      ),
      width: '22%',
      className: '!whitespace-normal',
      render: (r) => (
        <div className="min-w-0 py-0.5 leading-tight">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDetailUser(r) }}
            title={r.username}
            className="block max-w-full truncate text-left font-medium text-primary hover:underline"
          >
            {r.username}
          </button>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={r.display_name || ''}>
            {r.display_name && r.display_name !== r.username ? r.display_name : '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'email', header: '邮箱',
      render: (r) => r.email
        ? <span className="truncate text-muted-foreground" title={r.email}>{r.email}</span>
        : <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">未绑定</span>,
    },
    {
      key: 'role', header: '角色', width: '96px',
      render: (r) => {
        const roleLabel = ROLE_LABELS[r.role_name] || r.role_name || ROLE_LABELS[r.role] || r.role
        return (
          <span className="inline-block max-w-full" title={roleLabel}>
            <Badge variant="primary" className="max-w-full truncate">{roleLabel}</Badge>
          </span>
        )
      },
    },
    {
      key: 'is_active', header: '状态', width: '110px',
      render: (r) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge
            color={r.is_active ? 'success' : 'neutral'}
            label={r.is_active ? '启用' : '禁用'}
          />
          {/* 密码连续错误被冻结（锁定中），管理员可在「更多」中解除冻结 */}
          {r.is_locked && (
            <span title={r.locked_until ? `锁定至 ${fmtTime(r.locked_until)}` : '需人工解锁'}>
              <StatusBadge color="warning" label="已冻结" />
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'last_login_at', header: (
        <button type="button" onClick={() => handleSort('last_login_at')} className="flex items-center gap-1 hover:text-foreground">
          最后登录 <SortIcon colKey="last_login_at" />
        </button>
      ), width: '148px',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-muted-foreground" title={r.last_login_at || ''}>
          {fmtTime(r.last_login_at)}
        </span>
      ),
    },
    {
      key: '__actions', header: '操作', width: '128px',
      render: (r) => (
        <RowActions
          row={r}
          canEdit={canEdit}
          canDelete={canDelete}
          isSelf={currentUser && r.id === currentUser.id}
          handlers={{
            onView: setDetailUser,
            onEdit: openEdit,
            onReset: openReset,
            onToggleActive: handleToggleActive,
            onDelete: handleDelete,
            onForceLogout: handleForceLogout,
            onViewLoginLogs: handleViewLoginLogs,
            onUnlock: handleUnlock,
          }}
        />
      ),
    },
  ]

  // 批量操作
  const batchActions = []
  if (canEdit) {
    batchActions.push({ key: 'enable', label: '启用', icon: UserCheck, variant: 'secondary', onClick: () => handleBatchToggle(true), loading: batchLoading, disabled: deleting })
    batchActions.push({ key: 'disable', label: '禁用', icon: UserX, variant: 'secondary', onClick: () => handleBatchToggle(false), loading: batchLoading, disabled: deleting })
    batchActions.push({ key: 'reset', label: '重置密码', icon: KeyRound, variant: 'secondary', onClick: () => setBatchResetOpen(true), disabled: deleting })
  }
  if (canDelete) {
    batchActions.push({ key: 'delete', label: '批量删除', icon: Trash2, variant: 'danger', onClick: handleBatchDelete, loading: deleting })
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">用户管理</h1>
          <span className="text-xs text-muted-foreground tabular-nums">共 {filteredRows.length} 个用户</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm">刷新</button>
          {canView && (
            <button
              type="button"
              onClick={handleExport}
              className="btn-secondary btn-sm"
              title={selectedKeys.length ? `导出选中的 ${selectedKeys.length} 个用户` : '导出全部用户'}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {selectedKeys.length ? `导出选中(${selectedKeys.length})` : '导出'}
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={openImport} className="btn-secondary btn-sm">
              <Upload className="mr-1 h-3.5 w-3.5" />导入
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={openCreate} className="btn-primary btn-sm">+ 新建用户</button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 w-full rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* 筛选栏 */}
        <FilterBar
          search={{
            value: search,
            onChange: (v) => { setSearch(v); setPage(1) },
            placeholder: '搜索用户名 / 显示名 / 邮箱...',
          }}
          filters={[
            {
              key: 'role',
              label: '角色',
              value: roleFilter,
              onChange: (v) => { setRoleFilter(v); setPage(1) },
              options: [
                { value: '', label: '全部角色' },
                { value: 'admin', label: '管理员' },
                { value: 'analyst', label: '分析师' },
                { value: 'viewer', label: '访客' },
              ],
            },
            {
              key: 'status',
              label: '状态',
              value: statusFilter,
              onChange: (v) => { setStatusFilter(v); setPage(1) },
              options: [
                { value: '', label: '全部状态' },
                { value: 'active', label: '启用' },
                { value: 'inactive', label: '禁用' },
                { value: 'locked', label: '已冻结' },
              ],
            },
            {
              key: 'login',
              label: '最后登录',
              value: loginFilter,
              onChange: (v) => { setLoginFilter(v); setPage(1) },
              options: [
                { value: '', label: '全部时间' },
                { value: 'today', label: '今天' },
                { value: '7d', label: '7 天内' },
                { value: '30d', label: '30 天内' },
                { value: 'never', label: '从未登录' },
              ],
            },
          ]}
          actions={
            (search || roleFilter || statusFilter || loginFilter) ? (
              <button type="button" onClick={handleResetFilters} className="btn-secondary btn-sm">重置</button>
            ) : null
          }
        />

        {/* 表格 */}
        {filteredRows.length === 0 && !loading ? (
          <EmptyState
            icon={Users}
            title="暂无用户"
            description={search || roleFilter || statusFilter || loginFilter ? '没有匹配筛选条件的用户' : '点击「新建用户」添加第一个用户'}
            action={canEdit && !search && !roleFilter && !statusFilter && !loginFilter ? (
              <button type="button" onClick={openCreate} className="btn-primary btn-sm mt-3">+ 新建用户</button>
            ) : undefined}
            bordered
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <DataTable
              columns={columns}
              data={paged}
              loading={loading}
              selectable={canDelete}
              selectedKeys={selectedKeys}
              onSelectChange={setSelectedKeys}
              rowKey="id"
              onRowClick={(r) => (canEdit ? openEdit(r) : setDetailUser(r))}
              rowClickHint={canEdit ? '点击编辑' : '点击查看详情'}
              emptyText="暂无用户"
            />
          </div>
        )}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filteredRows.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
        {batchActions.length > 0 && (
          <BatchActions
            selectedCount={selectedKeys.length}
            onClear={clear}
            actions={batchActions}
          />
        )}
      </div>

      {/* 新建/编辑用户弹窗 */}
      <Modal
        open={editOpen}
        title={editing ? `编辑用户：${editing.username}` : '新建用户'}
        onClose={() => setEditOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <>
            <button type="button" onClick={() => setEditOpen(false)} className="btn-secondary">取消</button>
            <button type="button" onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <Section title="账号信息">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextInput
              label="用户名"
              value={form.username}
              onChange={setField('username')}
              placeholder="登录用户名"
              required
              hint={editing ? '用户名创建后不可修改' : undefined}
            />
            <TextInput
              label="显示名"
              value={form.display_name}
              onChange={setField('display_name')}
              placeholder="如：张三"
            />
          </div>
          {!editing && (
            <div>
              <PasswordField
                label="初始密码"
                value={form.password}
                onChange={setField('password')}
                placeholder={`至少 ${pwdPolicy.min_length || 8} 位`}
                required
                showStrength
                policy={pwdPolicy}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => setField('password')(generateRandomPassword(pwdPolicy))}
                    className="flex items-center gap-1 whitespace-nowrap text-[10px] text-primary hover:underline"
                    title="随机生成密码"
                  >
                    <RefreshCw className="h-3 w-3" />
                    随机
                  </button>
                }
              />
              <label className="mt-2 flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border bg-secondary text-primary focus:ring-primary"
                  checked={form.force_change_password}
                  onChange={(e) => setField('force_change_password')(e.target.checked)}
                />
                <span className="text-xs text-muted-foreground">首次登录强制修改密码</span>
              </label>
              {formErrors.password && <p className="mt-1 text-[11px] text-destructive">{formErrors.password}</p>}
            </div>
          )}
        </Section>

        <Section title="个人资料">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextInput
              label="邮箱"
              value={form.email}
              onChange={setField('email')}
              placeholder="请输入邮箱地址"
            />
          </div>
          {formErrors.email && <p className="mt-1 text-[11px] text-destructive">{formErrors.email}</p>}
        </Section>

        <Section title="角色与状态">
          {roleOptions.length > 0 ? (
            <SelectInput
              label="角色"
              value={form.role_id ? String(form.role_id) : ''}
              onChange={(v) => setField('role_id')(v ? Number(v) : null)}
              options={[{ value: '', label: '不关联（使用旧 role 字段）' }, ...roleOptions]}
            />
          ) : (
            <SelectInput
              label="角色"
              value={form.role}
              onChange={setField('role')}
              options={legacyRoleOptions}
            />
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground">启用账号</span>
            <Switch checked={form.is_active} onChange={setField('is_active')} />
          </div>
          {/* 允许的登录方式 */}
          <div>
            <div className="mb-2 text-sm text-foreground">允许的登录方式</div>
            <div className="flex flex-wrap gap-2">
              {[
                { value: 'password', label: '账号密码' },
                { value: 'otp', label: 'OTP 动态码' },
                { value: 'sso', label: 'SSO 单点登录' },
              ].map((m) => {
                const checked = form.allowed_login_methods?.includes(m.value)
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      const methods = form.allowed_login_methods || []
                      const newMethods = checked
                        ? methods.filter((x) => x !== m.value)
                        : [...methods, m.value]
                      setField('allowed_login_methods')(newMethods.length > 0 ? newMethods : ['password'])
                    }}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                      checked
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border bg-secondary text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {checked && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
                    {m.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              控制该用户可以使用哪些方式登录系统，至少保留一种
            </p>
          </div>
        </Section>
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        open={resetOpen}
        title={`重置密码：${resetTarget?.username || ''}`}
        onClose={() => setResetOpen(false)}
        maxWidth="max-w-md"
        footer={
          <>
            <button type="button" onClick={() => setResetOpen(false)} className="btn-secondary">取消</button>
            <button type="button" onClick={handleReset} disabled={resetting} className="btn-primary">
              {resetting ? '重置中…' : '确认重置'}
            </button>
          </>
        }
      >
        <PasswordField
          label="新密码"
          value={newPassword}
          onChange={setNewPassword}
          placeholder={`至少 ${pwdPolicy.min_length || 8} 位`}
          showStrength
          policy={pwdPolicy}
          rightSlot={
            <button
              type="button"
              onClick={() => setNewPassword(generateRandomPassword(pwdPolicy))}
              className="flex items-center gap-1 whitespace-nowrap text-[10px] text-primary hover:underline"
              title="随机生成密码"
            >
              <RefreshCw className="h-3 w-3" />
              随机
            </button>
          }
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          重置后请通知用户尽快登录并修改为自己的密码。若该账户因密码错误次数过多被冻结，重置后将一并解除冻结。
        </p>
      </Modal>

      {/* 批量重置密码弹窗 */}
      <Modal
        open={batchResetOpen}
        title={`批量重置密码（${selectedKeys.length} 个用户）`}
        onClose={() => setBatchResetOpen(false)}
        maxWidth="max-w-md"
        footer={
          <>
            <button type="button" onClick={() => setBatchResetOpen(false)} className="btn-secondary">取消</button>
            <button type="button" onClick={handleBatchReset} disabled={batchResetting} className="btn-primary">
              {batchResetting ? '重置中…' : '确认重置'}
            </button>
          </>
        }
      >
        <PasswordField
          label="统一新密码"
          value={batchResetPassword}
          onChange={setBatchResetPassword}
          placeholder={`至少 ${pwdPolicy.min_length || 8} 位`}
          showStrength
          policy={pwdPolicy}
          rightSlot={
            <button
              type="button"
              onClick={() => setBatchResetPassword(generateRandomPassword(pwdPolicy))}
              className="flex items-center gap-1 whitespace-nowrap text-[10px] text-primary hover:underline"
              title="随机生成密码"
            >
              <RefreshCw className="h-3 w-3" />
              随机
            </button>
          }
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          所有选中用户将使用相同的新密码，重置后请通知用户尽快修改。被冻结的账户将一并解除冻结。
        </p>
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal
        open={importOpen}
        title="批量导入用户"
        onClose={() => setImportOpen(false)}
        maxWidth="max-w-lg"
        footer={
          <>
            <button type="button" onClick={() => setImportOpen(false)} className="btn-secondary">关闭</button>
            <button type="button" onClick={handleImport} disabled={importing || !importFile} className="btn-primary">
              {importing ? '导入中…' : '开始导入'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border bg-secondary/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">首次使用请下载标准模板，按模板列填写</span>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="flex items-center gap-1 whitespace-nowrap text-xs text-primary hover:underline"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />下载模板
            </button>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">选择文件（.xlsx / .csv）</label>
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportResult(null) }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-primary/15 file:px-2 file:py-1 file:text-primary"
            />
            {importFile && (
              <p className="mt-1 text-[11px] text-muted-foreground">已选择：{importFile.name}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">已存在用户处理</label>
            <div className="flex gap-2">
              {[
                { value: 'skip', label: '跳过（保留原数据）' },
                { value: 'overwrite', label: '覆盖（按非空列更新）' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setImportStrategy(opt.value)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                    importStrategy === opt.value
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {importResult && (
            <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>共 {importResult.total} 条</span>
                <span className="text-emerald-600 dark:text-emerald-400">新增 {importResult.inserted || 0}</span>
                <span className="text-blue-600 dark:text-blue-400">更新 {importResult.updated || 0}</span>
                <span className="text-amber-600 dark:text-amber-400">跳过 {importResult.skipped || 0}</span>
                <span className={importResult.errors?.length ? 'text-destructive' : 'text-muted-foreground'}>
                  失败 {importResult.errors?.length || 0}
                </span>
              </div>
              {importResult.errors?.length > 0 && (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[11px] text-destructive">
                  {importResult.errors.map((e, i) => (
                    <li key={i}>
                      第 {e.row} 行{e.username ? `（${e.username}）` : ''}：{e.msg}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            新建用户的初始密码需满足密码复杂度策略，且首次登录需修改密码；覆盖导入时填写初始密码会重置密码并一并解除冻结；导出文件不含密码，可编辑后直接导入。
          </p>
        </div>
      </Modal>

      {/* 用户详情抽屉 */}
      <UserDetailDrawer
        open={!!detailUser}
        user={detailUser}
        onClose={() => setDetailUser(null)}
        onEdit={openEdit}
        onUnlock={canEdit ? handleUnlock : undefined}
      />
    </div>
  )
}

export default UserManagement
