/**
 * 用户消息 inline 编辑器（对标 new-api Playground 编辑重发）
 *
 * 用户点击用户消息上的"编辑"按钮时，消息气泡切换为编辑态：
 * textarea + 保存/取消按钮。保存后删除该消息及之后所有消息，用新文本重新发送。
 *
 * Props:
 * - value: 原始消息文本（编辑初始值）
 * - onSave: (newText) => void  保存回调，触发删除+重发
 * - onCancel: () => void  取消编辑
 */
import { useState, useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'

export default function MessageEditor({ value = '', onSave, onCancel }) {
  const [text, setText] = useState(value)
  const textareaRef = useRef(null)

  // 挂载时自动聚焦并选中末尾
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    // 光标移到末尾
    const len = ta.value.length
    ta.setSelectionRange(len, len)
    // 自适应高度
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [])

  // 文本变化时自适应高度
  const handleChange = (e) => {
    setText(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  // 键盘事件：Enter 保存，Esc 取消，Shift+Enter 换行
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    }
  }

  const handleSave = () => {
    const trimmed = text.trim()
    if (!trimmed) return  // 空文本不保存
    onSave?.(trimmed)
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full max-w-[500px] resize-none rounded-2xl border border-primary/40 bg-primary px-4 py-2.5 text-sm leading-relaxed text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        style={{ minHeight: '60px', maxHeight: '200px' }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-secondary px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
          <span>取消</span>
          <span className="ml-1 text-xs text-muted-foreground">Esc</span>
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!text.trim()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          <span>保存并发送</span>
          <span className="ml-1 text-xs text-primary-foreground">Enter</span>
        </button>
      </div>
    </div>
  )
}
