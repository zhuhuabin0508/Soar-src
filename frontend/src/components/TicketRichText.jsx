// 工单富文本组件：所见即所得图片粘贴 + 画廊式放大预览 + 附件后缀校验
// - RichEditable：contentEditable 富文本输入框，粘贴截图后在框内直接以图片呈现（所见即所得），
//   数据层仍为纯文本 + `![名称](url)` 图片引用（与展示端 RichTextView / 存量数据完全兼容）；
//   框内图片双击弹出 Lightbox 放大预览
// - RichTextView：只读展示，少量图（≤3 张）内联限高展示、多图（≥4 张）转为九宫格缩略图网格，
//   单击缩略图打开 Lightbox；Lightbox 支持多图切换（←/→ 键盘、箭头按钮、计数、缩略图导航条）
// - attachmentFileError / ATTACHMENT_EXTS / ATTACHMENT_ACCEPT：附件后缀白名单（与后端一致）
// 注意：本文件避免出现方括号正则字面量（如带连字符的字符类），Tailwind 会误扫为任意值类名生成非法 CSS
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from '../store/toastStore'
import ticketApi, { attachmentUrl } from '../api/tickets'

// 附件允许的后缀（有序，与后端白名单一致；拒绝一切可执行文件）
export const ATTACHMENT_EXTS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'pdf', 'txt', 'log', 'md', 'csv', 'zip',
]
// 文件选择框 accept 属性
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTS.map((e) => `.${e}`).join(',')

// 上传前的后缀校验：返回错误消息（null 表示通过）
export function attachmentFileError(file) {
  if (!file) return '未选择文件'
  const ext = String(file.name || '').split('.').pop().toLowerCase()
  if (!ATTACHMENT_EXTS.includes(ext)) {
    return `不支持的文件类型「${file.name}」，仅支持：${ATTACHMENT_EXTS.join(' / ')}`
  }
  return null
}

// 图片 markdown：![label](url)
const IMG_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
// 本系统附件路径前缀（mdToHtml 仅放行该前缀，防外链注入）
const ATTACH_URL_PREFIX = '/api/v1/tickets/attachments/'

// HTML 转义（任何文本进入编辑器 DOM 前必须转义，防 XSS）
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// 编辑态内嵌图片类名（Tailwind 扫描源码字符串生成对应 CSS）
const EDIT_IMG_CLS = 'my-1 block max-h-60 w-fit max-w-full cursor-zoom-in rounded-md border border-border object-contain'

function canonicalAttachUrl(raw) {
  if (!raw) return ''
  let path = String(raw).trim()
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try { path = new URL(path).pathname } catch { return '' }
  }
  const q = path.indexOf('?')
  if (q >= 0) path = path.slice(0, q)
  const hash = path.indexOf('#')
  if (hash >= 0) path = path.slice(0, hash)
  return path.startsWith(ATTACH_URL_PREFIX) ? path : ''
}

function editorImgHtml(url, alt) {
  const clean = canonicalAttachUrl(url)
  if (!clean) return ''
  const name = alt || '图片'
  return `<img src="${escapeHtml(attachmentUrl(clean))}" data-url="${escapeHtml(clean)}" alt="${escapeHtml(name)}" class="${EDIT_IMG_CLS}" contenteditable="false">`
}

function insertEditorImage(root, url, alt) {
  const html = editorImgHtml(url, alt)
  if (!html || !root) return
  const holder = document.createElement('div')
  holder.innerHTML = html
  const img = holder.firstChild
  if (!img) return
  const sel = window.getSelection()
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  const inRoot = range && root.contains(range.commonAncestorContainer)
  root.focus()
  if (inRoot) {
    range.deleteContents()
    range.insertNode(img)
    range.setStartAfter(img)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    return
  }
  root.appendChild(img)
}

// markdown → 安全 HTML：文本段转义 + 换行转 <br>；图片引用仅放行本系统附件路径
// 编辑器内的 <img> 需追加 query token 才能真正加载（无法带 Authorization 头）
function mdToHtml(v) {
  const s = String(v ?? '')
  let html = ''
  let last = 0
  const pushText = (t) => { html += escapeHtml(t).split('\n').join('<br>') }
  for (const m of s.matchAll(IMG_MD_RE)) {
    if (m.index > last) pushText(s.slice(last, m.index))
    const imgHtml = editorImgHtml(m[2], m[1] || '图片')
    if (imgHtml) html += imgHtml
    else pushText(m[0])
    last = m.index + m[0].length
  }
  if (last < s.length) pushText(s.slice(last))
  return html
}

