/**
 * AI 思考过程折叠面板
 *
 * - 默认折叠，显示一行摘要（如"5 步推理"）
 * - 展开后结构化处理：IP/工具名/关键判断高亮、步骤序号分块
 * - 复制按钮（运维/审计场景常用）
 *
 * Props:
 * - thinking: string  思考过程原始文本
 * - streaming: boolean 是否正在流式输出
 */
import { useState, useMemo, useCallback } from 'react'
import { ChevronRight, Brain, Copy, Check } from 'lucide-react'

// 高亮文本中的 IP 地址、工具名、关键判断句
function highlightEntities(text) {
  if (!text) return []
  const parts = []
  // 匹配 IP 地址（含 CIDR）
  const ipRe = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?\b/g
  // 匹配工具名（snake_case 标识符，通常前后有空格或冒号）
  const toolRe = /\b([a-z][a-z0-9_]{3,30})\b/g
  // 匹配关键判断句（looks like / appears to / seems / 疑似 / 确认 / 恶意 / foreign 等）
  const keywordRe = /\b(looks like|appears to|seems to|is likely|foreign IP|malicious|suspicious)\b/gi

  // 简化：按行拆分，每行做 IP 高亮 + 关键词高亮
  const lines = text.split('\n')
  return lines.map((line, lineIdx) => {
    const segments = []
    let lastIdx = 0
    // 收集所有匹配
    const matches = []
    let m
    // IP 匹配
    ipRe.lastIndex = 0
    while ((m = ipRe.exec(line)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'ip' })
    }
    // 关键词匹配
    keywordRe.lastIndex = 0
    while ((m = keywordRe.exec(line)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'keyword' })
    }
    // 工具名匹配（排除常见英文单词）
    toolRe.lastIndex = 0
    while ((m = toolRe.exec(line)) !== null) {
      const word = m[1]
      // 排除常见英文单词（只匹配含下划线的或已知工具名）
      if (word.includes('_') || ['search_assets', 'search_discovered_assets', 'get_threat_intel', 'check_whitelist', 'check_subnet', 'query_banned_ip', 'record_ban', 'calculate_ban_duration', 'search_knowledge_base', 'read_document', 'query_kb_file'].includes(word)) {
        matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], type: 'tool' })
      }
    }
    // 按位置排序
    matches.sort((a, b) => a.start - b.start)
    // 去重叠
    const filtered = []
    let lastEnd = -1
    for (const match of matches) {
      if (match.start >= lastEnd) {
        filtered.push(match)
        lastEnd = match.end
      }
    }
    // 构建渲染段
    for (const match of filtered) {
      if (match.start > lastIdx) {
        segments.push({ text: line.slice(lastIdx, match.start), type: 'text' })
      }
      segments.push(match)
      lastIdx = match.end
    }
    if (lastIdx < line.length) {
      segments.push({ text: line.slice(lastIdx), type: 'text' })
    }
    return { lineIdx, segments }
  })
}

// 统计推理步骤数（按行或段落分）
function countReasoningSteps(text) {
  if (!text) return 0
  // 按空行分段，每段算一步
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim())
  return paragraphs.length || 1
}

export default function ThinkingPanel({ thinking, streaming = false }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const steps = useMemo(() => countReasoningSteps(thinking), [thinking])
  const highlighted = useMemo(() => open ? highlightEntities(thinking) : [], [thinking, open])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(thinking || '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [thinking])

  return (
    <div className="mt-1.5">
      {/* 折叠/展开按钮 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-muted-foreground"
        >
          <ChevronRight className={`inline-block h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Brain className="h-3.5 w-3.5" />
          <span>思考过程</span>
          <span className="text-muted-foreground">
            {streaming ? '(思考中…)' : `(${steps} 步推理)`}
          </span>
        </button>
        {/* 复制按钮 */}
        {open && (
          <button
            type="button"
            onClick={handleCopy}
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition hover:text-muted-foreground"
            title="复制思考过程"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>

      {/* 展开内容：结构化渲染 */}
      {open && (
        <div className="mt-1 max-h-80 overflow-y-auto rounded-lg bg-muted p-2.5 text-xs leading-relaxed text-muted-foreground">
          {highlighted.map(({ lineIdx, segments }) => (
            <div key={lineIdx} className="py-0.5">
              {segments.map((seg, i) => {
                if (seg.type === 'ip') {
                  return (
                    <code key={i} className="rounded bg-amber-500/15 px-1 font-mono text-amber-600 dark:text-amber-400">
                      {seg.text}
                    </code>
                  )
                }
                if (seg.type === 'tool') {
                  return (
                    <code key={i} className="rounded bg-sky-500/15 px-1 font-mono text-sky-600 dark:text-sky-400">
                      {seg.text}
                    </code>
                  )
                }
                if (seg.type === 'keyword') {
                  return (
                    <span key={i} className="rounded bg-rose-500/15 px-0.5 text-rose-600 dark:text-rose-400">
                      {seg.text}
                    </span>
                  )
                }
                return <span key={i}>{seg.text}</span>
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
