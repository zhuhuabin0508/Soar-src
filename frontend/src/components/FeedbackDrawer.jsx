import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, MessageSquareWarning, UploadCloud, Paperclip } from 'lucide-react'
import { feedbackApi } from '../api/client'
import { toast } from '../store/toastStore'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'
import {
  FEEDBACK_PRIORITIES,
  ATTACH_EXT_WHITELIST,
  fileExt,
  fmtSize,
} from '../utils/feedback'
import {CompactSelect, AutoGrowTextarea } from './ui'

// 提交反馈抽屉：右侧滑入，宽 560px（小屏撑满）
// 供 AppShell（悬浮按钮 / 用户菜单）与 MyFeedback 页复用
//
// Props:
//   - open: boolean          是否打开
//   - onClose: () => void    关闭回调
//   - onSubmitted: (fb) => void  提交成功回调（可选，用于列表页刷新）

// 反馈类型分段选项
const TYPE_OPTIONS = [
  { value: 'bug', label: 'BUG' },
  { value: 'suggestion', label: '优化建议' },
  { value: 'other', label: '其他' },
]

// 表单初始值
function emptyForm() {
  return {
    type: 'bug',
    title: '',
    module: '',
    priority: 'medium',
    description: '',
    reproduce_steps: '',
    expected_result: '',
    actual_result: '',
    contact: '',
    allow_visit: true,
  }
}

// 获取当前页面标识（如「SOAR 平台 (/workflows)」），用于模块字段默认值
function currentPageLabel() {
  const title = (document.title || '').trim() || '当前页面'
  const path = window.location.pathname || '/'
  return `${title} (${path})`
}

