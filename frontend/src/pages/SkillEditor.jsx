/**
 * SkillEditor —— 技能编辑抽屉
 *
 * 从右侧滑出的抽屉，适合编辑长提示词：
 * - 左侧：编辑区（行号 + {{变量}} 高亮 + 字数/Token 估算 + 全屏 + 拖拽调高/记忆高度）
 * - 右侧：实时预览（渲染 {{变量}} + 分段结构）
 * - 顶部工具栏：AI 优化 / 检测问题 / 测试运行
 * - 分类支持自定义输入；标签支持多标签 chip 编辑
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Wand2, ShieldCheck, Play, Maximize2, Minimize2, AlertTriangle, CheckCircle2,
  X, Lightbulb, Eye, GripHorizontal,
} from 'lucide-react'
import { Drawer } from '../components/Dialog'
import { inputCls, textareaCls, labelCls, hintCls } from '../components/property/FormControls'
import { CompactSelect } from '../components/ui'
import { skills as skillsApi, agents as agentsApi } from '../api/client'
import { toast } from '../store/toastStore'
import { HoverTip } from '../components/InfoTip'
import { canEditResource } from '../utils/permissions'

const CATEGORIES = ['处置流程', '角色设定', '领域规则', 'SOP', '其他']
const CATEGORY_STYLES = {
  处置流程: 'border-primary/40 bg-primary/10 text-primary',
  角色设定: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  领域规则: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  SOP: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  其他: 'border-border bg-secondary text-muted-foreground',
}

const EMPTY_FORM = {
  id: null,
  name: '',
  description: '',
  content: '',
  category: '处置流程',
  tags: [],
  enabled: true,
  priority: 0,
}

// 粗略 Token 估算：中文字符按 1.5 token，英文按 1 token / 4 字符
function estimateTokens(text) {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens += 1.5
    else tokens += 0.25
  }
  return Math.ceil(tokens)
}

// 提取 {{变量}} 列表
function extractVars(text) {
  if (!text) return []
  const set = new Set()
  const re = /\{\{\s*(\w+)\s*\}\}/g
  let m
  while ((m = re.exec(text)) !== null) set.add(m[1])
  return Array.from(set)
}

// 把正文渲染为带高亮的预览片段（用于行内展示）
function renderHighlighted(text) {
  if (!text) return null
  const parts = []
  const re = /(\{\{\s*\w+\s*\}\})/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={i++}>{text.slice(last, m.index)}</span>)
    parts.push(
      <code key={i++} className="rounded bg-primary/20 px-1 text-primary">{m[0]}</code>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(<span key={i++}>{text.slice(last)}</span>)
  return parts
}

export default function SkillEditor({ open, initial, onClose, onSubmit, saving }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [tagInput, setTagInput] = useState('')
  const [customCat, setCustomCat] = useState('')
  const [err, setErr] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [agentList, setAgentList] = useState([])
  const [testAgentId, setTestAgentId] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const textareaRef = useRef(null)
  const gutterRef = useRef(null)
  // 编辑区高度：可拖拽调整并持久化（默认 480px，240-900px）
  const [editorH, setEditorH] = useState(() => {
    const saved = Number(localStorage.getItem('skill_editor_h'))
    return Number.isFinite(saved) && saved >= 240 && saved <= 900 ? saved : 480
  })

  // 拖拽调高：松手时把最终高度写入 localStorage，下次打开记住
  const startResize = (e) => {
    if (fullscreen) return // 全屏走视口高度，不响应拖拽
    e.preventDefault()
    const startY = e.clientY
    const startH = editorH
    let finalH = startH
    const onMove = (ev) => {
      finalH = Math.min(900, Math.max(240, startH + (ev.clientY - startY)))
      setEditorH(finalH)
    }
    const onUp = () => {
      localStorage.setItem('skill_editor_h', String(finalH))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 双击手柄恢复默认高度
  const resetEditorH = () => {
    setEditorH(480)
    localStorage.setItem('skill_editor_h', '480')
  }

  // 打开时用 initial 重置
  useEffect(() => {
    if (open) {
      const src = initial || EMPTY_FORM
      setForm({
        id: src.id ?? null,
        name: src.name || '',
        description: src.description || '',
        content: src.content || '',
        category: src.category || '处置流程',
        tags: Array.isArray(src.tags) ? src.tags : [],
        enabled: src.enabled !== false,
        priority: src.priority ?? 0,
      })
      setCustomCat('')
      setTagInput('')
      setErr('')
      setCheckResult(null)
      setTestResult(null)
      setTestAgentId('')
      setTestMessage('')
    }
  }, [open, initial])

  // 加载智能体列表（测试运行用）
  useEffect(() => {
    if (open) {
      agentsApi.list().then((data) => {
        const list = Array.isArray(data) ? data : []
        setAgentList(list)
        if (list.length > 0 && !testAgentId) setTestAgentId(String(list[0].id))
      }).catch(() => setAgentList([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const setField = (field) => (value) => setForm((prev) => ({ ...prev, [field]: value }))

  // 字数 / token / 变量统计
  const stats = useMemo(() => {
    const chars = form.content.length
    const lines = form.content ? form.content.split('\n').length : 0
    return { chars, lines, tokens: estimateTokens(form.content), vars: extractVars(form.content) }
  }, [form.content])

  // 行号同步滚动
  const handleScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  const handleSubmit = () => {
    if (!form.name.trim()) { setErr('请填写技能名称'); return }
    if (!form.content.trim()) { setErr('请填写技能正文'); return }
    onSubmit({ ...form, tags: form.tags })
  }

  // 分类变更：预设或自定义
  const handleCategoryChange = (val) => {
    if (val === '__custom') {
      setForm((prev) => ({ ...prev, category: customCat || '' }))
    } else {
      setCustomCat('')
      setForm((prev) => ({ ...prev, category: val }))
    }
  }

  // 标签：回车添加
  const addTag = () => {
    const t = tagInput.trim()
    if (t && !form.tags.includes(t)) setField('tags')([...form.tags, t])
    setTagInput('')
  }

  // AI 优化
  const handleOptimize = async () => {
    if (!form.content.trim()) { toast.warning('请先填写技能正文'); return }
    setOptimizing(true)
    try {
      const res = await skillsApi.optimize({
        name: form.name, description: form.description, content: form.content,
      })
      if (res.content) {
        setField('content')(res.content)
        toast.success('AI 优化完成，已替换正文，可对比后再保存')
      } else {
        toast.warning('AI 未返回优化结果')
      }
    } catch (e) {
      toast.error(`优化失败：${e.message || e}`)
    } finally {
      setOptimizing(false)
    }
  }

  // AI 检测问题
  const handleCheck = async () => {
    if (!form.content.trim()) { toast.warning('请先填写技能正文'); return }
    setChecking(true)
    setCheckResult(null)
    try {
      const res = await skillsApi.check({ name: form.name, content: form.content })
      setCheckResult(res)
    } catch (e) {
      toast.error(`检测失败：${e.message || e}`)
    } finally {
      setChecking(false)
    }
  }

  // 测试运行
  const handleTest = async () => {
    if (!form.id) { toast.warning('请先保存技能后再测试'); return }
    if (!testAgentId) { toast.warning('请选择测试智能体'); return }
    if (!testMessage.trim()) { toast.warning('请输入测试问题'); return }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await skillsApi.test(form.id, {
        agent_id: Number(testAgentId),
        message: testMessage,
        content: form.content,
        name: form.name,
      })
      setTestResult(res)
    } catch (e) {
      toast.error(`测试失败：${e.message || e}`)
    } finally {
      setTesting(false)
    }
  }

  const isCustomCat = !CATEGORIES.includes(form.category) && form.category !== ''
  const catSelectValue = isCustomCat ? '__custom' : (form.category || '处置流程')
  // 资源级 owner 控制：新建资源允许编辑；已存在资源按 can_edit 标志
  const canEdit = !form.id || canEditResource(initial)

  return (
    <Drawer
      open={open}
      title={form.id ? `编辑技能：${form.name || ''}` : '新建技能'}
      onClose={onClose}
      width={fullscreen ? 'max-w-[95vw]' : 'w-[920px]'}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">取消</button>
          <button type="button" onClick={handleSubmit} disabled={saving || !canEdit} className="btn-primary" title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {err}
          </div>
        )}

        {/* 基本信息：名称 / 分类 / 摘要 / 标签 / 优先级 / 启用 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>技能名称 *</label>
            <input className={inputCls} value={form.name} onChange={(e) => setField('name')(e.target.value)} placeholder="如：告警研判SOP" />
          </div>
          <div>
            <label className={labelCls}>
              分类
              <span className="ml-1 text-muted-foreground">(可选自定义)</span>
            </label>
            <div className="flex gap-1.5">
              <CompactSelect
                size="lg"
                block
                value={catSelectValue}
                onChange={(e) => handleCategoryChange(e.target.value)}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="__custom">＋ 自定义…</option>
              </CompactSelect>
              {catSelectValue === '__custom' && (
                <input
                  className={`${inputCls} flex-1`}
                  value={isCustomCat ? form.category : customCat}
                  onChange={(e) => { setCustomCat(e.target.value); setField('category')(e.target.value) }}
                  placeholder="输入自定义分类"
                />
              )}
            </div>
          </div>
        </div>

        <div>
          <label className={labelCls}>简短摘要（列表展示用）</label>
          <input className={inputCls} value={form.description} onChange={(e) => setField('description')(e.target.value)} placeholder="一句话说明这个技能做什么" />
        </div>

        {/* 多标签编辑 */}
        <div>
          <label className={labelCls}>
            标签 <span className="text-muted-foreground">(回车添加，可多选)</span>
          </label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-secondary p-1.5">
            {form.tags.map((tag, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                {tag}
                <button type="button" onClick={() => setField('tags')(form.tags.filter((_, i) => i !== idx))}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            <input
              className="min-w-[100px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
              placeholder="输入标签后回车"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
            />
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {['告警', 'SOC', '一级响应', '封禁', '通知'].map((t) => {
              const has = form.tags.includes(t)
              return (
                <button
                  key={t} type="button"
                  onClick={() => setField('tags')(has ? form.tags.filter((x) => x !== t) : [...form.tags, t])}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition ${has ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/50'}`}
                >
                  {has ? '✓ ' : '+ '}{t}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>优先级（越大越靠前）</label>
            <input type="number" className={inputCls} value={form.priority} onChange={(e) => setField('priority')(Number(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>启用状态</label>
            <div className="flex items-center gap-2 pt-1.5">
              <button
                type="button"
                onClick={() => setField('enabled')(!form.enabled)}
                className={`relative h-5 w-9 rounded-full transition ${form.enabled ? 'bg-primary' : 'bg-input'}`}
                aria-label="切换启用状态"
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${form.enabled ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
              <span className={`text-xs ${form.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                {form.enabled ? '启用' : '禁用'}
              </span>
            </div>
          </div>
        </div>

        {/* 工具栏：AI 优化 / 检测 / 全屏 */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">智能助手</span>
          <button type="button" onClick={handleOptimize} disabled={optimizing} className="flex items-center gap-1 rounded border border-primary/50 px-2 py-1 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-50">
            <Wand2 className="h-3 w-3" /> {optimizing ? '优化中…' : 'AI 优化提示词'}
          </button>
          <button type="button" onClick={handleCheck} disabled={checking} className="flex items-center gap-1 rounded border border-info/50 px-2 py-1 text-[11px] text-info transition hover:bg-info/10 disabled:opacity-50">
            <ShieldCheck className="h-3 w-3" /> {checking ? '检测中…' : '检测问题'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <HoverTip text="字数 / 行数 / 预估 Token / 引用的变量" placement="left">
              <span className="inline-flex items-center gap-2 text-[10px] text-muted-foreground">
                <Lightbulb className="h-3 w-3" />
                <span>{stats.chars} 字 · {stats.lines} 行 · ≈{stats.tokens} tokens</span>
                {stats.vars.length > 0 && <span className="text-primary">· {stats.vars.length} 变量</span>}
              </span>
            </HoverTip>
            <button type="button" onClick={() => setFullscreen((v) => !v)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground" title={fullscreen ? '退出全屏' : '全屏编辑'}>
              {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              {fullscreen ? '退出全屏' : '全屏'}
            </button>
          </div>
        </div>

        {/* 左编辑 / 右预览 */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* 编辑区 */}
          <div className="flex flex-col">
            <label className={`${labelCls} flex items-center justify-between`}>
              <span>技能正文 * <span className="text-muted-foreground">(注入到 Agent system prompt)</span></span>
            </label>
            <div className="relative flex overflow-hidden rounded-md border border-border" style={{ height: fullscreen ? '82vh' : `${editorH}px` }}>
              {/* 行号 */}
              <div
                ref={gutterRef}
                className="select-none overflow-hidden bg-secondary px-2 py-2 text-right font-mono text-[11px] leading-[1.6] text-muted-foreground"
                style={{ minWidth: '40px' }}
              >
                {Array.from({ length: Math.max(stats.lines, 1) }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <textarea
                ref={textareaRef}
                onScroll={handleScroll}
                className="flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.6] text-foreground outline-none"
                value={form.content}
                onChange={(e) => setField('content')(e.target.value)}
                onInput={handleScroll}
                spellCheck={false}
                placeholder={'用自然语言描述处置流程 / 角色设定 / 领域规则 / SOP。\n\n示例：\n你是 {{role}} 专家。当收到告警时：\n1. 先核对告警源 IP 是否在白名单；\n2. 调用 get_threat_intel 查询威胁情报；\n3. 若为恶意，封禁 24h 并通知值班人员。'}
              />
            </div>
            <p className={`${hintCls} flex items-start gap-1.5`}>
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span>
                可用 <code className="rounded bg-secondary px-1 text-primary">{'{{key}}'}</code> 引用智能体变量。
                启用后会被注入到智能体的 system prompt，持续塑造 AI 行为。
              </span>
            </p>
          </div>

          {/* 实时预览区 */}
          <div className="flex flex-col">
            <label className={labelCls}>
              <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" /> 实时预览</span>
            </label>
            <div className="overflow-auto rounded-md border border-border bg-secondary p-3" style={{ height: fullscreen ? '82vh' : `${editorH}px` }}>
              <PreviewContent content={form.content} name={form.name} category={form.category} tags={form.tags} />
            </div>
          </div>
        </div>

        {/* 拖拽调高手柄：上下拖动调整编辑区高度，双击恢复默认（全屏时不显示） */}
        {!fullscreen && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整编辑区高度"
            title="拖动调整编辑区高度，双击恢复默认"
            onMouseDown={startResize}
            onDoubleClick={resetEditorH}
            className="group -mt-1 flex h-4 cursor-ns-resize select-none items-center justify-center text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          >
            <GripHorizontal className="h-3.5 w-8" aria-hidden />
          </div>
        )}

        {/* 检测结果 */}
        {checkResult && (
          <div className="rounded-md border border-border bg-secondary p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">检测报告</span>
              <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${(checkResult.score ?? 0) >= 80 ? 'bg-success/20 text-success' : (checkResult.score ?? 0) >= 60 ? 'bg-warning/20 text-warning' : 'bg-destructive/20 text-destructive'}`}>
                {checkResult.score ?? '-'} 分
              </span>
            </div>
            {Array.isArray(checkResult.issues) && checkResult.issues.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {checkResult.issues.map((iss, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px]">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                    <span className="text-muted-foreground"><b className="text-foreground">{iss.type}：</b>{iss.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px] text-success">
                <CheckCircle2 className="h-3 w-3" /> 未发现明显问题
              </div>
            )}
            {checkResult.suggestions && (
              <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                建议：{checkResult.suggestions}
              </p>
            )}
          </div>
        )}

        {/* 测试运行 */}
        <div className="rounded-md border border-border bg-secondary p-3">
          <div className="mb-2 flex items-center gap-2">
            <Play className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">测试运行</span>
            <span className="text-[10px] text-muted-foreground">注入此技能后，用指定智能体回答测试问题</span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <CompactSelect size="lg" block value={testAgentId} onChange={(e) => setTestAgentId(e.target.value)}>
              <option value="">选择测试智能体…</option>
              {agentList.map((a) => <option key={a.id} value={a.id}>{a.name || `#${a.id}`}</option>)}
            </CompactSelect>
            <button
              type="button" onClick={handleTest} disabled={testing || !form.id}
              className="flex items-center justify-center gap-1 rounded border border-primary/50 px-3 py-1.5 text-xs text-primary transition hover:bg-primary/10 disabled:opacity-50"
            >
              <Play className="h-3 w-3" /> {testing ? '运行中…' : '运行测试'}
            </button>
          </div>
          <textarea
            className={`${textareaCls} mt-2`} rows={2}
            value={testMessage} onChange={(e) => setTestMessage(e.target.value)}
            placeholder="输入测试问题，如：收到 1.2.3.4 的暴力破解告警，应如何处置？"
          />
          {!form.id && (
            <p className="mt-1 text-[10px] text-warning">提示：未保存的技能请先保存后再测试（草稿内容会一并注入）。</p>
          )}
          {testResult && (
            <div className="mt-2 rounded-md border border-border bg-background p-3">
              <div className="mb-1 text-[11px] font-medium text-foreground">智能体回复</div>
              <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">{testResult.reply || '(无回复)'}</pre>
              {testResult.injected_prompt && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-primary">查看注入的完整 prompt</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary p-2 text-[10px] text-muted-foreground">{testResult.injected_prompt}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}

// 预览内容：渲染 {{变量}} 高亮 + 简单分段结构
function PreviewContent({ content, name, category, tags }) {
  if (!content || !content.trim()) {
    return <span className="text-xs text-muted-foreground">正文为空，开始编辑后此处实时预览…</span>
  }
  const lines = content.split('\n')
  return (
    <div className="text-[12px] leading-relaxed text-foreground">
      {/* 头部信息 */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
        <span className="text-sm font-semibold">{name || '(未命名)'}</span>
        {category && (
          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${CATEGORY_STYLES[category] || CATEGORY_STYLES['其他']}`}>
            {category}
          </span>
        )}
        {(tags || []).map((t) => (
          <span key={t} className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t}</span>
        ))}
      </div>
      {/* 正文行 */}
      {lines.map((line, i) => {
        const trimmed = line.trim()
        // markdown 标题行
        if (/^#{1,3}\s+/.test(trimmed)) {
          return <div key={i} className="mt-1 font-semibold text-foreground">{renderHighlighted(trimmed.replace(/^#{1,3}\s+/, ''))}</div>
        }
        // 分隔线
        if (/^[-=*]{3,}$/.test(trimmed)) {
          return <div key={i} className="my-1 border-t border-border" />
        }
        return <div key={i} className="whitespace-pre-wrap break-words">{renderHighlighted(line) || '\u00A0'}</div>
      })}
    </div>
  )
}
