/**
 * 轻量级 Markdown 渲染组件（无第三方依赖）。
 *
 * 支持：标题(h1-h4)、加粗(**)、斜体(*)、行内代码(``)、
 * 代码块(```)、无序列表(-/*)、有序列表(1.)、引用(>)、
 * 分割线(---)、链接、表格、段落。
 *
 * 文件名点击下载：传入 fileLinks（[{file_id, file_name}]）与 onDownloadFile 回调后，
 * 正文中命中的文件名（行内代码 / 链接 / 加粗 / 纯文本四种写法）会渲染为
 * 可点击的下载链接，点击触发 onDownloadFile(file)。典型场景：Agent 生成文档后，
 * LLM 在回复正文里以 `文件名.xlsx` 提及产物，用户直接点文件名即可下载。
 *
 * 流式安全：不完整的 Markdown 标记按普通文本显示，下个 token 到达后自然修正。
 *
 * 用法：<MarkdownRenderer content={msg.content} />
 *       <MarkdownRenderer content={msg.content} fileLinks={files} onDownloadFile={fn} />
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'

/** 转义文件名中的正则特殊字符（文件名可能含 ( ) . 等字符）。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构建"文件名 → 点击下载"匹配上下文。
 *
 * 无有效文件或未传回调时返回 null（渲染行为与原版完全一致）。
 * 文件名按长度降序参与匹配，避免 "a.xlsx" 抢先命中 "a.xlsx.bak"。
 */
