/**
 * System Prompt 折叠编辑区（对标 new-api Playground System Prompt）
 *
 * 复用 ChatPage"已上传文件"折叠区模式，放在顶部工具栏下方。
 * 初始值为空（placeholder 提示未修改，使用智能体默认），用户编辑后才覆盖。
 * 修改后仅本次会话生效，不影响智能体配置。
 *
 * 注意：编辑 System Prompt 会绕过技能注入（enabled_skills），
 * 用户应看到原始 prompt 的效果——这是 Playground 调试用途的预期行为。
 *
 * Props:
 * - value: 当前 System Prompt 字符串（'' 表示未覆盖）
 * - onChange: (text) => void
 * - agentDefaultPrompt: 智能体配置的默认 System Prompt（用于预览/恢复参考）
 */
import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, FileText, RotateCcw, Info } from 'lucide-react'
import { AutoGrowTextarea } from '../ui'

export default function SystemPromptEditor({
  value = '',
  onChange,
  agentDefaultPrompt = '',
}) {
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef(null)
  // 本地草稿：编辑时不立即触发 onChange，失焦/保存时才提交
  // 避免 Hermes 多轮对话每次按键都重置 session
  const [draft, setDraft] = useState(value)

  // 外部 value 变化（如切换智能体）时同步草稿
  useEffect(() => {
    setDraft(value)
  }, [value])

  const isModified = !!(value && value.trim())
  const charCount = draft?.length || 0

  // 提交草稿到 onChange
  const commitDraft = () => {
    onChange(draft || '')
  }

  // 恢复智能体默认（清空覆盖）
  const resetToDefault = () => {
    setDraft('')
    onChange('')
  }

  // 展开时自动聚焦 textarea
  useEffect(() => {
    if (expanded && textareaRef.current) {
      // 延迟一帧确保 DOM 已渲染
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [expanded])

  return (
    <div className="shrink-0 border-b border-border">
      {/* 折叠头 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-6 py-1.5 text-left text-[11px] text-muted-foreground transition hover:text-foreground"
      >
        <span className="text-[9px]">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <FileText className="h-3.5 w-3.5" />
        <span>System Prompt</span>
        {isModified && (
          <span className="inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            已修改
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {isModified ? `${charCount} 字 · 仅本次会话生效` : '未修改，使用智能体默认'}
        </span>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="px-6 pb-2.5">
          {/* 提示条 */}
          <div className="mb-1.5 flex items-start gap-1.5 rounded-md border border-info/30 bg-info/5 px-2 py-1 text-[10px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-info" />
            <span>
              修改后仅本次会话生效，不影响智能体配置。编辑后会跳过技能注入，便于调试原始 prompt 效果。
            </span>
          </div>

          {/* textarea */}
          <AutoGrowTextarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            placeholder={
              agentDefaultPrompt
                ? `未修改，使用智能体默认：\n${agentDefaultPrompt.slice(0, 100)}${agentDefaultPrompt.length > 100 ? '…' : ''}`
                : '未修改，使用智能体默认（空）'
            }
            rows={4}
            className="w-full resize-y rounded-md border border-border bg-secondary px-3 py-2 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            style={{ minHeight: '120px' }}
          />

          {/* 底部操作行 */}
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {charCount} 字 · 失焦自动保存
            </span>
            {isModified && (
              <button
                type="button"
                onClick={resetToDefault}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                <span>恢复智能体默认</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
