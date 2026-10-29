import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Monitor, MapPin, Clock, Trash2, RefreshCw, CheckCircle2, X,
  Camera, Eye, EyeOff, Mail, Phone, Building2, Globe, Clock as TimeZoneIcon,
  FileText, Shield, LogOut, AlertCircle, Check, Smartphone, Laptop, Apple,
} from 'lucide-react'
import { authApi } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { CompactSelect } from '../components/ui'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'

// ============ 工具函数 ============
function fmtLoginTime(isoStr) {
  if (!isoStr) return '-'
  try {
    return new Date(isoStr).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return isoStr
  }
}

function fmtTtl(seconds) {
  if (!seconds || seconds <= 0) return '已过期'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}

// 解析 UA → { browser, os, BrowserIcon, OsIcon }
function parseUA(ua) {
  if (!ua) return { browser: '未知浏览器', os: '未知系统', BrowserIcon: Monitor, OsIcon: Monitor }
  let browser = '浏览器'
  let BrowserIcon = Monitor
  if (ua.includes('Edg')) { browser = 'Edge'; BrowserIcon = Globe }
  else if (ua.includes('Chrome')) { browser = 'Chrome'; BrowserIcon = Globe }
  else if (ua.includes('Firefox')) { browser = 'Firefox'; BrowserIcon = Globe }
  else if (ua.includes('Safari')) { browser = 'Safari'; BrowserIcon = Globe }

  let os = '未知系统'
  let OsIcon = Monitor
  if (ua.includes('Windows')) { os = 'Windows'; OsIcon = Monitor }
  else if (ua.includes('Mac')) { os = 'macOS'; OsIcon = Apple }
  else if (ua.includes('Android')) { os = 'Android'; OsIcon = Smartphone }
  else if (ua.includes('iPhone') || ua.includes('iPad')) { os = 'iOS'; OsIcon = Smartphone }
  else if (ua.includes('Linux')) { os = 'Linux'; OsIcon = Laptop }

  return { browser, os, BrowserIcon, OsIcon }
}

// 密码强度计算（根据系统密码策略动态校验）
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

