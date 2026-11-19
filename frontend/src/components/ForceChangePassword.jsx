import { useState } from 'react'
import { ShieldAlert, Loader2, Eye, EyeOff, CheckCircle2, X } from 'lucide-react'
import { authApi } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'

/**
 * 强制改密模态框：用户 must_change_password=true 时显示，
 * 修改成功后才可正常使用系统。不可关闭/跳过。
 */
export default function ForceChangePassword({ onSuccess }) {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const setAuth = useAuthStore((s) => s.setAuth)
  const logout = useAuthStore((s) => s.logout)

  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 密码规则（与后端 validate_password_complexity 一致）
  const rules = [
    { label: '长度 8-128 字符', ok: newPwd.length >= 8 && newPwd.length <= 128 },
    { label: '包含大写字母', ok: /[A-Z]/.test(newPwd) },
    { label: '包含小写字母', ok: /[a-z]/.test(newPwd) },
    { label: '包含数字', ok: /[0-9]/.test(newPwd) },
  ]
  const allRulesOk = rules.every((r) => r.ok)
  const canSubmit = oldPwd && newPwd && confirmPwd === newPwd && allRulesOk && !loading

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setLoading(true)
    try {
      await authApi.changePassword(oldPwd, newPwd)
      // 更新本地 user 对象，清除 must_change_password 标记
      if (user) {
        setAuth(token, { ...user, must_change_password: false })
      }
      toast.success('密码修改成功')
      onSuccess?.()
    } catch (err) {
      setError(err.message || '修改失败')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    logout()
    window.location.href = '/login'
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b border-border bg-amber-500/10 px-6 py-4">
          <ShieldAlert className="h-6 w-6 shrink-0 text-amber-400" />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">首次登录请修改密码</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              为了账号安全，请先修改初始密码后继续使用系统
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="退出登录"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* 当前密码 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              当前密码
            </label>
            <div className="relative">
              <input
                type={showOld ? 'text' : 'password'}
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none transition focus:border-primary"
                placeholder="请输入当前密码"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowOld(!showOld)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              >
                {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* 新密码 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              新密码
            </label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none transition focus:border-primary"
                placeholder="请输入新密码"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {/* 规则提示 */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {rules.map((r) => (
                <div
                  key={r.label}
                  className={`flex items-center gap-1 text-xs ${
                    r.ok ? 'text-success' : 'text-muted-foreground'
                  }`}
                >
                  <CheckCircle2 className={`h-3 w-3 ${r.ok ? 'opacity-100' : 'opacity-30'}`} />
                  {r.label}
                </div>
              ))}
            </div>
          </div>

          {/* 确认密码 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              确认新密码
            </label>
            <input
              type={showNew ? 'text' : 'password'}
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              autoComplete="new-password"
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:${
                confirmPwd && confirmPwd !== newPwd
                  ? 'border-destructive'
                  : 'border-primary'
              } border-border`}
              placeholder="请再次输入新密码"
            />
            {confirmPwd && confirmPwd !== newPwd && (
              <p className="mt-1 text-xs text-destructive">两次输入的密码不一致</p>
            )}
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? '提交中…' : '修改密码并继续'}
          </button>
        </form>
      </div>
    </div>
  )
}