// 开关组件（样式与 UserManagement 一致）
function Switch({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// 字段错误提示
function FieldError({ msg }) {
  if (!msg) return null
  return <p className="mt-1 text-xs text-red-500">{msg}</p>
}

// 字段填写规范提示（弱化灰色，告知用户约束）
function FieldHint({ children }) {
  return <p className="mt-1 text-[11px] text-muted-foreground">{children}</p>
}

function FeedbackDrawer({ open, onClose, onSubmitted }) {
  const [form, setForm] = useState(emptyForm)
  const [files, setFiles] = useState([])
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef(null)

  // 打开时重置表单并自动填充当前页面信息
  useEffect(() => {
    if (open) {
      setForm({ ...emptyForm(), module: currentPageLabel() })
      setFiles([])
      setErrors({})
    }
  }, [open])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useLockBackgroundScroll(open)

  if (!open) return null

  const setField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }))
    // 输入后清除该字段错误
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  // 选择附件：白名单校验，多文件追加
  const handleSelectFiles = (fileList) => {
    const picked = Array.from(fileList || [])
    const ok = []
    for (const f of picked) {
      if (!ATTACH_EXT_WHITELIST.includes(fileExt(f.name))) {
        toast.error(`不支持的附件格式：${f.name}（仅允许 ${ATTACH_EXT_WHITELIST.join('/')}）`)
        continue
      }
      ok.push(f)
    }
    if (ok.length) setFiles((prev) => [...prev, ...ok])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  // 前端校验：必填 + 最大长度（与后端 Pydantic 一致：1-N 字，非空即可）
  const validate = () => {
    const e = {}
    const t = form.title.trim()
    if (!t) e.title = '请输入标题'
    else if (t.length > 200) e.title = '标题不能超过 200 字'
    const d = form.description.trim()
    if (!d) e.description = '请输入详细描述'
    else if (d.length > 5000) e.description = '详细描述不能超过 5000 字'
    if (form.type === 'bug') {
      if (!form.reproduce_steps.trim()) e.reproduce_steps = 'BUG 反馈需填写复现步骤'
      else if (form.reproduce_steps.trim().length > 5000) e.reproduce_steps = '复现步骤不能超过 5000 字'
      if (!form.expected_result.trim()) e.expected_result = 'BUG 反馈需填写期望结果'
      else if (form.expected_result.trim().length > 5000) e.expected_result = '期望结果不能超过 5000 字'
      if (!form.actual_result.trim()) e.actual_result = 'BUG 反馈需填写实际结果'
      else if (form.actual_result.trim().length > 5000) e.actual_result = '实际结果不能超过 5000 字'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  // 提交：创建反馈 → 逐个上传附件 → 成功提示并关闭
  const handleSubmit = async () => {
    if (submitting) return
    if (!validate()) {
      toast.warning('请检查表单填写')
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        type: form.type,
        title: form.title.trim(),
        module: form.module.trim(),
        priority: form.priority,
        description: form.description,
        // BUG 类型才提交三要素
        reproduce_steps: form.type === 'bug' ? form.reproduce_steps : '',
        expected_result: form.type === 'bug' ? form.expected_result : '',
        actual_result: form.type === 'bug' ? form.actual_result : '',
        contact: form.contact.trim(),
        allow_visit: form.allow_visit,
        // 记录提交时所在页面
        page_title: (document.title || '').trim(),
        page_url: window.location.href,
      }
      const created = await feedbackApi.create(payload)
      // 逐个上传附件（失败仅提示，不回滚反馈本体）
      let attachFail = 0
      for (const f of files) {
        try {
          await feedbackApi.uploadAttachment(created?.id, f)
        } catch {
          attachFail += 1
        }
      }
      if (attachFail > 0) {
        toast.warning(`反馈已提交，但 ${attachFail} 个附件上传失败`)
      } else {
        toast.success('反馈提交成功，我们会尽快处理')
      }
      if (onSubmitted) onSubmitted(created)
      onClose()
    } catch (err) {
      toast.error(err.message || '提交失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  // 输入框通用样式：校验失败红边
  const inputCls = (field) =>
    `w-full rounded-md border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground transition focus:outline-none focus:ring-1 ${
      errors[field]
        ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
        : 'border-border focus:border-primary focus:ring-primary'
    }`

  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end">
      <style>{`
        @keyframes feedbackSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
      {/* 遮罩层 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* 抽屉主体：小屏撑满，≥sm 限 560px */}
      <div className="relative flex h-full w-full flex-col border-l border-border bg-card shadow-2xl animate-[feedbackSlideIn_0.2s_ease-out] sm:max-w-[560px]">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <MessageSquareWarning className="h-4 w-4 text-primary" />
            提交反馈
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 表单滚动区 */}
        <div data-allow-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {/* 填写须知：进入抽屉即前置告知用户填写规范 */}
          <div className="mb-5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-primary">填写须知：</span>
            标题与详细描述请填写 <span className="font-medium text-foreground">1 - 5000 字</span>
            ；若类型为 <span className="text-red-400">BUG</span>，复现步骤 / 期望结果 / 实际结果均为必填；附件仅支持图片、PDF、TXT、日志、CSV、ZIP，单文件不超过 10MB。
          </div>

          {/* 反馈类型分段控件 */}
          <div className="mb-5">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              反馈类型 <span className="text-destructive">*</span>
            </label>
            <div className="flex rounded-md border border-border bg-muted p-1">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setField('type', opt.value)}
                  className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                    form.type === opt.value
                      ? 'bg-primary font-medium text-white'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 标题 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              标题 <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              maxLength={200}
              onChange={(e) => setField('title', e.target.value)}
              placeholder="一句话概括问题或建议"
              className={inputCls('title')}
            />
            <FieldHint>填写规范：1 - 200 字，简要概括问题或建议</FieldHint>
            <FieldError msg={errors.title} />
          </div>

          {/* 所属模块/页面：默认自动填充 document.title + 路径 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              所属模块 / 页面
            </label>
            <input
              type="text"
              value={form.module}
              maxLength={200}
              onChange={(e) => setField('module', e.target.value)}
              placeholder="如：智能工作平台 · 工作流列表"
              className={inputCls('module')}
            />
          </div>

          {/* 严重程度 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              严重程度
            </label>
            <CompactSelect
              size="lg"
              block
              value={form.priority}
              onChange={(e) => setField('priority', e.target.value)}
            >
              {FEEDBACK_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </CompactSelect>
          </div>

          {/* 详细描述 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              详细描述 <span className="text-destructive">*</span>
            </label>
            <AutoGrowTextarea
              rows={4}
              value={form.description}
              maxLength={5000}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="请描述你遇到的问题或建议"
              className={`${inputCls('description')} resize-y`}
            />
            <FieldHint>填写规范：1 - 5000 字，描述问题的现象、影响与期望</FieldHint>
            <FieldError msg={errors.description} />
          </div>

          {/* BUG 类型专属字段 */}
          {form.type === 'bug' && (
            <>
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  复现步骤 <span className="text-destructive">*</span>
                </label>
                <AutoGrowTextarea
                  rows={3}
                  value={form.reproduce_steps}
                  onChange={(e) => setField('reproduce_steps', e.target.value)}
                  placeholder="1. 打开…&#10;2. 点击…&#10;3. 出现…"
                  className={`${inputCls('reproduce_steps')} resize-y`}
                />
                <FieldHint>填写规范：1 - 5000 字，按 1、2、3 编号列出可复现的操作步骤</FieldHint>
                <FieldError msg={errors.reproduce_steps} />
              </div>
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  期望结果 <span className="text-destructive">*</span>
                </label>
                <AutoGrowTextarea
                  rows={2}
                  value={form.expected_result}
                  onChange={(e) => setField('expected_result', e.target.value)}
                  placeholder="正常情况下应该…"
                  className={`${inputCls('expected_result')} resize-y`}
                />
                <FieldHint>填写规范：1 - 5000 字，描述正常情况下应该出现的结果</FieldHint>
                <FieldError msg={errors.expected_result} />
              </div>
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  实际结果 <span className="text-destructive">*</span>
                </label>
                <AutoGrowTextarea
                  rows={2}
                  value={form.actual_result}
                  onChange={(e) => setField('actual_result', e.target.value)}
                  placeholder="实际发生了…"
                  className={`${inputCls('actual_result')} resize-y`}
                />
                <FieldHint>填写规范：1 - 5000 字，描述实际观察到的现象或报错</FieldHint>
                <FieldError msg={errors.actual_result} />
              </div>
            </>
          )}

          {/* 附件上传区 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              附件（截图 / 日志，可选）
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-5 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <UploadCloud className="h-5 w-5" />
              <span className="text-xs">
                点击选择文件，支持 {ATTACH_EXT_WHITELIST.join(' / ')}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_EXT_WHITELIST.map((e) => '.' + e).join(',')}
              onChange={(e) => handleSelectFiles(e.target.files)}
              className="hidden"
            />
            {/* 已选文件列表 */}
            {files.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {files.map((f, idx) => (
                  <li
                    key={`${f.name}-${idx}`}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs"
                  >
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground" title={f.name}>
                      {f.name}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {fmtSize(f.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                      aria-label={`移除附件 ${f.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 联系方式 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              联系方式（可选）
            </label>
            <input
              type="text"
              value={form.contact}
              maxLength={100}
              onChange={(e) => setField('contact', e.target.value)}
              placeholder="邮箱 / 电话 / IM 账号，便于我们联系你"
              className={inputCls('contact')}
            />
          </div>

          {/* 允许回访开关 */}
          <div className="flex items-center justify-between rounded-md border border-border bg-muted px-3 py-2.5">
            <div>
              <div className="text-sm text-foreground">允许管理员回访</div>
              <div className="text-xs text-muted-foreground">
                开启后管理员可就本反馈与你联系
              </div>
            </div>
            <Switch
              checked={form.allow_visit}
              onChange={(v) => setField('allow_visit', v)}
            />
          </div>
        </div>

        {/* 底部固定操作栏 */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {submitting ? '提交中…' : '提交反馈'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default FeedbackDrawer
