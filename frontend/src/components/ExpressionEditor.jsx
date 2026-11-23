// 表达式编辑器：用于条件分支 / 循环条件等需要复杂表达式的字段
//
// 实现：
//   - textarea + 语法高亮（覆盖层 div，相同字体度量对齐）
//   - 实时校验：括号配对 / 变量引用格式 {{...}}
//   - 常用函数提示：contains() length() now() upper() lower() 等，点击插入
//
// 暗色主题，语义令牌

import { useMemo, useRef, useState } from 'react'
import { Check, AlertCircle, Code2 } from 'lucide-react'
import { VariablePicker } from './VariablePicker'
import { inputBaseCls, labelCls } from './property/FormControls'

// 常用函数（条件表达式辅助）
const COMMON_FUNCTIONS = [
  { name: 'contains', desc: 'contains(a, b) — a 是否包含 b' },
  { name: 'length', desc: 'length(a) — 字符串/数组长度' },
  { name: 'now', desc: 'now() — 当前时间戳' },
  { name: 'upper', desc: 'upper(s) — 转大写' },
  { name: 'lower', desc: 'lower(s) — 转小写' },
  { name: 'starts_with', desc: 'starts_with(a, b)' },
  { name: 'ends_with', desc: 'ends_with(a, b)' },
  { name: 'is_empty', desc: 'is_empty(a) — 是否为空' },
]

// 简单语法高亮：返回带 className 的片段数组
// 识别：变量引用 {{...}}、字符串 '...' / "..."、数字、函数名、关键字 AND OR NOT
function highlight(text) {
  if (!text) return []
  const tokens = []
  // 使用单一正则按顺序匹配
  const regex = /(\{\{[^}]+\}\})|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b(?:AND|OR|NOT|TRUE|FALSE|true|false|and|or|not)\b)|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/g
  let lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index), className: '' })
    }
    if (match[1]) {
      tokens.push({ text: match[1], className: 'text-primary' })
    } else if (match[2]) {
      tokens.push({ text: match[2], className: 'text-success' })
    } else if (match[3]) {
      tokens.push({ text: match[3], className: 'text-warning font-semibold' })
    } else if (match[4]) {
      tokens.push({ text: match[4], className: 'text-info' })
    } else if (match[5]) {
      tokens.push({ text: match[5], className: 'text-primary' })
    }
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), className: '' })
  }
  return tokens
}

// 校验表达式：括号配对 + 变量引用格式
function validateExpression(text) {
  if (!text || !text.trim()) return { ok: true, errors: [] }
  const errors = []
  // 括号配对
  const stack = []
  const pairs = { '(': ')', '[': ']', '{': '}' }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[' || c === '{') {
      stack.push({ char: c, pos: i })
    } else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop()
      if (!top || pairs[top.char] !== c) {
        errors.push(`位置 ${i + 1}：括号不匹配 '${c}'`)
      }
    }
  }
  stack.forEach((s) => errors.push(`位置 ${s.pos + 1}：未闭合的括号 '${s.char}'`))

  // 变量引用格式 {{...}}：检查是否成对
  const openCount = (text.match(/\{\{/g) || []).length
  const closeCount = (text.match(/\}\}/g) || []).length
  if (openCount !== closeCount) {
    errors.push(`变量引用不配对：{{ ${openCount} 个，}} ${closeCount} 个`)
  }

  // 单花括号警告（疑似误用 ${...}）
  if (/\$\{[^}]+\}/.test(text)) {
    errors.push("检测到 ${...} 写法，建议改为 {{...}} 格式")
  }

  return { ok: errors.length === 0, errors }
}

// 表达式编辑器组件
export function ExpressionEditor({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 4,
  currentNodeId,
}) {
  const textareaRef = useRef(null)
  const [showFns, setShowFns] = useState(false)
  const fnsRef = useRef(null)

  const tokens = useMemo(() => highlight(value || ''), [value])
  const validation = useMemo(() => validateExpression(value || ''), [value])

  // 在光标位置插入文本
  const insertAtCursor = (insert) => {
    const el = textareaRef.current
    if (!el) {
      onChange((value || '') + insert)
      return
    }
    const start = el.selectionStart ?? (value || '').length
    const end = el.selectionEnd ?? (value || '').length
    const newValue = (value || '').slice(0, start) + insert + (value || '').slice(end)
    onChange(newValue)
    requestAnimationFrame(() => {
      try {
        el.focus()
        el.setSelectionRange(start + insert.length, start + insert.length)
      } catch {
        /* 忽略 */
      }
    })
  }

  // 点击函数：插入带括号的函数名，光标停在括号内
  const insertFunction = (name) => {
    insertAtCursor(`${name}()`)
    // 把光标左移一位进入括号
    const el = textareaRef.current
    if (el) {
      requestAnimationFrame(() => {
        try {
          const pos = el.selectionStart - 1
          el.setSelectionRange(pos, pos)
        } catch {
          /* 忽略 */
        }
      })
    }
    setShowFns(false)
  }

  // 插入变量（来自 VariablePicker）
  const insertVariable = (insert) => insertAtCursor(insert)

  // 同步滚动：textarea 滚动时高亮层同步
  const handleScroll = () => {
    const ta = textareaRef.current
    if (!ta) return
    const hl = ta.parentElement?.querySelector('.expr-highlight')
    if (hl) {
      hl.scrollTop = ta.scrollTop
      hl.scrollLeft = ta.scrollLeft
    }
  }

  return (
    <div>
      {label && (
        <div className="mb-1 flex items-center justify-between">
          <label className={labelCls + ' mb-0'}>{label}</label>
          <button
            type="button"
            onClick={() => setShowFns((o) => !o)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-primary"
            title="常用函数"
          >
            <Code2 className="h-3 w-3" />
            函数
          </button>
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <div className="relative min-w-0 flex-1">
          {/* 高亮覆盖层：与 textarea 完全对齐 */}
          <pre
            aria-hidden="true"
            className="expr-highlight pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-sm leading-[1.5]"
          >
            {tokens.map((t, idx) => (
              <span key={idx} className={t.className}>
                {t.text}
              </span>
            ))}
            {/* 末尾换行占位，避免最后一行高度塌陷 */}
            {'\n'}
          </pre>
          <textarea
            ref={textareaRef}
            className={`${inputBaseCls} relative w-full resize-y font-mono text-transparent caret-foreground`}
            style={{ caretColor: 'var(--foreground)' }}
            rows={rows}
            placeholder={placeholder}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            onScroll={handleScroll}
            spellCheck={false}
          />
        </div>
        <div className="pt-[2px]">
          <VariablePicker currentNodeId={currentNodeId} onPick={insertVariable} />
        </div>
      </div>

      {/* 函数提示面板 */}
      {showFns && (
        <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-md border border-border bg-popover p-1.5">
          {COMMON_FUNCTIONS.map((fn) => (
            <button
              key={fn.name}
              type="button"
              onClick={() => insertFunction(fn.name)}
              title={fn.desc}
              className="truncate rounded px-1.5 py-1 text-left font-mono text-xs text-primary transition hover:bg-primary/10"
            >
              {fn.name}()
            </button>
          ))}
        </div>
      )}

      {/* 校验状态 */}
      <div className="mt-1.5">
        {validation.ok ? (
          <div className="flex items-center gap-1 text-xs text-success">
            <Check className="h-3 w-3" />
            表达式校验通过
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {validation.errors.map((err, idx) => (
              <div key={idx} className="flex items-start gap-1 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{err}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

export default ExpressionEditor