// ============ 输入框组件（带 Focus 状态 + 图标） ============
function ProfileInput({ label, value, onChange, placeholder, type = 'text', icon: Icon, suffix, disabled, onBlur }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-normal text-muted-foreground">{label}</label>
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full rounded-md border border-border bg-secondary py-2.5 text-sm text-foreground transition-all placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${Icon ? 'pl-9' : 'pl-3'} ${suffix ? 'pr-10' : 'pr-3'} disabled:opacity-50`}
        />
        {suffix && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">{suffix}</div>
        )}
      </div>
    </div>
  )
}

// ============ 密码输入框（带显隐切换） ============
function PasswordInput({ label, value, onChange, placeholder, onBlur, suffix }) {
  const [show, setShow] = useState(false)
  return (
    <ProfileInput
      label={label}
      type={show ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      placeholder={placeholder}
      icon={undefined}
      suffix={
        <div className="flex items-center gap-1">
          {suffix}
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="text-muted-foreground transition hover:text-foreground"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      }
    />
  )
}

// ============ 下拉选择框组件（带图标） ============
function ProfileSelect({ label, value, onChange, icon: Icon, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-normal text-muted-foreground">{label}</label>
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <CompactSelect
          value={value}
          onChange={(e) => onChange(e.target.value)}
          size="lg"
          block
          className={Icon ? 'pl-9' : ''}
        >
          {children}
        </CompactSelect>
      </div>
    </div>
  )
}

// 语言选项
const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
]

// 时区选项
const TIMEZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '(UTC+08:00) 北京、上海、香港' },
  { value: 'Asia/Tokyo', label: '(UTC+09:00) 东京、首尔' },
  { value: 'Asia/Singapore', label: '(UTC+08:00) 新加坡' },
  { value: 'Asia/Dubai', label: '(UTC+04:00) 迪拜' },
  { value: 'Europe/London', label: '(UTC+00:00) 伦敦' },
  { value: 'Europe/Paris', label: '(UTC+01:00) 巴黎、柏林' },
  { value: 'America/New_York', label: '(UTC-05:00) 纽约、华盛顿' },
  { value: 'America/Chicago', label: '(UTC-06:00) 芝加哥' },
  { value: 'America/Los_Angeles', label: '(UTC-08:00) 洛杉矶、旧金山' },
  { value: 'UTC', label: '(UTC+00:00) UTC 协调世界时' },
]

// ============ 个人资料卡（左侧） ============
function ProfileCard({ user, onAvatarClick, uploadingAvatar }) {
  const initial = (user?.username || '?')[0].toUpperCase()
  const avatar = user?.avatar
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      {/* 头像 */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={uploadingAvatar}
          className="group relative h-24 w-24 overflow-hidden rounded-full bg-gradient-to-br from-primary to-primary/70 transition hover:ring-2 hover:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {avatar ? (
            <img src={avatar} alt="头像" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-4xl font-bold text-primary-foreground">
              {initial}
            </div>
          )}
          {/* Hover 相机遮罩 */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            {uploadingAvatar ? (
              <RefreshCw className="h-6 w-6 animate-spin text-white" />
            ) : (
              <Camera className="h-6 w-6 text-white" />
            )}
          </div>
        </button>
        <div className="mt-3 text-lg font-semibold text-foreground">
          {user?.display_name || user?.username || '-'}
        </div>
        <div className="text-sm text-muted-foreground">@{user?.username || '-'}</div>
      </div>

      {/* 状态标签 */}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <span className="rounded-md bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
          {user?.role || '-'}
        </span>
        {user?.is_active ? (
          <span className="flex items-center gap-1 rounded-md bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            启用
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive">
            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
            禁用
          </span>
        )}
      </div>

      {/* 元信息 */}
      <div className="mt-6 space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">邮箱</span>
          <span className="flex items-center gap-1 text-foreground">
            {user?.email || '-'}
            {user?.email && <CheckCircle2 className="h-3 w-3 text-success" />}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">最近登录</span>
          <span className="text-foreground">{fmtLoginTime(user?.last_login_at)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">创建时间</span>
          <span className="text-foreground">{fmtLoginTime(user?.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

// ============ 个人资料 Tab ============
function ProfileTab({ user, onSaved }) {
  const [profile, setProfile] = useState({
    display_name: user?.display_name || '',
    email: user?.email || '',
    phone: user?.phone || '',
    department: user?.department || '',
    language: user?.language || 'zh-CN',
    timezone: user?.timezone || 'Asia/Shanghai',
    bio: user?.bio || '',
  })
  const [original, setOriginal] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState({ type: '', text: '' })
  const isDirty = JSON.stringify(profile) !== JSON.stringify(original)

  const handleCancel = () => {
    setProfile(original)
    setMsg({ type: '', text: '' })
  }

  const handleSave = async () => {
    setSaving(true)
    setMsg({ type: '', text: '' })
    try {
      const updated = await authApi.updateProfile({
        display_name: profile.display_name,
        email: profile.email,
        phone: profile.phone,
        department: profile.department,
        language: profile.language,
        timezone: profile.timezone,
        bio: profile.bio,
      })
      onSaved(updated)
      setOriginal(profile)
      setMsg({ type: 'ok', text: '个人资料已更新' })
    } catch (err) {
      setMsg({ type: 'err', text: `保存失败：${err.message || err}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ProfileInput
          label="显示名"
          value={profile.display_name}
          onChange={(v) => setProfile((p) => ({ ...p, display_name: v }))}
          placeholder="如：张三"
        />
        <ProfileInput
          label="邮箱"
          value={profile.email}
          onChange={(v) => setProfile((p) => ({ ...p, email: v }))}
          placeholder="请输入邮箱地址"
          icon={Mail}
          suffix={
            profile.email ? (
              <span className="flex items-center gap-0.5 text-[10px] text-success">
                <CheckCircle2 className="h-3 w-3" />
                已验证
              </span>
            ) : null
          }
        />
        <ProfileInput
          label="手机号"
          value={profile.phone}
          onChange={(v) => setProfile((p) => ({ ...p, phone: v }))}
          placeholder="13800138000"
          icon={Phone}
        />
        <ProfileInput
          label="所属部门"
          value={profile.department}
          onChange={(v) => setProfile((p) => ({ ...p, department: v }))}
          placeholder="安全运营部"
          icon={Building2}
        />
        <ProfileSelect
          label="默认语言"
          value={profile.language}
          onChange={(v) => setProfile((p) => ({ ...p, language: v }))}
          icon={Globe}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </ProfileSelect>
        <ProfileSelect
          label="默认时区"
          value={profile.timezone}
          onChange={(v) => setProfile((p) => ({ ...p, timezone: v }))}
          icon={TimeZoneIcon}
        >
          {TIMEZONE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </ProfileSelect>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-normal text-muted-foreground">个人简介</label>
        <textarea
          value={profile.bio}
          onChange={(e) => setProfile((p) => ({ ...p, bio: e.target.value }))}
          placeholder="一句话介绍自己（可选）"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-secondary px-3 py-2.5 text-sm text-foreground transition-all placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {msg.text && (
        <div className={`rounded-md px-3 py-2 text-xs ${msg.type === 'ok' ? 'border border-success/40 bg-success/10 text-success' : 'border border-destructive/40 bg-destructive/10 text-destructive'}`}>
          {msg.text}
        </div>
      )}

      {/* 按钮右对齐：取消 + 保存 */}
      <div className="flex justify-end gap-3">
        {isDirty && (
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md border border-border px-5 py-2 text-sm text-muted-foreground transition hover:bg-secondary"
          >
            取消
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="min-w-[120px] rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存资料'}
        </button>
      </div>
    </div>
  )
}

// ============ 修改密码 Tab ============
function SecurityTab() {
  const user = useAuthStore((s) => s.user)
  const setAuth = useAuthStore((s) => s.setAuth)
  const token = useAuthStore((s) => s.token)
  const [pwd, setPwd] = useState({ old_password: '', new_password: '', confirm_password: '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState({ type: '', text: '' })
  const [confirmMatch, setConfirmMatch] = useState(null) // null | 'match' | 'mismatch'

  // OTP 绑定/解绑状态
  const [otpOpen, setOtpOpen] = useState(false) // 绑定弹窗
  const [otpDisableOpen, setOtpDisableOpen] = useState(false) // 解绑弹窗
  const [otpSetup, setOtpSetup] = useState(null) // { secret, qr_code, otpauth_uri }
  const [otpCode, setOtpCode] = useState('')
  const [otpDisableCode, setOtpDisableCode] = useState('')
  const [otpLoading, setOtpLoading] = useState(false)

  // 密码策略（从系统设置动态加载）
  const [pwdPolicy, setPwdPolicy] = useState({ min_length: 8, require_uppercase: true, require_lowercase: true, require_digit: true, require_special: true })
  useEffect(() => {
    authApi.getPasswordPolicy().then(setPwdPolicy).catch(() => {})
  }, [])

  const strength = useMemo(() => calcPasswordStrength(pwd.new_password, pwdPolicy), [pwd.new_password, pwdPolicy])

  const handleConfirmBlur = () => {
    if (!pwd.confirm_password) {
      setConfirmMatch(null)
      return
    }
    setConfirmMatch(pwd.new_password === pwd.confirm_password ? 'match' : 'mismatch')
  }

  const handleChangePwd = async () => {
    if (!pwd.old_password || !pwd.new_password) {
      setMsg({ type: 'err', text: '请填写原密码与新密码' })
      return
    }
    // 前端预校验密码复杂度（与系统设置一致），后端也会校验
    const minLen = pwdPolicy.min_length || 8
    if (pwd.new_password.length < minLen) {
      setMsg({ type: 'err', text: `新密码至少 ${minLen} 位` })
      return
    }
    if (pwd.new_password !== pwd.confirm_password) {
      setMsg({ type: 'err', text: '两次输入的新密码不一致' })
      return
    }
    if (pwd.old_password === pwd.new_password) {
      setMsg({ type: 'err', text: '新密码不能与原密码相同' })
      return
    }
    setSaving(true)
    setMsg({ type: '', text: '' })
    try {
      await authApi.changePassword(pwd.old_password, pwd.new_password)
      setPwd({ old_password: '', new_password: '', confirm_password: '' })
      setConfirmMatch(null)
      setMsg({ type: 'ok', text: '密码修改成功' })
    } catch (err) {
      setMsg({ type: 'err', text: `修改失败：${err.message || err}` })
    } finally {
      setSaving(false)
    }
  }

  // ============ OTP 处理函数 ============

  // 绑定第一步：生成密钥 + 二维码
  const handleOtpSetup = async () => {
    setOtpLoading(true)
    try {
      const res = await authApi.otpSetup()
      setOtpSetup(res)
      setOtpCode('')
      setOtpOpen(true)
    } catch (err) {
      toast.error(`生成 OTP 密钥失败：${err.message || err}`)
    } finally {
      setOtpLoading(false)
    }
  }

  // 绑定第二步：验证动态码并启用
  const handleOtpEnable = async () => {
    if (otpCode.length !== 6) return
    setOtpLoading(true)
    try {
      await authApi.otpEnable(otpCode)
      // 更新本地用户状态
      setAuth(token, { ...user, otp_enabled: true })
      setOtpOpen(false)
      setOtpSetup(null)
      setOtpCode('')
      toast.success('OTP 二次验证已启用')
    } catch (err) {
      toast.error(`启用失败：${err.message || err}`)
    } finally {
      setOtpLoading(false)
    }
  }

  // 解绑：验证当前动态码后禁用
  const handleOtpDisable = async () => {
    if (otpDisableCode.length !== 6) return
    setOtpLoading(true)
    try {
      await authApi.otpDisable(otpDisableCode)
      // 更新本地用户状态
      setAuth(token, { ...user, otp_enabled: false, otp_secret: null })
      setOtpDisableOpen(false)
      setOtpDisableCode('')
      toast.success('OTP 二次验证已解绑')
    } catch (err) {
      toast.error(`解绑失败：${err.message || err}`)
    } finally {
      setOtpLoading(false)
    }
  }

  const strengthColors = ['bg-muted', 'bg-destructive', 'bg-warning', 'bg-primary', 'bg-success']
  const strengthWidths = ['0%', '25%', '50%', '75%', '100%']

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        {/* 原密码 */}
        <div>
          <PasswordInput
            label="原密码"
            value={pwd.old_password}
            onChange={(v) => setPwd((p) => ({ ...p, old_password: v }))}
            placeholder="当前密码"
            suffix={
              <a
                href="/forgot-password"
                className="whitespace-nowrap text-[10px] text-primary hover:underline"
              >
                忘记密码？
              </a>
            }
          />
        </div>

        {/* 新密码 */}
        <div>
          <PasswordInput
            label="新密码"
            value={pwd.new_password}
            onChange={(v) => setPwd((p) => ({ ...p, new_password: v }))}
            placeholder={`至少 ${pwdPolicy.min_length || 8} 位`}
          />
          {/* 密码强度条 */}
          {pwd.new_password && (
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
              {/* 密码要求清单 */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {strength.checks.map((c, i) => (
                  <span
                    key={i}
                    className={`flex items-center gap-1 text-[10px] ${c.pass ? 'text-success' : 'text-muted-foreground'}`}
                  >
                    {c.pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 确认密码 */}
        <div>
          <PasswordInput
            label="确认新密码"
            value={pwd.confirm_password}
            onChange={(v) => setPwd((p) => ({ ...p, confirm_password: v }))}
            onBlur={handleConfirmBlur}
            placeholder="再次输入新密码"
          />
          {confirmMatch === 'match' && (
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-success">
              <Check className="h-3 w-3" /> 密码一致
            </div>
          )}
          {confirmMatch === 'mismatch' && (
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-destructive">
              <AlertCircle className="h-3 w-3" /> 两次输入的密码不一致
            </div>
          )}
        </div>
      </div>

      {msg.text && (
        <div className={`rounded-md px-3 py-2 text-xs ${msg.type === 'ok' ? 'border border-success/40 bg-success/10 text-success' : 'border border-destructive/40 bg-destructive/10 text-destructive'}`}>
          {msg.text}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleChangePwd}
          disabled={saving}
          className="min-w-[120px] rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '修改中…' : '修改密码'}
        </button>
      </div>

      {/* ============ OTP 二次验证 ============ */}
      <div className="border-t border-border pt-5">
        <div className="mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">OTP 二次验证</h3>
          {user?.otp_enabled ? (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">已启用</span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">未启用</span>
          )}
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">
          启用后，每次登录密码验证通过后需输入 Authenticator 应用中的 6 位动态码，防止密码泄露导致账号被盗。
        </p>
        {user?.otp_enabled ? (
          /* 已启用：显示解绑按钮 */
          <button
            type="button"
            onClick={() => { setOtpDisableOpen(true); setOtpDisableCode('') }}
            className="rounded-md border border-destructive/40 px-4 py-2 text-xs font-medium text-destructive transition hover:bg-destructive/10"
          >
            解绑 OTP 二次验证
          </button>
        ) : (
          /* 未启用：显示绑定按钮 */
          <button
            type="button"
            onClick={handleOtpSetup}
            disabled={otpLoading}
            className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {otpLoading ? '生成中…' : '绑定 OTP 二次验证'}
          </button>
        )}
      </div>

      {/* ============ OTP 绑定弹窗 ============ */}
      {otpOpen && otpSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !otpLoading && setOtpOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">绑定 OTP 二次验证</h3>
              <button onClick={() => !otpLoading && setOtpOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              {/* 步骤 1：扫码 */}
              <div className="text-center">
                <p className="mb-3 text-xs text-muted-foreground">
                  步骤 1：使用 Google Authenticator / Microsoft Authenticator 扫描下方二维码
                </p>
                <div className="inline-block rounded-lg border border-border bg-white p-3">
                  <img src={otpSetup.qr_code} alt="OTP 二维码" className="h-40 w-40" />
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  无法扫码？手动输入密钥：
                  <code className="ml-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-primary">{otpSetup.secret}</code>
                </p>
              </div>
              {/* 步骤 2：输入验证码 */}
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-xs text-muted-foreground">步骤 2：从 Authenticator 获取 6 位动态码，输入验证</p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full rounded-lg border border-border bg-muted py-2.5 text-center text-xl font-bold tracking-[0.4em] text-foreground outline-none focus:border-primary/80 focus:ring-2 focus:ring-primary/30"
                />
              </div>
              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setOtpOpen(false); setOtpCode('') }}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleOtpEnable}
                  disabled={otpLoading || otpCode.length !== 6}
                  className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {otpLoading ? '验证中…' : '确认启用'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ OTP 解绑弹窗 ============ */}
      {otpDisableOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !otpLoading && setOtpDisableOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">解绑 OTP 二次验证</h3>
              <button onClick={() => !otpLoading && setOtpDisableOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-5">
              <p className="text-xs text-muted-foreground">
                解绑后登录将不再需要动态验证码。为安全起见，请输入当前 Authenticator 中的 6 位动态码确认。
              </p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otpDisableCode}
                onChange={(e) => setOtpDisableCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                autoFocus
                className="w-full rounded-lg border border-border bg-muted py-2.5 text-center text-xl font-bold tracking-[0.4em] text-foreground outline-none focus:border-primary/80 focus:ring-2 focus:ring-primary/30"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setOtpDisableOpen(false); setOtpDisableCode('') }}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleOtpDisable}
                  disabled={otpLoading || otpDisableCode.length !== 6}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 disabled:opacity-50"
                >
                  {otpLoading ? '解绑中…' : '确认解绑'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 登录设备 Tab ============
function DevicesTab({ sessions, loading, currentSid, onRevoke, onRevokeAll, onRefresh, revokingId, revokingAll }) {
  const otherCount = sessions.filter((s) => s.sid !== currentSid).length
  return (
    <div className="space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">共 {sessions.length} 台设备</span>
          {otherCount > 0 && (
            <span className="text-xs text-muted-foreground">· 其他设备 {otherCount} 台</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {otherCount > 0 && (
            <button
              type="button"
              onClick={onRevokeAll}
              disabled={revokingAll || loading}
              className="flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              {revokingAll ? '下线中…' : '下线其他设备'}
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* 设备列表 */}
      {sessions.length === 0 && !loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          暂无活跃会话记录
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => {
            const isCurrent = s.sid === currentSid
            const ua = s.device?.user_agent || ''
            const { browser, os, BrowserIcon, OsIcon } = parseUA(ua)
            return (
              <div
                key={s.sid}
                className={`relative flex items-center gap-3 overflow-hidden rounded-lg border p-4 ${
                  isCurrent
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border bg-secondary'
                }`}
              >
                {/* 当前设备左侧青色竖线 */}
                {isCurrent && <div className="absolute left-0 top-0 h-full w-1 bg-primary" />}
                {/* 设备图标 */}
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${isCurrent ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  <OsIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {browser} · {os}
                    </span>
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
                        <CheckCircle2 className="h-3 w-3" /> 当前设备 · 本机
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                        <BrowserIcon className="h-3 w-3" /> {browser}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {s.ip || 'unknown'}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {fmtLoginTime(s.login_at)}
                    </span>
                    <span>剩余 {fmtTtl(s.ttl_seconds)}</span>
                  </div>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    onClick={() => onRevoke(s.sid)}
                    disabled={revokingId === s.sid}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {revokingId === s.sid ? '下线中…' : '下线'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============ 头像上传弹窗 ============
function AvatarUploadModal({ open, onClose, onUpload, uploading }) {
  const [preview, setPreview] = useState('')
  if (!open) return null
  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // 限制 2MB（与后端一致）
    if (file.size > 2 * 1024 * 1024) {
      toast.error('图片大小不能超过 2MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setPreview(reader.result)
    reader.readAsDataURL(file)
  }
  const handleClose = () => {
    if (uploading) return
    setPreview('')
    onClose()
  }
  const handleConfirm = () => {
    if (!preview || uploading) return
    onUpload(preview)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6">
        <div className="mb-4 text-lg font-semibold">更换头像</div>
        <div className="flex flex-col items-center gap-4">
          <div className="h-24 w-24 overflow-hidden rounded-full bg-secondary">
            {preview ? (
              <img src={preview} alt="预览" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Camera className="h-8 w-8" />
              </div>
            )}
          </div>
          <label className={`cursor-pointer rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition hover:text-foreground ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
            选择图片
            <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
          </label>
          <p className="text-[11px] text-muted-foreground">支持 JPG / PNG / GIF，大小不超过 2MB</p>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={uploading}
            className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!preview || uploading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {uploading ? '上传中…' : '确认上传'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ 主页面 ============
function Profile() {
  const user = useAuthStore((s) => s.user)
  const setAuth = useAuthStore((s) => s.setAuth)
  const [activeTab, setActiveTab] = useState('profile')
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)

  // 登录设备
  const [sessions, setSessions] = useState([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [revokingId, setRevokingId] = useState(null)
  const [revokingAll, setRevokingAll] = useState(false)

  const [dirty, setDirty] = useState(false)
  const bypassGuard = useUnsavedChanges(dirty)

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const list = await authApi.listSessions()
      setSessions(Array.isArray(list) ? list : [])
    } catch {
      setSessions([])
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const currentSid = (() => {
    try {
      const token = useAuthStore.getState().token
      if (!token) return ''
      const parts = token.split('.')
      if (parts.length !== 3) return ''
      const payload = JSON.parse(atob(parts[1]))
      return payload.sid || ''
    } catch {
      return ''
    }
  })()

  const handleRevokeSession = async (sid) => {
    const _ok = await confirm({ message: '确定要下线该设备吗？该设备上的会话将立即失效。', variant: 'danger', confirmText: '下线' })
    if (!_ok) return
    setRevokingId(sid)
    try {
      await authApi.revokeSession(sid)
      setSessions((prev) => prev.filter((s) => s.sid !== sid))
      toast.success('设备已下线')
    } catch (err) {
      toast.error(`下线失败：${err.message || err}`)
    } finally {
      setRevokingId(null)
    }
  }

  const handleRevokeAll = async () => {
    const _ok = await confirm({ message: '确定要下线除当前设备外的所有登录吗？', variant: 'danger', confirmText: '全部下线' })
    if (!_ok) return
    setRevokingAll(true)
    try {
      const others = sessions.filter((s) => s.sid !== currentSid)
      await Promise.all(others.map((s) => authApi.revokeSession(s.sid)))
      setSessions((prev) => prev.filter((s) => s.sid === currentSid))
      toast.success(`已下线 ${others.length} 台设备`)
    } catch (err) {
      toast.error(`下线失败：${err.message || err}`)
    } finally {
      setRevokingAll(false)
    }
  }

  const handleProfileSaved = (updated) => {
    setAuth(useAuthStore.getState().token, updated)
    setDirty(false)
    bypassGuard()
  }

  const handleAvatarUpload = async (dataUrl) => {
    if (!dataUrl) return
    setUploadingAvatar(true)
    try {
      const updated = await authApi.updateProfile({ avatar: dataUrl })
      setAuth(useAuthStore.getState().token, updated)
      setAvatarOpen(false)
      toast.success('头像已更新')
    } catch (err) {
      toast.error(`头像上传失败：${err.message || err}`)
    } finally {
      setUploadingAvatar(false)
    }
  }

  const tabs = [
    { key: 'profile', label: '基本信息', icon: FileText },
    { key: 'security', label: '账号安全', icon: Shield },
    { key: 'devices', label: '登录设备', icon: Monitor },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 页面标题 */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">个人中心</h1>
        </div>
      </header>

      {/* 左右分栏布局 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 左侧 1/3：个人资料卡 */}
          <div className="lg:col-span-1">
            <ProfileCard
              user={user}
              onAvatarClick={() => setAvatarOpen(true)}
              uploadingAvatar={uploadingAvatar}
            />
          </div>

          {/* 右侧 2/3：Tab 切换表单 */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-border bg-card p-6">
              {/* Tab 切换 */}
              <div className="mb-6 flex items-center gap-1 border-b border-border pb-3">
                {tabs.map((t) => {
                  const Icon = t.icon
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setActiveTab(t.key)}
                      className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                        activeTab === t.key
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {t.label}
                    </button>
                  )
                })}
              </div>

              {/* Tab 内容 */}
              {activeTab === 'profile' && <ProfileTab user={user} onSaved={handleProfileSaved} />}
              {activeTab === 'security' && <SecurityTab />}
              {activeTab === 'devices' && (
                <DevicesTab
                  sessions={sessions}
                  loading={loadingSessions}
                  currentSid={currentSid}
                  onRevoke={handleRevokeSession}
                  onRevokeAll={handleRevokeAll}
                  onRefresh={loadSessions}
                  revokingId={revokingId}
                  revokingAll={revokingAll}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 头像上传弹窗 */}
      <AvatarUploadModal
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        onUpload={handleAvatarUpload}
        uploading={uploadingAvatar}
      />
    </div>
  )
}

export default Profile