function buildFileLinkContext(fileLinks, onDownloadFile) {
  if (typeof onDownloadFile !== 'function' || !Array.isArray(fileLinks)) return null
  const byName = new Map()
  for (const f of fileLinks) {
    const name = f && f.file_name
    if (!name || byName.has(name)) continue
    byName.set(name, { file_id: f.file_id, file_name: name })
  }
  if (byName.size === 0) return null
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${names.map(escapeRegExp).join('|')})`, 'g')
  return { byName, pattern, onDownloadFile }
}

/** 渲染单个可点击的文件名下载链接（蓝色 + 下划线 + 下载图标）。 */
function makeFileLink(file, key, ctx) {
  return (
    <button
      type="button"
      key={key}
      onClick={() => ctx.onDownloadFile(file)}
      title={`点击下载 ${file.file_name}`}
      className="inline-flex items-center gap-1 rounded text-primary underline decoration-primary/40 underline-offset-2 transition hover:decoration-primary"
    >
      <Download className="h-3 w-3 shrink-0" />
      <span>{file.file_name}</span>
    </button>
  )
}

/**
 * 按已知文件名切分文本：命中的片段渲染为下载链接，其余保持纯文本。
 * 返回元素/字符串数组（无 ctx 或未命中时返回原文，行为与普通渲染一致）。
 */
function splitByFileLinks(text, keyPrefix, ctx) {
  if (!ctx || !text) return text ? [text] : []
  const parts = []
  let last = 0
  ctx.pattern.lastIndex = 0
  let m
  while ((m = ctx.pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(makeFileLink(ctx.byName.get(m[1]), `${keyPrefix}-fl-${parts.length}`, ctx))
    last = m.index + m[1].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** 片段数组中是否包含文件链接元素（用于判断是否命中）。 */
function hasFileLink(parts) {
  return parts.some((p) => typeof p !== 'string')
}

/**
 * 解析行内格式：加粗、斜体、行内代码、链接、文件名下载链接。
 * 返回 React 元素数组。
 *
 * ctx：文件名匹配上下文（buildFileLinkContext 产物），null 时完全不启用文件链接。
 */
function renderInline(text, keyPrefix = '', ctx = null) {
  if (!text) return []

  const elements = []
  let remaining = text

  // 顺序匹配：行内代码 → 加粗 → 斜体 → 链接
  // 用占位符保护已匹配的内容，避免嵌套冲突
  const placeholders = []

  // 1. 提取行内代码 `code`（内容命中已知文件名 → 渲染为下载链接）
  remaining = remaining.replace(/`([^`]+)`/g, (match, code) => {
    const idx = placeholders.length
    const segs = ctx ? splitByFileLinks(code, `${keyPrefix}-code-${idx}`, ctx) : [code]
    if (ctx && hasFileLink(segs)) {
      placeholders.push(
        <React.Fragment key={`${keyPrefix}-code-${idx}`}>{segs}</React.Fragment>
      )
    } else {
      placeholders.push(
        <code
          key={`${keyPrefix}-code-${idx}`}
          className="rounded bg-muted px-1.5 py-0.5 text-[13px] font-mono text-primary"
        >
          {code}
        </code>
      )
    }
    return `\x00${idx}\x00`
  })

  // 2. 提取加粗 **text**（内容命中文件名 → 内嵌下载链接）
  remaining = remaining.replace(/\*\*([^*]+)\*\*/g, (match, content) => {
    const idx = placeholders.length
    placeholders.push(
      <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold text-foreground">
        {ctx ? splitByFileLinks(content, `${keyPrefix}-b-${idx}`, ctx) : content}
      </strong>
    )
    return `\x00${idx}\x00`
  })

  // 3. 提取斜体 *text*（不匹配 ** 已被上面的占位符保护）
  remaining = remaining.replace(/\*([^*\n]+)\*/g, (match, content) => {
    const idx = placeholders.length
    placeholders.push(
      <em key={`${keyPrefix}-i-${idx}`} className="italic">
        {ctx ? splitByFileLinks(content, `${keyPrefix}-i-${idx}`, ctx) : content}
      </em>
    )
    return `\x00${idx}\x00`
  })

  // 4. 提取链接 [text](url)（链接文本命中文件名 → 渲染为下载链接，忽略原 url：
  //    直链下载需要 Bearer 头，统一走 onDownloadFile 的 blob 通道）
  remaining = remaining.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match, linkText, url) => {
      const idx = placeholders.length
      const segs = ctx ? splitByFileLinks(linkText, `${keyPrefix}-a-${idx}`, ctx) : null
      if (ctx && hasFileLink(segs)) {
        placeholders.push(
          <React.Fragment key={`${keyPrefix}-a-${idx}`}>{segs}</React.Fragment>
        )
      } else {
        placeholders.push(
          <a
            key={`${keyPrefix}-a-${idx}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:text-primary"
          >
            {linkText}
          </a>
        )
      }
      return `\x00${idx}\x00`
    }
  )

  // 5. 将剩余文本与占位符拼回元素数组（剩余文本同样按文件名切分）
  const parts = remaining.split(/(\x00\d+\x00)/)
  for (const part of parts) {
    if (!part) continue
    const phMatch = part.match(/^\x00(\d+)\x00$/)
    if (phMatch) {
      elements.push(placeholders[parseInt(phMatch[1], 10)])
    } else if (ctx) {
      elements.push(...splitByFileLinks(part, `${keyPrefix}-p-${elements.length}`, ctx))
    } else {
      elements.push(part)
    }
  }

  return elements.length > 0 ? elements : [text]
}

const CODE_KEYWORDS = {
  javascript:
    'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof of in this super null undefined true false delete void yield static get set',
  typescript:
    'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof of in this super null undefined true false delete void yield static get set interface type enum implements public private protected readonly declare namespace abstract as any number string boolean void never unknown',
  python:
    'def return if elif else for while in not and or import from as class try except finally raise with lambda pass break continue global nonlocal yield async await None True False self print match case',
  java:
    'public private protected class interface extends implements static final void int long double float boolean char String new return if else for while do switch case break continue try catch finally throw throws import package this super null true false abstract synchronized volatile transient instanceof enum record',
  go:
    'package import func return if else for range switch case break continue var const type struct interface map chan go defer select nil true false string int int64 float64 bool byte rune error',
  rust:
    'fn let mut pub use mod struct enum impl trait for in if else match while loop return break continue move ref self Self true false Some None Ok Err async await const static type where',
  sql:
    'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX AND OR NOT NULL AS DISTINCT UNION ALL CASE WHEN THEN ELSE END IS IN LIKE BETWEEN COUNT SUM AVG MIN MAX DESC ASC',
  bash:
    'if then else elif fi for while do done case esac function return exit echo export local readonly cd ls grep sed awk cat curl set unset source',
  yaml: 'true false null yes no',
  default: 'true false null undefined',
}

const KEYWORD_RE_CACHE = new Map()

function normalizeCodeLang(lang) {
  const key = String(lang || '').toLowerCase()
  if (['js', 'jsx', 'mjs', 'cjs'].includes(key)) return 'javascript'
  if (['ts', 'tsx'].includes(key)) return 'typescript'
  if (['py'].includes(key)) return 'python'
  if (['sh', 'shell', 'zsh'].includes(key)) return 'bash'
  if (['yml'].includes(key)) return 'yaml'
  if (['c++', 'cpp', 'c'].includes(key)) return 'java'
  return key || 'default'
}

/** 语言关键词匹配正则（简单缓存，避免每次渲染重复构造） */
function keywordRegExp(lang) {
  const key = normalizeCodeLang(lang)
  if (KEYWORD_RE_CACHE.has(key)) return KEYWORD_RE_CACHE.get(key)
  const words = (CODE_KEYWORDS[key] || CODE_KEYWORDS.default).split(/\s+/).filter(Boolean)
  // 关键词按整词匹配并单独成组；含大写（SQL）时不加 i 标记
  const source = `(\\b(?:${words.join('|')})\\b)`
  const re = { source, flags: /[A-Z]/.test(words.join('')) ? '' : 'i' }
  KEYWORD_RE_CACHE.set(key, re)
  return re
}

/**
 * 轻量语法高亮（无第三方依赖）：
 * 依次识别注释、字符串、数字、关键词、函数调用，其余按普通文本输出。
 * 颜色全部使用语义令牌，明暗主题自动适配。
 */
function tokenizeCode(code, lang) {
  if (!code) return []
  const kw = keywordRegExp(lang)
  const pattern = new RegExp(
    [
      '(\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)', // 注释
      '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)', // 字符串
      '\\b(\\d+(?:\\.\\d+)?)\\b', // 数字
      kw.source, // 关键词（捕获组 4）
      '\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()', // 函数调用
    ].join('|'),
    `g${kw.flags}`
  )

  const nodes = []
  let last = 0
  let match
  let key = 0
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > last) nodes.push(code.slice(last, match.index))
    const cls = match[1]
      ? 'text-muted-foreground/80 italic'
      : match[2]
        ? 'text-success'
        : match[3]
          ? 'text-warning'
          : match[4]
            ? 'text-primary font-medium'
            : 'text-info'
    nodes.push(
      <span key={`tok-${key++}`} className={cls}>
        {match[0]}
      </span>
    )
    last = match.index + match[0].length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return nodes
}

/** 代码块：语言标签 + 一键复制 + 语法高亮（所有颜色使用语义令牌） */
function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用（非 https / 无权限）时静默降级，不打断阅读
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-background/60">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title="复制代码"
          aria-label="复制代码"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-background hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed">
        <code className="font-mono text-foreground">{tokens}</code>
      </pre>
    </div>
  )
}

/**
 * 解析整段 Markdown 内容，返回块级元素数组。
 * ctx：文件名下载上下文，透传给所有行内渲染调用。
 */
function parseMarkdown(content, ctx = null) {
  if (!content) return []

  const lines = content.split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行跳过
    if (!trimmed) {
      i++
      continue
    }

    // 代码块 ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // 跳过结束的 ```
      blocks.push(
        <CodeBlock key={`code-${blocks.length}`} code={codeLines.join('\n')} lang={lang} />
      )
      continue
    }

    // 标题 # ## ### ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const text = headingMatch[2]
      const sizes = ['text-xl', 'text-lg', 'text-base', 'text-sm']
      const margins = ['mt-3 mb-2', 'mt-3 mb-1.5', 'mt-2 mb-1', 'mt-2 mb-1']
      blocks.push(
        React.createElement(
          `h${level}`,
          {
            key: `h-${blocks.length}`,
            className: `font-bold text-foreground ${sizes[level - 1]} ${margins[level - 1]}`,
          },
          renderInline(text, `h-${blocks.length}`, ctx)
        )
      )
      i++
      continue
    }

    // 分割线 --- ***
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(
        <hr
          key={`hr-${blocks.length}`}
          className="my-3 border-border"
        />
      )
      i++
      continue
    }

    // 引用 >
    if (trimmed.startsWith('>')) {
      const quoteLines = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={`quote-${blocks.length}`}
          className="my-2 rounded-r-lg border-l-4 border-primary/40 bg-muted/60 py-2 pl-3 pr-3 text-muted-foreground"
        >
          {renderInline(quoteLines.join(' '), `quote-${blocks.length}`, ctx)}
        </blockquote>
      )
      continue
    }

    // 无序列表 - * +
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*+]\s+/, '')
        items.push(itemText)
        i++
      }
      blocks.push(
        <ul
          key={`ul-${blocks.length}`}
          className="my-1.5 list-disc space-y-0.5 pl-5 text-foreground"
        >
          {items.map((item, idx) => (
            <li key={`ul-item-${blocks.length}-${idx}`}>
              {renderInline(item, `ul-item-${blocks.length}-${idx}`, ctx)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    // 有序列表 1. 2. etc.
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+\.\s+/, '')
        items.push(itemText)
        i++
      }
      blocks.push(
        <ol
          key={`ol-${blocks.length}`}
          className="my-1.5 list-decimal space-y-0.5 pl-5 text-foreground"
        >
          {items.map((item, idx) => (
            <li key={`ol-item-${blocks.length}-${idx}`}>
              {renderInline(item, `ol-item-${blocks.length}-${idx}`, ctx)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    // 表格 | col | col |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim())
        i++
      }
      // 解析表格
      if (tableLines.length >= 2) {
        const parseRow = (row) =>
          row.split('|').slice(1, -1).map((cell) => cell.trim())
        const headers = parseRow(tableLines[0])
        // 第二行是分隔线 |---|---|
        const rows = tableLines.slice(2).map(parseRow).filter((r) => r.length > 0)
        blocks.push(
          <div key={`table-${blocks.length}`} className="my-2 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr>
                  {headers.map((h, idx) => (
                    <th
                      key={`th-${blocks.length}-${idx}`}
                      className="border border-border bg-muted/70 px-3 py-1.5 text-left font-semibold text-foreground"
                    >
                      {renderInline(h, `th-${blocks.length}-${idx}`, ctx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rIdx) => (
                  <tr
                    key={`tr-${blocks.length}-${rIdx}`}
                    className="transition-colors even:bg-muted/30 hover:bg-primary/5"
                  >
                    {row.map((cell, cIdx) => (
                      <td
                        key={`td-${blocks.length}-${rIdx}-${cIdx}`}
                        className="border border-border px-3 py-1.5 text-foreground/80"
                      >
                        {renderInline(cell, `td-${blocks.length}-${rIdx}-${cIdx}`, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        continue
      }
    }

    // 普通段落：收集连续非空、非特殊行
    const paraLines = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('>') &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|'))
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={`p-${blocks.length}`} className="my-1.5 leading-relaxed">
          {renderInline(paraLines.join(' '), `p-${blocks.length}`, ctx)}
        </p>
      )
    }
  }

  return blocks
}

export default function MarkdownRenderer({ content, className = '', fileLinks, onDownloadFile }) {
  const ctx = useMemo(
    () => buildFileLinkContext(fileLinks, onDownloadFile),
    [fileLinks, onDownloadFile]
  )
  const blocks = useMemo(() => parseMarkdown(content, ctx), [content, ctx])

  return (
    <div className={`text-sm ${className}`}>
      {blocks}
    </div>
  )
}