// DOM 节点 → markdown：文本原样、<br>→换行、<img>→图片引用（仅本系统附件）、其余标签剥格式取文本
function nodeToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue
  const tag = node.nodeName
  if (tag === 'BR') return '\n'
  if (tag === 'IMG') {
    // src 含运行时追加的 query token（仅供展示），导出数据层须剥离只留干净附件路径（优先取 data-url）
    const src = canonicalAttachUrl(node.getAttribute('data-url') || node.getAttribute('src') || '')
    if (!src) return ''
    return `![${node.getAttribute('alt') || '图片'}](${src})`
  }
  let out = ''
  node.childNodes.forEach((c) => { out += nodeToMd(c) })
  if (tag === 'DIV' || tag === 'P') out += '\n'
  return out
}

function htmlToMd(rootEl) {
  let out = ''
  rootEl.childNodes.forEach((c) => { out += nodeToMd(c) })
  return out
}

// 画廊式图片放大预览（Portal 挂 body，编辑器/只读视图共用）
// images: [{ src, name }]；index: 当前张；onIndex(i): 切换；onClose(): 关闭
// 多张时提供 ←/→ 键盘循环切换、左右箭头按钮、n / N 计数、底部缩略图导航条；单张保持旧版精简形态
export function Lightbox({ images, index, onIndex, onClose }) {
  const stripRef = useRef(null)
  const list = images || []
  const single = list.length <= 1
  const safeIndex = Math.min(Math.max(index, 0), Math.max(list.length - 1, 0))
  const cur = list[safeIndex]

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (!single && e.key === 'ArrowLeft') onIndex((safeIndex - 1 + list.length) % list.length)
      else if (!single && e.key === 'ArrowRight') onIndex((safeIndex + 1) % list.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [safeIndex, list, single, onIndex, onClose])

  // 缩略图条滚动跟随当前张（仅横向滚动导航条本身，不影响遮罩层）
  useEffect(() => {
    if (single || !stripRef.current) return
    const el = stripRef.current.querySelector(`[data-thumb="${safeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [safeIndex, single])

  if (!cur) return null
  return createPortal(
    <div className="fixed inset-0 z-[200] flex select-none flex-col items-center justify-center gap-3 bg-black/85 p-8"
      onClick={onClose}>
      <div className="max-w-[85vw] truncate text-sm text-white/85">{cur.name || '图片'}</div>
      <img src={cur.src} alt={cur.name || '图片'} className="max-h-[78vh] max-w-[90vw] cursor-zoom-out rounded-md border border-white/20 object-contain"
        onClick={(e) => e.stopPropagation()} onDoubleClick={onClose} />
      {!single && (
        <>
          <button type="button" aria-label="上一张" title="上一张"
            onClick={(e) => { e.stopPropagation(); onIndex((safeIndex - 1 + list.length) % list.length) }}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white/80 transition hover:bg-white/20 hover:text-white">
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button type="button" aria-label="下一张" title="下一张"
            onClick={(e) => { e.stopPropagation(); onIndex((safeIndex + 1) % list.length) }}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white/80 transition hover:bg-white/20 hover:text-white">
            <ChevronRight className="h-6 w-6" />
          </button>
          <div className="text-xs tabular-nums text-white/70">{safeIndex + 1} / {list.length}</div>
          <div ref={stripRef} data-allow-scroll onClick={(e) => e.stopPropagation()}
            className="flex max-w-[90vw] gap-1.5 overflow-x-auto">
            {list.map((it, i) => (
              <img key={i} data-thumb={i} src={it.src} alt={it.name || '图片'} loading="lazy"
                onClick={() => onIndex(i)}
                className={`h-12 w-12 shrink-0 cursor-pointer rounded-md border object-cover transition ${
                  i === safeIndex ? 'border-white/80 ring-2 ring-white/80' : 'border-white/20 opacity-60 hover:opacity-90'}`} />
            ))}
          </div>
        </>
      )}
      <div className="text-xs text-white/50">
        {single
          ? '双击图片或点击空白处关闭（Esc 同样生效）'
          : '← / → 或点击箭头切换图片；点击空白处或 Esc 关闭'}
      </div>
    </div>,
    document.body,
  )
}

// 只读富文本展示：文本保留换行；图片分级排版——少量（≤3 张）内联限高 160px，
// 多图（≥4 张）收敛为九宫格缩略图网格（>9 张默认收起为 +N 块，点击展开），
// 单击图片打开画廊式 Lightbox（全量图片、可切换），避免多图把节点卡片撑得过高
export function RichTextView({ text }) {
  const [lightbox, setLightbox] = useState(null) // 当前打开的图片索引
  const [showAll, setShowAll] = useState(false)
  const s = String(text ?? '')
  const matches = [...s.matchAll(IMG_MD_RE)]
  if (!matches.length) return <span className="break-all">{s}</span>
  // 仅放行本系统附件路径：外链图片引用不加载（防止把当前用户 JWT 以 query
  // token 追加到第三方 URL 泄露凭证），白名单外的引用按原文本展示（与编辑端 mdToHtml 同口径）
  const images = matches.map((m) => {
    const clean = canonicalAttachUrl(m[2])
    return { src: clean ? attachmentUrl(clean) : null, name: m[1] || '图片' }
  })

  // Lightbox 与缩略图仅收录放行通过的附件图；validIndex[i] 为 -1 表示该引用按文本展示
  const validImages = []
  const validIndex = new Array(images.length).fill(-1)
  images.forEach((im, i) => {
    if (im.src) {
      validIndex[i] = validImages.length
      validImages.push(im)
    }
  })

  const lightboxEl = lightbox !== null && (
    <Lightbox images={validImages} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
  )

  // 少量图：文本与图片按原顺序交错（图片位置不挪动），内联图限高 160px
  if (validImages.length <= 3) {
    const parts = []
    let last = 0
    matches.forEach((m, i) => {
      if (m.index > last) parts.push(<span key={`t${i}`} className="whitespace-pre-wrap break-all">{s.slice(last, m.index)}</span>)
      parts.push(
        validIndex[i] >= 0
          ? <img key={`i${i}`} src={images[i].src} alt={images[i].name} loading="lazy" title="点击查看大图"
            className="my-1 block max-h-40 w-fit max-w-full cursor-zoom-in rounded-md border border-border object-contain"
            onClick={() => setLightbox(validIndex[i])} />
          : <span key={`x${i}`} className="whitespace-pre-wrap break-all">{m[0]}</span>,
      )
      last = m.index + m[0].length
    })
    if (last < s.length) parts.push(<span key="tail" className="whitespace-pre-wrap break-all">{s.slice(last)}</span>)
    return (
      <div className="space-y-1">
        {parts}
        {lightboxEl}
      </div>
    )
  }

  // 多图：文本段集中在前，图片统一收纳为九宫格缩略图网格（白名单外的引用按文本保留在文本段）
  const textParts = []
  let last = 0
  matches.forEach((m, i) => {
    if (m.index > last) textParts.push(<span key={`t${i}`} className="whitespace-pre-wrap break-all">{s.slice(last, m.index)}</span>)
    if (validIndex[i] < 0) textParts.push(<span key={`x${i}`} className="whitespace-pre-wrap break-all">{m[0]}</span>)
    last = m.index + m[0].length
  })
  if (last < s.length) textParts.push(<span key="tail" className="whitespace-pre-wrap break-all">{s.slice(last)}</span>)

  const MAX_THUMBS = 9
  const overflow = validImages.length - MAX_THUMBS
  const collapsed = !showAll && overflow > 0
  const shown = collapsed ? validImages.slice(0, MAX_THUMBS) : validImages
  return (
    <div className="space-y-2">
      {textParts.length > 0 && <div className="space-y-1">{textParts}</div>}
      <div className="text-xs text-muted-foreground">图片 · {validImages.length} 张</div>
      <div className="flex flex-wrap gap-2">
        {shown.map((img, i) => (
          <img key={i} src={img.src} alt={img.name} loading="lazy" title="点击查看大图"
            className="h-24 w-24 cursor-zoom-in rounded-md border border-border object-cover transition hover:border-primary/50"
            onClick={() => setLightbox(i)} />
        ))}
        {collapsed && (
          <button type="button" onClick={() => setShowAll(true)} title={`展开剩余 ${overflow} 张`}
            className="flex h-24 w-24 cursor-pointer items-center justify-center rounded-md border border-border bg-muted text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground">
            +{overflow}
          </button>
        )}
      </div>
      {lightboxEl}
    </div>
  )
}

// 所见即所得富文本输入框（工单 textarea 类型字段 / 处理意见 / 发起备注）
// value 为 markdown 格式纯文本；粘贴截图自动上传并在光标处插入图片本体（非 URL 文本）
export function RichEditable({ value, onChange, placeholder, className, minHeight = 64 }) {
  const ref = useRef(null)
  const lastExported = useRef(undefined)
  const [lightbox, setLightbox] = useState(null)
  const [pasting, setPasting] = useState(false)

  // 挂载：按初始值渲染内容（调用方 key 已含节点/流程前缀，切换时重挂载保证同步）
  useEffect(() => {
    lastExported.current = value ?? ''
    if (ref.current) ref.current.innerHTML = mdToHtml(value ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部值变化时同步 DOM：聚焦编辑中不重写（避免光标跳动），清空场景强制同步
  useEffect(() => {
    if (value === lastExported.current) return
    if (document.activeElement === ref.current && value !== '') return
    lastExported.current = value ?? ''
    if (ref.current) ref.current.innerHTML = mdToHtml(value ?? '')
  }, [value])

  const exportMd = () => {
    const md = ref.current ? htmlToMd(ref.current) : ''
    // 内容清空时移除残留空标签，恢复 placeholder
    if (!md && ref.current && !ref.current.querySelector('img') && !ref.current.innerText.trim()) {
      ref.current.innerHTML = ''
    }
    lastExported.current = md
    onChange(md)
  }

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items || pasting) return
    // 剪贴板同时含文本时不拦截（如从 Excel/网页复制），仅拦截纯截图/图片粘贴
    let hasText = false
    let imgItem = null
    for (const it of items) {
      if (it.kind === 'string' && it.type === 'text/plain') hasText = true
      if (it.kind === 'file' && it.type.startsWith('image/')) imgItem = imgItem || it
    }
    if (hasText || !imgItem) return
    const imgFile = imgItem.getAsFile()
    if (!imgFile) return
    e.preventDefault()
    setPasting(true)
    try {
      const ext = (imgFile.type.split('/')[1] || '').toLowerCase().replaceAll('jpeg', 'jpg')
      if (!ATTACHMENT_EXTS.includes(ext)) {
        toast.error(`不支持的图片类型（${imgFile.type}），请另存为 ${ATTACHMENT_EXTS.slice(0, 6).join(' / ')} 后粘贴`)
        return
      }
      const stamp = new Date().toISOString().slice(0, 19).split('-').join('').split(':').join('').split('T').join('')
      const file = new File([imgFile], `截图-${stamp}.${ext}`, { type: imgFile.type })
      const res = await ticketApi.uploadAttachment(file)
      if (!canonicalAttachUrl(res.url)) {
        toast.error('图片已上传，但返回地址无法预览')
        return
      }
      insertEditorImage(ref.current, res.url, res.name || '截图')
      exportMd()
      toast.success('截图已插入')
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        toast.error('截图上传超时，请重试；请确认截图文件可正常读取')
      } else {
        toast.error(err.message || '图片上传失败')
      }
    } finally {
      setPasting(false)
    }
  }

  const handleDblClick = (e) => {
    const t = e.target
    if (t?.tagName === 'IMG') {
      e.preventDefault()
      const clean = canonicalAttachUrl(t.getAttribute('data-url') || t.getAttribute('src') || '')
      if (!clean) return
      setLightbox({ src: attachmentUrl(clean), name: t.getAttribute('alt') || '图片' })
    }
  }

  return (
    <>
      <style>{'.rich-editable:empty::before{content:attr(data-placeholder);color:var(--muted-foreground);pointer-events:none;}'}</style>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        data-placeholder={placeholder || ''}
        onInput={exportMd}
        onPaste={handlePaste}
        onDoubleClick={handleDblClick}
        className={`rich-editable cursor-text overflow-y-auto whitespace-pre-wrap break-words ${className || ''}`}
        style={{ minHeight }}
      />
      {/* 编辑器内仅单张上下文：走 Lightbox 单图模式（无箭头/计数），保持双击打开防误触 */}
      {lightbox && <Lightbox images={[lightbox]} index={0} onIndex={() => {}} onClose={() => setLightbox(null)} />}
    </>
  )
}
