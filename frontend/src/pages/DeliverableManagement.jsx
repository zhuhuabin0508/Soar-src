// 材料管理页：左侧树形目录（最多 10 级） + 右侧材料文件列表
// 功能：树形目录 CRUD / 子目录创建 / 多文件上传(白名单) / 预览 / 在线编辑 / 单/批量下载 / 删除
// 权限：deliverable.view 可见/预览；.edit 可建目录/上传/编辑/在线修改；.delete 可删除
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2, ChevronDown, ChevronRight, ChevronsUp, CloudUpload, Download,
  Eye, FileArchive, FileSpreadsheet, FileText, Folder, FolderArchive, FolderOpen,
  FolderPlus, HardDrive, LayoutGrid, List, Loader2, MoreVertical, Move,
  Pencil, Plus, RefreshCw, Save, Search, Trash2, Upload, X, XCircle,
} from 'lucide-react'
import { deliverablesApi } from '../api/client'
import { toast } from '../store/toastStore'
import {PageContainer, Button, EmptyState, Pagination, CompactSelect, AutoGrowTextarea } from '../components/ui'
import { confirm } from '../components/ConfirmDialog'
import { hasPermission } from '../utils/permissions'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { DELIVERABLE_TUTORIAL } from '../components/tutorialContent'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'
const OfficePreview = lazy(() => import('../components/OfficePreview'))

const PAGE_SIZE = 20
const MAX_LEVEL = 10
// 与后端 ALLOWED_EXTENSIONS 保持一致
const ALLOWED_EXTS = ['xlsx', 'xls', 'doc', 'docx', 'ppt', 'pptx', 'pdf', 'zip', 'rar', '7z', 'txt', 'csv', 'md']
const MAX_SIZE = 200 * 1024 * 1024
// 可在线预览的文件扩展名
const PREVIEW_PDF_EXTS = ['pdf']
const TEXT_EDIT_EXTS = ['txt', 'csv', 'md']
const OFFICE_PREVIEW_EXTS = ['docx', 'xlsx', 'xls']
const LEGACY_OFFICE_EXTS = ['doc']
const PREVIEWABLE_EXTS = ['pdf', 'txt', 'csv', 'md', 'docx', 'xlsx', 'xls', 'doc']
const OFFICE_PREVIEW_MAX = 25 * 1024 * 1024

// 材料类型分布 chips：类型 → 彩色圆点 / 激活态配色（状态指标条点击可筛选当前页）
const TYPE_CHIPS = [
  { key: 'doc', label: '文档', dot: 'bg-blue-500', activeCls: 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/40', exts: ['doc', 'docx'] },
  { key: 'sheet', label: '表格', dot: 'bg-emerald-500', activeCls: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40', exts: ['xlsx', 'xls', 'csv'] },
  { key: 'slide', label: '演示', dot: 'bg-orange-500', activeCls: 'bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/40', exts: ['ppt', 'pptx'] },
  { key: 'pdf', label: 'PDF', dot: 'bg-rose-500', activeCls: 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/40', exts: ['pdf'] },
  { key: 'archive', label: '压缩包', dot: 'bg-amber-500', activeCls: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40', exts: ['zip', 'rar', '7z'] },
  { key: 'text', label: '文本', dot: 'bg-zinc-500', activeCls: 'bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-500/40', exts: ['txt', 'md'] },
]
const typeChipOf = (key) => TYPE_CHIPS.find((c) => c.key === key)

// 扩展名 → 图标/颜色
function FileIcon({ ext, className = 'h-4 w-4' }) {
  if (['xlsx', 'xls', 'csv'].includes(ext)) return <FileSpreadsheet className={`${className} text-emerald-500`} />
  if (['doc', 'docx'].includes(ext)) return <FileText className={`${className} text-blue-500`} />
  if (['ppt', 'pptx'].includes(ext)) return <FileText className={`${className} text-orange-500`} />
  if (['zip', 'rar', '7z'].includes(ext)) return <FileArchive className={`${className} text-amber-500`} />
  return <FileText className={`${className} text-muted-foreground`} />
}

function fmtSize(bytes) {
  if (bytes == null) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 校验上传文件（前端预检，后端仍强校验）
function validateFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!ALLOWED_EXTS.includes(ext)) {
    return `不支持的文件类型 .${ext}（允许：${ALLOWED_EXTS.join(' / ')}）`
  }
  if (file.size > MAX_SIZE) return `文件大小不能超过 200MB（当前 ${fmtSize(file.size)}）`
  if (file.size === 0) return '文件内容为空'
  return ''
}

const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function isJunkFile(name) {
  const n = (name || '').toLowerCase()
  return !n || JUNK_FILE_NAMES.has(n) || n.startsWith('~$') || n.startsWith('.')
}

function normalizeRelPath(file, explicitPath) {
  const raw = String(explicitPath || file.webkitRelativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw || !raw.includes('/')) return file.name
  return raw
}

function toUploadItem(file, explicitPath) {
  const relativePath = normalizeRelPath(file, explicitPath)
  if (isJunkFile(file.name)) return null
  const err = validateFile(file)
  return {
    file,
    relativePath,
    status: err ? 'failed' : 'pending',
    error: err || '',
  }
}

function dirKeyOf(relativePath) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = []
    const pump = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all)
        all.push(...batch)
        pump()
      }, reject)
    }
    pump()
  })
}

async function walkEntry(entry, prefix = '') {
  const items = []
  if (!entry) return items
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej))
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name
    const item = toUploadItem(file, relativePath)
    if (item) items.push(item)
    return items
  }
  if (entry.isDirectory) {
    const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name
    const children = await readAllEntries(entry.createReader())
    for (const child of children) {
      items.push(...await walkEntry(child, dirPath))
    }
  }
  return items
}

async function collectDroppedItems(dataTransfer) {
  const entries = Array.from(dataTransfer.items || [])
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean)
  if (entries.length > 0) {
    const collected = []
    for (const entry of entries) {
      collected.push(...await walkEntry(entry))
    }
    return collected
  }
  return Array.from(dataTransfer.files || []).map((file) => toUploadItem(file)).filter(Boolean)
}

// 从扁平列表构建树：{ id, name, parent_id, level, children: [] }
function buildTree(items) {
  const map = new Map()
  const roots = []
  items.forEach((it) => {
    map.set(it.id, { ...it, children: [] })
  })
  map.forEach((node) => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

// 把目录树按「展开状态」拍平成带 depth 的行列表 —— 真正的树：只有父级处于展开态时，
// 其子级才会出现在列表里（默认只展示第一层，点箭头逐级展开）。
//
// 注意：递归只用于「算数据」（在 useMemo 里调用），渲染层始终是平铺的 map。
// 千万不要在 JSX 里写递归渲染函数，那会触发
// "Functions are not valid as a React child"，导致弹窗整个打不开。
//
// 性能：先建 parent_id → 子节点 的索引（O(n)），再自顶向下遍历，
// 不在递归里做线性查找（旧实现对每个节点都扫描一遍全表，是 O(n²)）。
function flattenTree(selectable, expandedSet) {
  const idSet = new Set()
  for (const c of selectable) idSet.add(c.id)

  const childrenByParent = new Map()
  const roots = []
  for (const c of selectable) {
    // 父级不在可选集内（被排除）的节点，按根级处理，保证不会整棵消失
    const pid = c.parent_id != null && idSet.has(c.parent_id) ? c.parent_id : null
    if (pid === null) {
      roots.push(c)
    } else {
      const arr = childrenByParent.get(pid)
      if (arr) arr.push(c)
      else childrenByParent.set(pid, [c])
    }
  }

  const flat = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const kids = childrenByParent.get(n.id)
      const hasChildren = !!kids && kids.length > 0
      flat.push({ id: n.id, name: n.name, level: n.level, depth, hasChildren })
      if (hasChildren && expandedSet.has(n.id)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return flat
}

// 在 selectable 里「有子级」的节点 id，用于「展开全部」。O(n)。
function expandableIdsOf(selectable) {
  const idSet = new Set()
  for (const c of selectable) idSet.add(c.id)
  const parents = new Set()
  for (const c of selectable) {
    if (c.parent_id != null && idSet.has(c.parent_id)) parents.add(c.parent_id)
  }
  return [...parents]
}

// 通用小 Modal
function Modal({ title, children, onClose, footer, wide = false }) {
  useLockBackgroundScroll(true)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        data-allow-scroll
        className={`max-h-[90vh] w-full overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-5 shadow-xl ${wide ? 'max-w-xl' : 'max-w-md'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

// 输入行
function Field({ label, children, hint }) {
  return (
    <div className="mb-3">
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary'

export default function DeliverableManagement() {
  // 权限
  const canEdit = hasPermission('deliverable', 'edit')
  const canDelete = hasPermission('deliverable', 'delete')

  // 目录类别状态（扁平列表，前端构建树）
  const [categories, setCategories] = useState([])
  const [totalDeliverables, setTotalDeliverables] = useState(0)
  const [catLoading, setCatLoading] = useState(false)
  const [activeCatId, setActiveCatId] = useState(null)
  // 展开的节点 ID 集合
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  // 类别弹窗：{ mode, id?, name, description, parentId, parentName?, parentLevel }
  const [catModal, setCatModal] = useState(null)
  const [catSaving, setCatSaving] = useState(false)

  // 材料状态
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  // 材料类型快速筛选（仅前端过滤当前页，点击指标条 chips 切换）
  const [typeFilter, setTypeFilter] = useState('')
  const [loading, setLoading] = useState(false)

  // 批量选择（selectedIds=材料文件，selectedCatIds=子目录）
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [selectedCatIds, setSelectedCatIds] = useState(() => new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  // 批量移动弹窗：{ targetCategoryId } | null
  const [batchMoveModal, setBatchMoveModal] = useState(null)
  const [batchMoving, setBatchMoving] = useState(false)

  // 上传弹窗：{ files: [{ file, status }], version, description }
  // status: 'pending' | 'uploading' | 'success' | 'failed'
  const [uploadModal, setUploadModal] = useState(null)
  const [uploading, setUploading] = useState(false)
  // 编辑弹窗：{ id, name, version, description, file, filename }
  const [editModal, setEditModal] = useState(null)
  const [editSaving, setEditSaving] = useState(false)

  // 预览/编辑弹窗：{ row, type: 'pdf'|'text'|'office'|'unsupported', loading, content, blobUrl, arrayBuffer, error, dirty, saving }
  const [previewModal, setPreviewModal] = useState(null)
  const [previewSaving, setPreviewSaving] = useState(false)
  // 移动目录弹窗：{ id, name, description, currentParentId, targetParentId }
  const [moveModal, setMoveModal] = useState(null)
  const [moveSaving, setMoveSaving] = useState(false)
  // 目标目录树的展开节点（点击箭头逐级展开，默认只展示第一层）
  const [moveExpandedIds, setMoveExpandedIds] = useState(() => new Set())
  const [batchMoveExpandedIds, setBatchMoveExpandedIds] = useState(() => new Set())

  // 视图模式：list / grid
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('soar_dlv_view') || 'list')
  // 右键菜单：{ x, y, node } | null
  const [contextMenu, setContextMenu] = useState(null)
  // 拖拽上传高亮
  const [dragOver, setDragOver] = useState(false)
  // 新建目录：保存并继续
  const [saveContinue, setSaveContinue] = useState(false)
  // 目录树宽度（可拖拽调节，持久化）
  const [treeWidth, setTreeWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('soar_dlv_tree_w'))
    return saved && saved >= 180 && saved <= 520 ? saved : 288
  })
  const [treeResizing, setTreeResizing] = useState(false)
  // 拖拽起始位置记录
  const resizeStartRef = useRef({ x: 0, width: 0 })

  const [deleting, setDeleting] = useState(false)
  // 目录导出中（记录正在导出的目录 ID，禁用按钮防重复点击）
  const [exportingCatId, setExportingCatId] = useState(null)
  const [exportProgress, setExportProgress] = useState(null) // { phase: 'packing'|'downloading', percent: 0-100, loaded: bytes, name: '' }
  // 使用教程抽屉
  const [tutorialOpen, setTutorialOpen] = useState(false)

  // 目录索引：id → 目录、parent_id → 直接子目录 id 列表。
  // 统一在这里建一次（O(n)），后续所有"找父级/找子级/找后代"都查它，
  // 避免各处反复 categories.find / categories.filter 造成的 O(n²)。
  const catIndex = useMemo(() => {
    const byId = new Map()
    const childrenByParent = new Map()
    for (const c of categories) {
      byId.set(c.id, c)
      if (c.parent_id != null) {
        const arr = childrenByParent.get(c.parent_id)
        if (arr) arr.push(c.id)
        else childrenByParent.set(c.parent_id, [c.id])
      }
    }
    return { byId, childrenByParent }
  }, [categories])

  // 构建树
  const tree = useMemo(() => buildTree(categories), [categories])
  const activeCat = catIndex.byId.get(activeCatId) || null
  const totalFiles = totalDeliverables

  // 面包屑路径：从根到当前目录（用索引取父级，O(depth)）
  const breadcrumbPath = useMemo(() => {
    if (!activeCat) return []
    const path = []
    let current = activeCat
    let safety = 0
    while (current && safety < MAX_LEVEL) {
      path.unshift(current)
      current = current.parent_id != null ? catIndex.byId.get(current.parent_id) : null
      safety++
    }
    return path
  }, [activeCat, catIndex])

  // 当前目录的直接子目录（随列表/网格视图切换展示）
  const subCategories = useMemo(() => {
    if (!activeCatId) return []
    const kids = catIndex.childrenByParent.get(activeCatId)
    if (!kids) return []
    return kids.map((id) => catIndex.byId.get(id)).filter(Boolean)
  }, [activeCatId, catIndex])
  const showFolders = subCategories.length > 0 && !search && !typeFilter

  // 类型分布统计：从当前页 rows 派生（不新增 API 请求），驱动指标条 chips 计数
  const typeStats = useMemo(() => {
    const stats = { doc: 0, sheet: 0, slide: 0, pdf: 0, archive: 0, text: 0 }
    for (const r of rows) {
      const ext = (r.file_ext || '').toLowerCase()
      const chip = TYPE_CHIPS.find((c) => c.exts.includes(ext))
      if (chip) stats[chip.key] += 1
    }
    return stats
  }, [rows])

  // 类型筛选后的展示行（仅前端过滤当前页，不影响服务端分页/搜索）
  const displayRows = useMemo(
    () =>
      typeFilter
        ? rows.filter((r) => (typeChipOf(typeFilter)?.exts || []).includes((r.file_ext || '').toLowerCase()))
        : rows,
    [rows, typeFilter]
  )

  // 当前页可勾选集合 = 材料行 + 子目录行（子目录也可被选中后批量移动）
  const pageFolderIds = useMemo(
    () => (showFolders ? subCategories.map((c) => c.id) : []),
    [showFolders, subCategories]
  )
  const selectedTotal = selectedIds.size + selectedCatIds.size
  const allChecked =
    (rows.length > 0 || pageFolderIds.length > 0)
    && rows.every((r) => selectedIds.has(r.id))
    && pageFolderIds.every((id) => selectedCatIds.has(id))
  const someChecked =
    rows.some((r) => selectedIds.has(r.id))
    || pageFolderIds.some((id) => selectedCatIds.has(id))

  // 双击进入子目录
  const enterSubCategory = useCallback((cat) => {
    setActiveCatId(cat.id)
    setPage(1)
    // 同步展开树
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.add(cat.id)
      return next
    })
  }, [])

  // 切换视图模式（持久化）
  const changeViewMode = (mode) => {
    setViewMode(mode)
    localStorage.setItem('soar_dlv_view', mode)
  }

  // 关闭右键菜单（全局点击）
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  // 目录树宽度拖拽：监听全局 mousemove / mouseup
  useEffect(() => {
    if (!treeResizing) return
    const onMove = (e) => {
      e.preventDefault()
      const delta = e.clientX - resizeStartRef.current.x
      const newWidth = Math.min(520, Math.max(180, resizeStartRef.current.width + delta))
      setTreeWidth(newWidth)
    }
    const onUp = () => {
      setTreeResizing(false)
      setTreeWidth((w) => {
        localStorage.setItem('soar_dlv_tree_w', String(w))
        return w
      })
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [treeResizing])

  // 开始拖拽
  const handleResizeStart = (e) => {
    e.preventDefault()
    resizeStartRef.current = { x: e.clientX, width: treeWidth }
    setTreeResizing(true)
  }

  // 持久化展开状态
  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('soar_dlv_expanded', JSON.stringify([...next]))
      return next
    })
  }, [])

  // ===== 数据加载 =====
  const loadCategories = useCallback(async (keepActive = true) => {
    setCatLoading(true)
    try {
      const res = await deliverablesApi.categories()
      const items = res.items || []
      setCategories(items)
      setTotalDeliverables(res.total_deliverables || 0)
      if (keepActive && items.some((c) => c.id === activeCatId)) return
      setActiveCatId(items.length > 0 ? items[0].id : null)
    } catch (err) {
      toast.error(err.message || '加载目录类别失败')
    } finally {
      setCatLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCatId])

  const loadDeliverables = useCallback(async () => {
    if (!activeCatId) {
      setRows([])
      setTotal(0)
      return
    }
    setLoading(true)
    try {
      const res = await deliverablesApi.list({
        category_id: activeCatId,
        search,
        page,
        size: pageSize,
      })
      setRows(res.items || [])
      setTotal(res.total || 0)
    } catch (err) {
      toast.error(err.message || '加载材料失败')
    } finally {
      setLoading(false)
    }
  }, [activeCatId, search, page, pageSize])

  useEffect(() => {
    loadCategories(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    loadDeliverables()
  }, [loadDeliverables])

  // 切换类别时清空选择
  useEffect(() => {
    setSelectedIds(new Set())
    setSelectedCatIds(new Set())
  }, [activeCatId, page, pageSize, search])

  // 切换目录时重置类型快速筛选，避免新目录被旧筛选遮挡
  useEffect(() => {
    setTypeFilter('')
  }, [activeCatId])

  // 打开「移动目录」/「批量移动」弹窗时重置目录树展开状态：默认只展示第一层，
  // 由用户点箭头逐级展开（避免一次性铺开上百行）
  useEffect(() => {
    setMoveExpandedIds(new Set())
  }, [moveModal?.id])

  useEffect(() => {
    setBatchMoveExpandedIds(new Set())
  }, [batchMoveModal !== null])

  // ===== 目录类别操作 =====
  const handleCatSave = async (continueMode = false) => {
    if (!catModal?.name.trim()) {
      toast.warning('请输入目录名称')
      return
    }
    setCatSaving(true)
    try {
      const parentId = catModal.parentId || 0
      if (catModal.mode === 'create') {
        await deliverablesApi.createCategory(catModal.name.trim(), catModal.description.trim(), parentId)
        toast.success(parentId ? '子目录已创建' : '目录已创建')
        // 自动展开父节点
        if (parentId) {
          setExpandedIds((prev) => {
            const next = new Set(prev)
            next.add(parentId)
            localStorage.setItem('soar_dlv_expanded', JSON.stringify([...next]))
            return next
          })
        }
        if (continueMode) {
          // 保存并继续：清空名称，保留父级和描述
          setCatModal((prev) => ({ ...prev, name: '', description: '' }))
          await loadCategories()
        } else {
          setCatModal(null)
          await loadCategories()
        }
      } else {
        await deliverablesApi.updateCategory(catModal.id, catModal.name.trim(), catModal.description.trim())
        toast.success('目录已更新')
        setCatModal(null)
        await loadCategories()
      }
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setCatSaving(false)
    }
  }

  const handleConfirmDelete = async (target) => {
    if (!target || deleting) return
    const isCat = target.type === 'category'
    const ok = await confirm({
      title: isCat ? `删除目录「${target.name}」？` : `删除材料「${target.name}」？`,
      message: isCat
        ? '删除后不可恢复。目录下有子目录或材料时将被拒绝。'
        : `将同时删除文件「${target.filename}」，操作不可恢复。`,
      confirmText: '确认删除',
    })
    if (!ok) return
    setDeleting(true)
    try {
      if (isCat) {
        await deliverablesApi.deleteCategory(target.id)
        toast.success('目录已删除')
        await loadCategories()
      } else {
        await deliverablesApi.remove(target.id)
        toast.success('材料已删除')
        await loadDeliverables()
        await loadCategories()
      }
    } catch (err) {
      toast.error(err.message || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  // ===== 材料操作 =====
  const handleUpload = async () => {
    const files = uploadModal?.files || []
    const pending = files.filter((f) => f.status === 'pending')
    if (pending.length === 0) {
      toast.warning('请先选择可上传的文件')
      return
    }

    setUploading(true)
    let successCount = 0
    let failCount = 0
    for (const item of pending) {
      // 标记为 uploading
      setUploadModal((prev) => ({
        ...prev,
        files: prev.files.map((f) =>
          f === item ? { ...f, status: 'uploading' } : f
        ),
      }))
      try {
        await deliverablesApi.upload(activeCatId, item.file, {
          name: item.file.name.replace(/\.[^.]+$/, ''),
          version: uploadModal.version.trim(),
          description: uploadModal.description.trim(),
          relativePath: item.relativePath && item.relativePath.includes('/')
            ? item.relativePath
            : '',
        })
        successCount++
        setUploadModal((prev) => ({
          ...prev,
          files: prev.files.map((f) =>
            f === item ? { ...f, status: 'success' } : f
          ),
        }))
      } catch (e) {
        failCount++
        const errMsg = e.message || '上传失败'
        setUploadModal((prev) => ({
          ...prev,
          files: prev.files.map((f) =>
            f === item ? { ...f, status: 'failed', error: errMsg } : f
          ),
        }))
      }
    }

    setUploading(false)
    if (failCount === 0) {
      toast.success(`全部 ${successCount} 个文件上传成功`)
      setUploadModal(null)
    } else if (successCount === 0) {
      toast.error(`全部 ${failCount} 个文件上传失败`)
    } else {
      toast.warning(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }
    await loadDeliverables()
    await loadCategories()
  }

  const handleEditSave = async () => {
    if (!editModal?.name.trim()) {
      toast.warning('请输入材料名称')
      return
    }
    if (editModal.file) {
      const err = validateFile(editModal.file)
      if (err) {
        toast.error(err)
        return
      }
    }
    setEditSaving(true)
    try {
      await deliverablesApi.update(
        editModal.id,
        {
          name: editModal.name.trim(),
          version: editModal.version.trim(),
          description: editModal.description.trim(),
        },
        editModal.file || null
      )
      toast.success('材料已更新')
      setEditModal(null)
      await loadDeliverables()
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDownload = async (row) => {
    try {
      await deliverablesApi.download(row.id, row.filename)
      toast.success('开始下载')
    } catch (err) {
      toast.error(err.message || '下载失败')
    }
  }

  // ===== 预览 / 在线编辑 =====
  const handlePreview = async (row) => {
    const ext = (row.file_ext || '').toLowerCase()
    if (PREVIEW_PDF_EXTS.includes(ext)) {
      // PDF：fetch blob → iframe 预览
      setPreviewModal({ row, type: 'pdf', loading: true, blobUrl: null, error: null })
      try {
        const url = await deliverablesApi.previewBlob(row.id)
        setPreviewModal((prev) => ({ ...prev, loading: false, blobUrl: url }))
      } catch (err) {
        setPreviewModal((prev) => ({ ...prev, loading: false, error: err.message || '预览加载失败' }))
      }
    } else if (TEXT_EDIT_EXTS.includes(ext)) {
      // 文本：fetch content → 编辑器
      setPreviewModal({ row, type: 'text', loading: true, content: '', original: '', dirty: false, error: null })
      try {
        const res = await deliverablesApi.getContent(row.id)
        setPreviewModal((prev) => ({
          ...prev,
          loading: false,
          content: res.content || '',
          original: res.content || '',
          dirty: false,
        }))
      } catch (err) {
        setPreviewModal((prev) => ({ ...prev, loading: false, error: err.message || '内容加载失败' }))
      }
    } else if (LEGACY_OFFICE_EXTS.includes(ext)) {
      setPreviewModal({
        row,
        type: 'unsupported',
        loading: false,
        error: '旧版 Word（.doc）无法在线预览，请另存为 .docx 后重新上传，或下载后打开',
      })
    } else if (OFFICE_PREVIEW_EXTS.includes(ext)) {
      if (row.file_size && row.file_size > OFFICE_PREVIEW_MAX) {
        setPreviewModal({
          row,
          type: 'unsupported',
          loading: false,
          error: `文件超过 25MB（${fmtSize(row.file_size)}），请下载后查看`,
        })
        return
      }
      setPreviewModal({ row, type: 'office', loading: true, arrayBuffer: null, error: null })
      try {
        const buf = await deliverablesApi.previewArrayBuffer(row.id)
        setPreviewModal((prev) => ({ ...prev, loading: false, arrayBuffer: buf }))
      } catch (err) {
        setPreviewModal((prev) => ({ ...prev, loading: false, error: err.message || '预览加载失败' }))
      }
    } else {
      // 其他类型：不支持预览，提示下载
      setPreviewModal({ row, type: 'unsupported', loading: false, error: null })
    }
  }

  const closePreview = () => {
    if (previewModal?.blobUrl) {
      URL.revokeObjectURL(previewModal.blobUrl)
    }
    setPreviewModal(null)
  }

  const overlayPreview = previewModal && previewModal.type !== 'text'
  useLockBackgroundScroll(!!overlayPreview)

  useEffect(() => {
    if (!overlayPreview) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setPreviewModal((prev) => {
        if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl)
        return null
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayPreview])

  // ===== 移动目录 =====
  // 计算某节点的所有后代 ID（用于移动时排除不可选目标）。
  // 走 catIndex 的 childrenByParent 索引，复杂度只跟子树规模有关，不再全表扫描。
  const getDescendantIds = useCallback(
    (nodeId) => {
      const result = new Set()
      const { childrenByParent } = catIndex
      let frontier = [nodeId]
      for (let i = 0; i < MAX_LEVEL && frontier.length > 0; i++) {
        const next = []
        for (const pid of frontier) {
          const kids = childrenByParent.get(pid)
          if (!kids) continue
          for (const id of kids) {
            if (!result.has(id)) {
              result.add(id)
              next.push(id)
            }
          }
        }
        frontier = next
      }
      return result
    },
    [catIndex]
  )

  const handleMoveSave = async () => {
    if (!moveModal) return
    const targetId = moveModal.targetParentId // 0=根级, 正整数=目标父级
    setMoveSaving(true)
    try {
      // parentId: "0"=移到根级, 正整数字符串=移到指定父级
      await deliverablesApi.updateCategory(
        moveModal.id,
        moveModal.name,
        moveModal.description || '',
        String(targetId)
      )
      toast.success('目录已移动')
      setMoveModal(null)
      // 自动展开目标父级
      if (targetId) {
        setExpandedIds((prev) => {
          const next = new Set(prev)
          next.add(targetId)
          localStorage.setItem('soar_dlv_expanded', JSON.stringify([...next]))
          return next
        })
      }
      await loadCategories()
    } catch (err) {
      toast.error(err.message || '移动失败')
    } finally {
      setMoveSaving(false)
    }
  }

  const handleSearch = () => {
    setSearch(searchInput)
    setPage(1)
  }

  const handleSaveContent = async () => {
    if (!previewModal?.row || previewModal.type !== 'text') return
    setPreviewSaving(true)
    try {
      await deliverablesApi.saveContent(previewModal.row.id, previewModal.content)
      setPreviewModal((prev) => ({ ...prev, original: prev.content, dirty: false }))
      toast.success('内容已保存')
      await loadDeliverables()
      await loadCategories()
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setPreviewSaving(false)
    }
  }

  // ===== 批量选择 / 下载 =====
  const toggleRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    // 仅切换当前页（材料行 + 子目录行）的选中状态，不影响跨页已选
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (rows.length > 0 && rows.every((r) => next.has(r.id))) {
        rows.forEach((r) => next.delete(r.id))
      } else {
        rows.forEach((r) => next.add(r.id))
      }
      return next
    })
    setSelectedCatIds((prev) => {
      const next = new Set(prev)
      if (pageFolderIds.length > 0 && pageFolderIds.every((id) => next.has(id))) {
        pageFolderIds.forEach((id) => next.delete(id))
      } else {
        pageFolderIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  // 勾选 / 取消勾选一个子目录
  const toggleCat = (id) => {
    setSelectedCatIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelectAll = async () => {
    setSelectingAll(true)
    try {
      const res = await deliverablesApi.allIds({ category_id: activeCatId, search })
      const next = new Set([...selectedIds, ...res.ids])
      setSelectedIds(next)
      if (res.truncated) {
        toast.warning(`已选 ${res.ids.length} 个（超过 10000 上限，请缩小搜索范围）`)
      } else {
        toast.success(`已全选 ${res.ids.length} 个材料`)
      }
    } catch (err) {
      toast.error(err.message || '全选失败')
    } finally {
      setSelectingAll(false)
    }
  }

  const handleClearSelection = () => {
    setSelectedIds(new Set())
    setSelectedCatIds(new Set())
  }

  const handleBatchDownload = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) {
      toast.warning('请先选择要下载的文件')
      return
    }
    setBatchDownloading(true)
    try {
      await deliverablesApi.batchDownload(ids)
      toast.success(`开始下载 ${ids.length} 个文件（zip）`)
      setSelectedIds(new Set())
    } catch (err) {
      toast.error(err.message || '批量下载失败')
    } finally {
      setBatchDownloading(false)
    }
  }

  // 批量删除材料（仅 canDelete 可见，二次确认 + 同步清理落盘文件由后端完成）
  const handleBatchDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) {
      toast.warning('请先选择要删除的文件')
      return
    }
    if (batchDeleting) return
    const ok = await confirm({
      title: `批量删除 ${ids.length} 个材料？`,
      message: '将同时删除对应的落盘文件，操作不可恢复。请确认未误选。',
      confirmText: '确认删除',
    })
    if (!ok) return
    setBatchDeleting(true)
    try {
      const res = await deliverablesApi.batchRemove(ids)
      const msg = `已删除 ${res.deleted} 个材料`
      toast.success(res.not_found > 0 ? `${msg}（${res.not_found} 个未找到已跳过）` : msg)
      setSelectedIds(new Set())
      await loadDeliverables()
      await loadCategories()
    } catch (err) {
      toast.error(err.message || '批量删除失败')
    } finally {
      setBatchDeleting(false)
    }
  }

  // 批量移动：材料改挂 category_id，目录改挂 parent_id（都只动索引，落盘文件不动）
  // targetCategoryId: null=未选；0=根级（仅对目录有意义）；>0=具体目录 id
  const handleBatchMove = async () => {
    const fileIds = [...selectedIds]
    const catIds = [...selectedCatIds]
    if (fileIds.length === 0 && catIds.length === 0) return
    const targetId = batchMoveModal?.targetCategoryId
    if (targetId === null || targetId === undefined) {
      toast.warning('请选择目标目录')
      return
    }
    if (batchMoving) return
    const toRoot = targetId === 0
    const targetName = toRoot
      ? '根级（最顶层）'
      : (catIndex.byId.get(targetId)?.name || '')
    setBatchMoving(true)
    try {
      const parts = []
      let movedTotal = 0
      const skipped = []

      if (fileIds.length > 0) {
        if (toRoot) {
          // 材料必须挂在某个目录下，不存在"根级"这一层
          skipped.push(`${fileIds.length} 个材料未移动：材料必须归属具体目录，不能移到根级`)
        } else {
          const res = await deliverablesApi.batchMove(fileIds, targetId)
          movedTotal += res.moved || 0
          if (res.moved > 0) parts.push(`${res.moved} 个材料`)
          if (res.not_found > 0) skipped.push(`${res.not_found} 个材料未找到`)
        }
      }
      if (catIds.length > 0) {
        const res = await deliverablesApi.batchMoveCategories(catIds, targetId)
        movedTotal += res.moved || 0
        if (res.moved > 0) parts.push(`${res.moved} 个目录`)
        ;(res.skipped || []).forEach((s) => {
          skipped.push(`目录「${s.name || `#${s.id}`}」未移动：${s.reason}`)
        })
      }

      // 只有真的移动了才报成功，避免"已移动 0 个"这种误导性提示
      if (movedTotal > 0) {
        toast.success(`已移动 ${parts.join(' + ')} 到「${targetName}」`)
      }
      if (skipped.length > 0) {
        toast.warning(
          skipped.length === 1
            ? skipped[0]
            : `${skipped.length} 项未移动，例如：${skipped[0]}`
        )
      }
      if (movedTotal === 0 && skipped.length === 0) {
        toast.warning('没有可移动的内容')
      }

      setBatchMoveModal(null)
      setSelectedIds(new Set())
      setSelectedCatIds(new Set())
    } catch (err) {
      toast.error(err.message || '批量移动失败')
    } finally {
      // 无论成功还是部分失败都刷新：材料已移动、目录接口报错时，
      // 若不刷新界面会停留在旧数据，用户以为没生效而重复操作
      setBatchMoving(false)
      await loadDeliverables()
      await loadCategories()
    }
  }

  // 导出目录：将目录及其所有子目录递归打包为 zip（保留目录结构）
  const handleExportCategory = async (node) => {
    if (!node || !node.id) return
    if (exportingCatId) return
    setExportingCatId(node.id)
    setExportProgress({ phase: 'packing', percent: 0, name: node.name })
    try {
      const { count } = await deliverablesApi.exportCategory(node.id, (pct, phase, loaded) => {
        setExportProgress({ phase, percent: pct, loaded, name: node.name })
      })
      toast.success(`已导出「${node.name}」共 ${count} 个文件（zip）`)
    } catch (err) {
      toast.error(err.message || '导出目录失败')
    } finally {
      setExportingCatId(null)
      setTimeout(() => setExportProgress(null), 800)
    }
  }

  // ===== 树形节点递归渲染 =====
  // 层级缩进表：一级 16 → 二级 32 → 三级 52 → 四级 72 → ...每级固定 20px 递进
  const INDENTS = [16, 32, 52, 72, 92, 112, 132, 152, 172, 192]
  // 层级字号表：0-1 级 text-sm，2 级 text-[13px]，3+ 级 text-xs
  const FONT_SIZES = ['text-sm', 'text-sm', 'text-[13px]', 'text-xs', 'text-xs', 'text-xs', 'text-xs', 'text-xs', 'text-xs', 'text-xs']

  const renderTreeNode = (node, depth = 0) => {
    const active = node.id === activeCatId
    const expanded = expandedIds.has(node.id)
    const hasChildren = (node.descendant_count || 0) > 0
    const isEmpty = (node.deliverable_count || 0) === 0
    const indent = INDENTS[depth] || 192
    const fontSize = FONT_SIZES[depth] || 'text-xs'
    return (
      <div key={node.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setActiveCatId(node.id)
            setPage(1)
            if (hasChildren) toggleExpand(node.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setActiveCatId(node.id)
              setPage(1)
              if (hasChildren) toggleExpand(node.id)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setContextMenu({ x: e.clientX, y: e.clientY, node })
          }}
          style={{ paddingLeft: `${indent}px` }}
          className={`group relative mb-0.5 flex cursor-pointer items-center gap-1 rounded-md py-1.5 pr-2 transition-colors ${
            active
              ? 'bg-[#00d4aa]/10'
              : 'hover:bg-muted'
          }`}
        >
          {/* 选中态：左侧 3px 青色竖线 */}
          {active && (
            <span
              className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r"
              style={{ background: '#00d4aa' }}
            />
          )}
          {/* 展开/折叠按钮 */}
          {hasChildren ? (
            <button
              type="button"
              title={expanded ? '折叠' : '展开'}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(node.id)
              }}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="inline-block w-[18px] shrink-0" aria-hidden />
          )}
          {/* 目录图标：空目录灰色，实目录亮色，选中青色 */}
          {expanded || hasChildren ? (
            <FolderOpen
              className={`h-4 w-4 shrink-0 ${
                active ? 'text-[#00d4aa]' : isEmpty ? 'text-[#484f58]' : 'text-amber-500/80'
              }`}
            />
          ) : (
            <Folder
              className={`h-4 w-4 shrink-0 ${
                active ? 'text-[#00d4aa]' : isEmpty ? 'text-[#484f58]' : 'text-amber-500/80'
              }`}
            />
          )}
          {/* 目录名称：空目录灰色，截断 + tooltip */}
          <span
            className={`min-w-0 flex-1 truncate ${fontSize} ${
              active
                ? 'font-medium text-[#00d4aa]'
                : isEmpty
                  ? 'text-[#484f58]'
                  : 'text-[#c9d1d9]'
            }`}
            title={node.name}
          >
            {node.name}
          </span>
          {/* 数字徽章 */}
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
              active
                ? 'bg-[#00d4aa]/15 text-[#00d4aa]'
                : isEmpty
                  ? 'bg-[#21262d] text-[#484f58]'
                  : 'bg-[#21262d] text-[#8b949e]'
            }`}
          >
            {node.deliverable_count == null ? '--' : node.deliverable_count.toLocaleString()}
          </span>
          {/* 悬停操作按钮组：渐变显示 */}
          {canEdit && (
            <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-card px-1 py-0.5 opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
              {node.level < MAX_LEVEL && (
                <button
                  type="button"
                  title="新建子目录"
                  className="rounded p-0.5 text-muted-foreground hover:text-primary"
                  onClick={(e) => {
                    e.stopPropagation()
                    setCatModal({
                      mode: 'create',
                      name: '',
                      description: '',
                      parentId: node.id,
                      parentName: node.name,
                      parentLevel: node.level,
                    })
                  }}
                >
                  <FolderPlus className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                title="编辑目录"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setCatModal({
                    mode: 'edit',
                    id: node.id,
                    name: node.name,
                    description: node.description || '',
                    parentId: node.parent_id,
                  })
                }}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="移动目录"
                className="rounded p-0.5 text-muted-foreground hover:text-primary"
                onClick={(e) => {
                  e.stopPropagation()
                  setMoveModal({
                    id: node.id,
                    name: node.name,
                    description: node.description || '',
                    currentParentId: node.parent_id,
                    targetParentId: node.parent_id || 0,
                  })
                }}
              >
                <Move className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="导出目录（递归打包 zip）"
                disabled={exportingCatId === node.id}
                className="rounded p-0.5 text-muted-foreground hover:text-primary disabled:opacity-50"
                onClick={(e) => {
                  e.stopPropagation()
                  handleExportCategory(node)
                }}
              >
                {exportingCatId === node.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <FolderArchive className="h-3 w-3" />
                )}
              </button>
              {canDelete && (
                <button
                  type="button"
                  title="删除目录"
                  className="rounded p-0.5 text-muted-foreground hover:text-red-500"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleConfirmDelete({
                      type: 'category',
                      id: node.id,
                      name: node.name,
                    })
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          )}
        </div>
        {/* 子节点容器：纯缩进，无竖线 */}
        {expanded && hasChildren && (
          <div>
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  // 父级目录下拉选项（带缩进前缀，供新建目录弹窗使用）
  const parentOptions = useMemo(() => {
    const opts = [{ id: 0, label: '根级（最顶层）' }]
    const sorted = [...categories].sort((a, b) => (a.level || 1) - (b.level || 1))
    sorted.forEach((c) => {
      const d = Math.max(0, (c.level || 1) - 1)
      const prefix = '\u00A0\u00A0\u00A0\u00A0'.repeat(d) + (d > 0 ? '└ ' : '')
      opts.push({ id: c.id, label: prefix + c.name })
    })
    return opts
  }, [categories])

  // 批量移动：可选目标 = 全部目录 - 被选中目录自身及其所有后代
  const batchMoveSelectable = useMemo(() => {
    const blocked = new Set()
    selectedCatIds.forEach((id) => {
      blocked.add(id)
      getDescendantIds(id).forEach((d) => blocked.add(d))
    })
    return categories.filter((c) => !blocked.has(c.id))
  }, [categories, selectedCatIds, getDescendantIds])

  const batchMoveTargetList = useMemo(
    () => flattenTree(batchMoveSelectable, batchMoveExpandedIds),
    [batchMoveSelectable, batchMoveExpandedIds]
  )
  const batchMoveExpandableIds = useMemo(
    () => expandableIdsOf(batchMoveSelectable),
    [batchMoveSelectable]
  )

  // 「移动目录」：可选目标 = 全部目录 - 自身及其所有后代
  const moveSelectable = useMemo(() => {
    if (!moveModal) return []
    const excludeIds = getDescendantIds(moveModal.id)
    excludeIds.add(moveModal.id)
    return categories.filter((c) => !excludeIds.has(c.id))
  }, [moveModal, categories, getDescendantIds])

  const moveTargetList = useMemo(
    () => flattenTree(moveSelectable, moveExpandedIds),
    [moveSelectable, moveExpandedIds]
  )
  const moveExpandableIds = useMemo(
    () => expandableIdsOf(moveSelectable),
    [moveSelectable]
  )

  const toggleMoveExpand = useCallback((id) => {
    setMoveExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleBatchMoveExpand = useCallback((id) => {
    setBatchMoveExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 「移动目录」的目标层级提示
  const moveLevelInfo = useMemo(() => {
    if (!moveModal) return { targetLevel: 1, currentLevel: 1, willChangeLevel: false }
    const targetId = moveModal.targetParentId
    let targetLevel = 1
    if (targetId) {
      const tCat = catIndex.byId.get(targetId)
      targetLevel = (tCat?.level || 1) + 1
    }
    const currentLevel = catIndex.byId.get(moveModal.id)?.level || 1
    return { targetLevel, currentLevel, willChangeLevel: targetLevel !== currentLevel }
  }, [moveModal, catIndex])

  // ===== 渲染 =====
  return (
    <PageContainer>
      {/* 页头：标题 + 计数 + 右侧操作区（教程 / 刷新 / 新建目录 / 上传材料） */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">材料管理</h1>
          {!catLoading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="text-sm font-medium tabular-nums text-foreground">{totalFiles.toLocaleString()}</span> 个材料
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">
            按树形目录归档管理交付文件，支持最多 10 级子目录
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <TutorialButton onClick={() => setTutorialOpen(true)} />
          <button
            type="button"
            onClick={() => { loadCategories(); loadDeliverables() }}
            className="btn-secondary btn-sm"
            title="刷新目录与材料列表"
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${catLoading || loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => setCatModal({ mode: 'create', name: '', description: '', parentId: 0 })}
              className="btn-secondary btn-sm"
            >
              <FolderPlus className="mr-1 h-3.5 w-3.5" />
              新建目录
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              disabled={!activeCatId}
              onClick={() => setUploadModal({ files: [], version: '', description: '' })}
              className="btn-primary btn-sm"
              title={activeCatId ? '上传材料到当前目录' : '请先选择目录'}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              上传材料
            </button>
          )}
        </div>
      </div>

      {/* 状态指标条：材料类型分布 chips（点击筛选当前页 / 再点取消）+ 右侧汇总 */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
        {!loading && rows.length > 0 && TYPE_CHIPS.map((chip) => {
          const active = typeFilter === chip.key
          const count = typeStats[chip.key] || 0
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setTypeFilter(active ? '' : chip.key)}
              title={active ? '点击取消该类型筛选' : `点击筛选「${chip.label}」类型的材料（当前页）`}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
                active
                  ? `border-transparent ${chip.activeCls}`
                  : count === 0
                    ? 'border-border bg-secondary text-muted-foreground'
                    : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
              {chip.label}
              <span className="font-medium tabular-nums">{count}</span>
            </button>
          )
        })}
        {activeCat && (!loading && rows.length > 0 ? <span className="mx-1 h-4 w-px bg-border" aria-hidden /> : null)}
        {activeCat && (
          <span className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
            当前目录
            <span className="inline-flex max-w-40 items-center truncate rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary" title={activeCat.name}>
              {activeCat.name}
            </span>
            含子目录共
            <b className={`font-semibold tabular-nums ${(activeCat.deliverable_count || 0) > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
              {(activeCat.deliverable_count || 0).toLocaleString()}
            </b>
            个材料
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5" title="全部目录数量">
            <FolderOpen className="h-3.5 w-3.5 text-primary/80" />
            目录总数
            <b className={`font-semibold tabular-nums ${categories.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
              {categories.length > 0 ? categories.length.toLocaleString() : '--'}
            </b>
          </span>
          <span className="inline-flex items-center gap-1.5" title="全部材料数量">
            <HardDrive className="h-3.5 w-3.5 text-primary/80" />
            材料总数
            <b className={`font-semibold tabular-nums ${totalFiles > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
              {totalFiles > 0 ? totalFiles.toLocaleString() : '--'}
            </b>
          </span>
          <span className="hidden text-muted-foreground md:inline">支持 xlsx / word / pdf / zip 等 13 种类型，单文件 ≤ 200MB</span>
        </div>
      </div>

      {/* 面包屑导航 */}
      {breadcrumbPath.length > 0 && (
        <nav className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbPath.map((cat, idx) => (
            <span key={cat.id} className="flex items-center gap-1">
              {idx > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${
                  idx === breadcrumbPath.length - 1 ? 'font-medium text-foreground' : ''
                }`}
                onClick={() => {
                  setActiveCatId(cat.id)
                  setPage(1)
                }}
                title="跳转到此目录"
              >
                {cat.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {/* 主体三栏布局 */}
      <div className="flex gap-0">
        {/* 左：目录树 */}
        <aside
          className="flex shrink-0 flex-col rounded-l-lg border border-r-0 border-border bg-card"
          style={{ width: treeWidth }}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="text-xs font-semibold text-muted-foreground">目录结构</span>
            <div className="flex items-center gap-1">
              {categories.length > 0 && (
                <>
                  <button
                    type="button"
                    title="全部展开"
                    className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    onClick={() => {
                      const all = new Set(categories.map((c) => c.id))
                      setExpandedIds(all)
                      localStorage.setItem('soar_dlv_expanded', JSON.stringify([...all]))
                    }}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="一键收起"
                    className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent"
                    disabled={expandedIds.size === 0}
                    onClick={() => {
                      setExpandedIds(new Set())
                      localStorage.setItem('soar_dlv_expanded', '[]')
                    }}
                  >
                    <ChevronsUp className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              {canEdit && (
                <button
                  type="button"
                  title="新建根目录"
                  className="rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  onClick={() => setCatModal({ mode: 'create', name: '', description: '', parentId: 0 })}
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="min-h-[120px] max-h-[calc(100vh-260px)] flex-1 overflow-y-auto p-2">
            {catLoading && categories.length === 0 ? (
              <div className="flex flex-col gap-1 p-1">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md px-2 py-2">
                    <div className="h-4 w-4 shrink-0 rounded skeleton-shimmer" />
                    <div
                      className="h-3 rounded skeleton-shimmer"
                      style={{ width: `${50 + ((i * 17) % 40)}%` }}
                    />
                  </div>
                ))}
              </div>
            ) : categories.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground">
                <FolderPlus className="h-6 w-6 text-muted-foreground" />
                <span>暂无目录</span>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCatModal({ mode: 'create', name: '', description: '', parentId: 0 })}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    新建目录
                  </Button>
                )}
              </div>
            ) : (
              tree.map((node) => renderTreeNode(node, 0))
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
            <span className="tabular-nums">
              共 {categories.length} 个目录
              {expandedIds.size > 0 && (
                <span className="ml-1 text-primary/80">· 已展开 {expandedIds.size}</span>
              )}
            </span>
            {expandedIds.size > 0 && (
              <button
                type="button"
                title="一键收起全部目录"
                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-primary/10 hover:text-primary"
                onClick={() => {
                  setExpandedIds(new Set())
                  localStorage.setItem('soar_dlv_expanded', '[]')
                }}
              >
                <ChevronsUp className="h-3 w-3" />
                收起
              </button>
            )}
          </div>
        </aside>

        {/* 拖拽分隔条 */}
        <div
          onMouseDown={handleResizeStart}
          className={`group relative z-10 w-1 shrink-0 cursor-col-resize border-y border-border transition-colors ${
            treeResizing ? 'bg-primary' : 'bg-border hover:bg-primary/50'
          }`}
          title="拖拽调节目录宽度"
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* 中：材料列表 */}
        <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-card">
          {/* 工具栏 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <FolderOpen className="h-3.5 w-3.5" />
              {activeCat ? activeCat.name : '未选择目录'}
            </span>
            <span className="text-xs text-muted-foreground">
              本目录 {total.toLocaleString()} 个
              {activeCat && (activeCat.deliverable_count || 0) > total && (
                <span className="ml-1 text-muted-foreground">/ 含子目录共 {activeCat.deliverable_count.toLocaleString()} 个</span>
              )}
              {typeFilter && rows.length > 0 && (
                <span className="ml-1 text-primary/80" title="类型筛选仅作用于当前页">
                  · 类型筛选 {displayRows.length}/{rows.length}
                </span>
              )}
            </span>
            {selectedTotal > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
                已选
                {selectedIds.size > 0 && <span> {selectedIds.size.toLocaleString()} 个材料</span>}
                {selectedIds.size > 0 && selectedCatIds.size > 0 && <span> +</span>}
                {selectedCatIds.size > 0 && <span> {selectedCatIds.size.toLocaleString()} 个目录</span>}
                <button
                  type="button"
                  className="ml-0.5 rounded text-primary/70 hover:text-primary"
                  onClick={handleClearSelection}
                  title="清空选择"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {selectedIds.size > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={batchDownloading}
                  onClick={handleBatchDownload}
                >
                  <Download className="h-3.5 w-3.5" />
                  批量下载 ({selectedIds.size.toLocaleString()})
                </Button>
              )}
              {selectedTotal > 0 && canEdit && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setBatchMoveModal({ targetCategoryId: null })}
                >
                  <Move className="h-3.5 w-3.5" />
                  批量移动 ({selectedTotal.toLocaleString()})
                </Button>
              )}
              {selectedIds.size > 0 && canDelete && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={batchDeleting}
                  onClick={handleBatchDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  批量删除 ({selectedIds.size.toLocaleString()})
                </Button>
              )}
              {/* 列表/网格视图切换按钮组 */}
              <div className="flex items-center rounded-md border border-border p-0.5">
                <button
                  type="button"
                  title="列表视图"
                  className={`rounded p-1.5 ${viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => changeViewMode('list')}
                >
                  <List className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="网格视图"
                  className={`rounded p-1.5 ${viewMode === 'grid' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => changeViewMode('grid')}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch()
                  }}
                  placeholder="搜索名称 / 文件名 / 版本"
                  className="w-52 rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary"
                />
              </div>
              <Button size="sm" variant="secondary" onClick={handleSearch}>搜索</Button>
            </div>
          </div>

          {/* 内容区 */}
          {!activeCat ? (
            <EmptyState
              icon={<FolderPlus className="h-6 w-6" />}
              title="请先创建目录"
              description={canEdit ? '点击下方按钮或左上角「新建目录」开始归档材料' : '等待管理员创建目录'}
              action={
                canEdit && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setCatModal({ mode: 'create', name: '', description: '', parentId: 0 })}
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      新建目录
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setUploadModal({ files: [], version: '', description: '' })}
                      disabled
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      上传材料
                    </Button>
                  </div>
                )
              }
              className="py-20"
            />
          ) : loading ? (
            // 骨架屏：按当前视图分别模仿网格卡片 / 表格行的真实结构
            viewMode === 'grid' ? (
              <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex min-h-[168px] flex-col rounded-lg border border-border bg-card p-3">
                    <div className="mx-auto mt-5 h-12 w-12 rounded-lg skeleton-shimmer" />
                    <div className="mx-auto mt-4 h-3 w-2/3 rounded skeleton-shimmer" />
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <div className="h-2.5 w-1/2 rounded skeleton-shimmer" />
                      <div className="h-2.5 w-10 rounded skeleton-shimmer" />
                    </div>
                    <div className="mt-2 h-2.5 w-full rounded skeleton-shimmer" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-3 p-4">
                {Array.from({ length: 6 }).map((_, r) => (
                  <div key={r} className="flex items-center gap-4">
                    <div className="h-4 w-4 shrink-0 rounded skeleton-shimmer" />
                    <div className="h-4 min-w-0 flex-1 rounded skeleton-shimmer" />
                    <div className="h-4 w-32 shrink-0 rounded skeleton-shimmer" />
                    <div className="h-4 w-14 shrink-0 rounded skeleton-shimmer" />
                    <div className="h-4 w-12 shrink-0 rounded skeleton-shimmer" />
                    <div className="hidden h-4 w-20 shrink-0 rounded skeleton-shimmer md:block" />
                    <div className="hidden h-4 w-28 shrink-0 rounded skeleton-shimmer lg:block" />
                    <div className="h-4 w-24 shrink-0 rounded skeleton-shimmer" />
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              {displayRows.length === 0 && !showFolders ? (
            <EmptyState
              icon={
                search || typeFilter ? (
                  <Search className="h-6 w-6" />
                ) : (
                  <CloudUpload className="h-6 w-6" />
                )
              }
              title={search || typeFilter ? '未找到匹配的材料' : '该目录暂无材料'}
              description={
                search
                  ? '换个关键词试试，或清除筛选后查看全部'
                  : typeFilter
                    ? `当前页没有「${typeChipOf(typeFilter)?.label || ''}」类型的材料，可切换类型或清除筛选`
                    : canEdit
                      ? `可直接上传文件到此目录${(activeCat.deliverable_count || 0) > 0 ? `，子目录中共有 ${activeCat.deliverable_count.toLocaleString()} 个材料` : ''}`
                      : '等待有权限的用户上传'
              }
              action={
                <div className="flex items-center gap-2">
                  {(search || typeFilter) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSearchInput('')
                        setSearch('')
                        setTypeFilter('')
                        setPage(1)
                      }}
                    >
                      清除筛选
                    </Button>
                  )}
                  {!search && !typeFilter && canEdit && (
                    <Button
                      size="sm"
                      onClick={() => setUploadModal({ files: [], version: '', description: '' })}
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      上传材料
                    </Button>
                  )}
                  {!search && !typeFilter && canEdit && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setCatModal({ mode: 'create', name: '', description: '', parentId: activeCatId || 0, parentName: activeCat?.name })}
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      新建子目录
                    </Button>
                  )}
                </div>
              }
              className="py-16"
            />
          ) : viewMode === 'grid' ? (
            // 网格视图
            <div className="card-stagger grid grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-4">
              {showFolders && subCategories.map((cat) => {
                const checked = selectedCatIds.has(cat.id)
                return (
                  <div
                    key={`folder-${cat.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => enterSubCategory(cat)}
                    onKeyDown={(e) => { if (e.key === 'Enter') enterSubCategory(cat) }}
                    title={`打开「${cat.name}」`}
                    className={`card-hover group relative flex min-h-[168px] cursor-pointer flex-col rounded-lg border p-3 transition-colors ${
                      checked
                        ? 'border-primary/60 bg-primary/5'
                        : 'border-border bg-card hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCat(cat.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute left-2 top-2 z-10 h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                      title="勾选此文件夹（可批量移动，内含文件与子目录会一起跟随）"
                    />
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
                      <span className="flex h-12 w-12 items-center justify-center">
                        <Folder className="h-8 w-8 text-amber-500/80 transition-transform group-hover:scale-110" />
                      </span>
                      <span
                        className="w-full text-xs font-medium text-foreground"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                        title={cat.name}
                      >
                        {cat.name}
                      </span>
                    </div>
                    <div className="mt-2 text-center text-[10px] text-muted-foreground tabular-nums">
                      {(cat.deliverable_count || 0).toLocaleString()} 个材料
                    </div>
                  </div>
                )
              })}
              {displayRows.map((r) => {
                const checked = selectedIds.has(r.id)
                const canPreview = PREVIEWABLE_EXTS.includes((r.file_ext || '').toLowerCase())
                return (
                  <div
                    key={r.id}
                    className={`card-hover group relative flex min-h-[168px] flex-col rounded-lg border p-3 transition-colors ${
                      canPreview ? 'cursor-pointer' : ''
                    } ${checked ? 'border-primary/60 bg-primary/5' : 'border-border bg-card hover:border-primary/40'}`}
                    onClick={() => canPreview && handlePreview(r)}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRow(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute left-2 top-2 z-10 h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                    />
                    {r.version && (
                      <span className="absolute right-2 top-2 z-10 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                        {r.version}
                      </span>
                    )}
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                      <span className="flex h-12 w-12 items-center justify-center">
                        <FileIcon ext={r.file_ext} className="h-8 w-8" />
                      </span>
                      <span
                        className="w-full text-xs font-medium text-foreground"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                        title={r.name}
                      >
                        {r.name}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="truncate" title={r.filename}>{r.filename}</span>
                      <span
                        className={`shrink-0 tabular-nums ${r.file_size === 0 ? 'text-muted-foreground' : ''}`}
                        title={r.file_size == null ? '未统计' : undefined}
                      >
                        {fmtSize(r.file_size)}
                      </span>
                    </div>
                    <div
                      className="flex items-center justify-end gap-1 border-t border-border pt-2 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canPreview && (
                        <button
                          type="button"
                          title="预览"
                          className="btn-secondary btn-sm"
                          onClick={() => handlePreview(r)}
                        >
                          <Eye className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="下载"
                        className="btn-secondary btn-sm"
                        onClick={() => handleDownload(r)}
                      >
                        <Download className="h-3 w-3" />
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          title="编辑"
                          className="btn-secondary btn-sm"
                          onClick={() =>
                            setEditModal({
                              id: r.id,
                              name: r.name,
                              version: r.version || '',
                              description: r.description || '',
                              file: null,
                              filename: r.filename,
                            })
                          }
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          title="删除"
                          className="btn-danger btn-sm"
                          onClick={() => handleConfirmDelete({ type: 'deliverable', id: r.id, name: r.name, filename: r.filename })}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            // 列表视图
            <div className="table-stagger overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                    <th className="w-12 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          ref={(el) => {
                            if (el) el.indeterminate = someChecked && !allChecked
                          }}
                          onChange={toggleAll}
                          className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                          title={allChecked ? '取消选中当前页' : '全选当前页'}
                        />
                        {total > rows.length && selectedIds.size < total && (
                          <button
                            type="button"
                            disabled={selectingAll}
                            onClick={handleSelectAll}
                            className="truncate text-xs text-primary hover:underline disabled:opacity-50"
                            title="选中当前条件下所有材料（含其他页）"
                          >
                            {selectingAll ? '加载中…' : `全选 ${total.toLocaleString()}`}
                          </button>
                        )}
                      </div>
                    </th>
                    <th className="px-4 py-2.5 font-medium">材料名称</th>
                    <th className="w-40 px-4 py-2.5 font-medium">文件</th>
                    <th className="w-20 px-4 py-2.5 font-medium">版本</th>
                    <th className="w-20 px-4 py-2.5 font-medium">大小</th>
                    <th className="w-24 px-4 py-2.5 font-medium">上传人</th>
                    <th className="w-36 px-4 py-2.5 font-medium">上传时间</th>
                    <th className="w-32 px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {showFolders && subCategories.map((cat) => {
                    const catChecked = selectedCatIds.has(cat.id)
                    return (
                    <tr
                      key={`folder-${cat.id}`}
                      className={`cursor-pointer border-b border-border transition-colors hover:bg-primary/5 ${
                        catChecked ? 'bg-primary/5' : 'bg-muted'
                      }`}
                      onClick={() => enterSubCategory(cat)}
                    >
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={catChecked}
                          onChange={() => toggleCat(cat.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                          title="勾选此文件夹（可批量移动，内含文件与子目录会一起跟随）"
                        />
                      </td>
                      <td className="min-w-0 px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-foreground" title={cat.name}>{cat.name}</div>
                            <div className="truncate text-xs text-muted-foreground">文件夹</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                        {(cat.deliverable_count || 0).toLocaleString()} 项
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                          打开
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                      </td>
                    </tr>
                    )
                  })}
                  {displayRows.map((r) => {
                    const checked = selectedIds.has(r.id)
                    return (
                      <tr key={r.id} className={`border-b border-border transition-colors last:border-0 hover:bg-primary/5 ${checked ? 'bg-primary/5' : ''}`}>
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(r.id)}
                            className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
                          />
                        </td>
                        <td className="min-w-0 px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <FileIcon ext={r.file_ext} className="h-4 w-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-foreground" title={r.name}>{r.name}</div>
                              {r.description && (
                                <div className="truncate text-xs text-muted-foreground" title={r.description}>{r.description}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="min-w-0 px-4 py-2.5">
                          <span className="block truncate text-xs text-muted-foreground" title={r.filename}>{r.filename}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          {r.version ? (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{r.version}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground ${r.file_size === 0 ? 'text-muted-foreground' : ''}`}
                          title={r.file_size == null ? '未统计' : undefined}
                        >
                          {fmtSize(r.file_size)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{r.creator_name || '—'}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground">{fmtTime(r.created_at)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <span className="inline-flex items-center gap-1">
                            {PREVIEWABLE_EXTS.includes((r.file_ext || '').toLowerCase()) && (
                              <button
                                type="button"
                                title="预览"
                                className="btn-secondary btn-sm"
                                onClick={() => handlePreview(r)}
                              >
                                <Eye className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              title="下载"
                              className="btn-secondary btn-sm"
                              onClick={() => handleDownload(r)}
                            >
                              <Download className="h-3 w-3" />
                            </button>
                            {canEdit && (
                              <button
                                type="button"
                                title="编辑"
                                className="btn-secondary btn-sm"
                                onClick={() =>
                                  setEditModal({
                                    id: r.id,
                                    name: r.name,
                                    version: r.version || '',
                                    description: r.description || '',
                                    file: null,
                                    filename: r.filename,
                                  })
                                }
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                title="删除"
                                className="btn-danger btn-sm"
                                onClick={() => handleConfirmDelete({ type: 'deliverable', id: r.id, name: r.name, filename: r.filename })}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {activeCat && total > 0 && (
            <div className="border-t border-border px-4 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s)
                  setPage(1)
                }}
                pageSizeOptions={[10, 20, 50, 100]}
              />
            </div>
          )}
            </>
          )}
        </section>

        {/* 右：文本在线编辑仍用侧栏；Word/Excel/PDF 走下方大预览层 */}
        {previewModal && previewModal.type === 'text' && (
          <aside className="flex w-96 shrink-0 flex-col rounded-lg border border-border bg-card">
            {/* 标题栏 */}
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileIcon ext={previewModal.row.file_ext} className="h-4 w-4 shrink-0" />
                <span className="truncate text-sm font-medium text-foreground" title={previewModal.row.filename}>
                  {previewModal.row.filename}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {fmtSize(previewModal.row.file_size)}
                </span>
                {previewModal.type === 'text' && previewModal.dirty && (
                  <span className="shrink-0 text-[10px] text-amber-500">未保存</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canEdit && (
                  <Button
                    size="sm"
                    loading={previewSaving}
                    disabled={previewSaving || !previewModal.dirty}
                    onClick={handleSaveContent}
                  >
                    <Save className="h-3.5 w-3.5" />
                    保存
                  </Button>
                )}
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={closePreview}
                  title="关闭预览"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* 内容区 */}
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              style={{ maxHeight: 'calc(100vh - 200px)' }}
            >
              {previewModal.loading ? (
                <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中…
                </div>
              ) : previewModal.error ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <p className="text-red-500">{previewModal.error}</p>
                  <Button size="sm" variant="secondary" onClick={() => handleDownload(previewModal.row)}>
                    <Download className="h-3.5 w-3.5" />
                    下载文件
                  </Button>
                </div>
              ) : (
                <AutoGrowTextarea
                  value={previewModal.content}
                  onChange={(e) =>
                    setPreviewModal((prev) => ({
                      ...prev,
                      content: e.target.value,
                      dirty: e.target.value !== prev.original,
                    }))
                  }
                  readOnly={!canEdit}
                  spellCheck={false}
                  placeholder={canEdit ? '在此编辑文件内容…' : '无编辑权限，只读模式'}
                  className="w-full flex-1 resize-none border-0 bg-background p-4 font-mono text-sm leading-relaxed text-foreground outline-none"
                  style={{ minHeight: '400px' }}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {overlayPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-[2px] sm:p-5"
          onClick={closePreview}
        >
          <div
            className="flex h-[min(92vh,920px)] w-[min(1024px,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <FileIcon ext={previewModal.row.file_ext} className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground" title={previewModal.row.filename}>
                    {previewModal.row.filename}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5 uppercase">.{previewModal.row.file_ext}</span>
                    <span>{fmtSize(previewModal.row.file_size)}</span>
                    {previewModal.row.name && previewModal.row.name !== previewModal.row.filename && (
                      <span className="truncate" title={previewModal.row.name}>{previewModal.row.name}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => handleDownload(previewModal.row)}>
                  <Download className="h-3.5 w-3.5" />
                  下载
                </Button>
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={closePreview}
                  title="关闭预览（Esc）"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div data-allow-scroll className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain">
              {previewModal.loading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在打开预览…
                </div>
              ) : previewModal.error ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <p className="max-w-md text-center text-red-500">{previewModal.error}</p>
                  <Button size="sm" variant="secondary" onClick={() => handleDownload(previewModal.row)}>
                    <Download className="h-3.5 w-3.5" />
                    下载文件
                  </Button>
                </div>
              ) : previewModal.type === 'pdf' && previewModal.blobUrl ? (
                <iframe
                  src={previewModal.blobUrl}
                  title="PDF 预览"
                  className="h-full w-full flex-1 border-0 bg-muted"
                />
              ) : previewModal.type === 'office' && previewModal.arrayBuffer ? (
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      加载预览组件…
                    </div>
                  }
                >
                  <OfficePreview
                    buffer={previewModal.arrayBuffer}
                    ext={(previewModal.row.file_ext || '').toLowerCase()}
                  />
                </Suspense>
              ) : previewModal.type === 'unsupported' ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <FileArchive className="h-10 w-10 text-muted-foreground" />
                  <p>
                    {previewModal.error
                      || `该文件类型（.${previewModal.row.file_ext}）暂不支持在线预览`}
                  </p>
                  <p className="text-xs">支持预览：Word（.docx）/ Excel（.xlsx .xls）/ PDF / TXT / CSV / MD</p>
                  <Button size="sm" variant="secondary" onClick={() => handleDownload(previewModal.row)}>
                    <Download className="h-3.5 w-3.5" />
                    下载文件
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单（fixed 定位） */}
      {contextMenu && contextMenu.node && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-card py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node.level < MAX_LEVEL && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
              onClick={() => {
                const node = contextMenu.node
                setContextMenu(null)
                setCatModal({
                  mode: 'create',
                  name: '',
                  description: '',
                  parentId: node.id,
                  parentName: node.name,
                  parentLevel: node.level,
                })
              }}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              新建子目录
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            onClick={() => {
              const node = contextMenu.node
              setContextMenu(null)
              setCatModal({
                mode: 'edit',
                id: node.id,
                name: node.name,
                description: node.description || '',
                parentId: node.parent_id,
              })
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑目录
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            onClick={() => {
              const node = contextMenu.node
              setContextMenu(null)
              setMoveModal({
                id: node.id,
                name: node.name,
                description: node.description || '',
                currentParentId: node.parent_id,
                targetParentId: node.parent_id || 0,
              })
            }}
          >
            <Move className="h-3.5 w-3.5" />
            移动目录
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50"
            disabled={exportingCatId === contextMenu.node.id}
            onClick={() => {
              const node = contextMenu.node
              setContextMenu(null)
              handleExportCategory(node)
            }}
          >
            {exportingCatId === contextMenu.node.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderArchive className="h-3.5 w-3.5" />
            )}
            {exportingCatId === contextMenu.node.id ? '导出中...' : '导出目录'}
          </button>
          {canDelete && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-500 hover:bg-red-500/10"
              onClick={() => {
                const node = contextMenu.node
                setContextMenu(null)
                handleConfirmDelete({
                  type: 'category',
                  id: node.id,
                  name: node.name,
                })
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除目录
            </button>
          )}
        </div>
      )}

      {/* 目录新建/编辑弹窗 */}
      {catModal && (
        <Modal
          title={catModal.mode === 'create' ? (catModal.parentId ? '新建子目录' : '新建根目录') : '编辑目录'}
          onClose={() => setCatModal(null)}
          footer={
            <>
              <Button size="sm" variant="secondary" onClick={() => setCatModal(null)}>取消</Button>
              {/* 创建模式：保存并继续 */}
              {catModal.mode === 'create' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={catSaving}
                  onClick={() => handleCatSave(true)}
                >
                  保存并继续
                </Button>
              )}
              <Button size="sm" loading={catSaving} onClick={() => handleCatSave(false)}>保存</Button>
            </>
          }
        >
          {catModal.mode === 'create' ? (
            // 创建模式：下拉选择父级目录
            <Field label="父级目录" hint="可选择任意已有目录作为父级，「根级」为最顶层">
              <CompactSelect
                value={catModal.parentId || 0}
                onChange={(e) => {
                  const pid = Number(e.target.value) || 0
                  const parent = pid ? categories.find((c) => c.id === pid) : null
                  setCatModal({
                    ...catModal,
                    parentId: pid,
                    parentName: parent ? parent.name : '',
                    parentLevel: parent ? parent.level : 0,
                  })
                }}
                size="lg"
                block
              >
                {parentOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </CompactSelect>
            </Field>
          ) : (
            // 编辑模式：只读显示父级
            catModal.parentId ? (
              <Field label="父级目录">
                <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {categories.find((c) => c.id === catModal.parentId)?.name || '根级'}
                </div>
              </Field>
            ) : null
          )}
          <Field label="目录名称">
            <input
              autoFocus
              value={catModal.name}
              onChange={(e) => setCatModal({ ...catModal, name: e.target.value })}
              maxLength={100}
              placeholder="输入目录名称"
              className={inputCls}
            />
          </Field>
          <Field label="描述（可选）">
            <AutoGrowTextarea
              value={catModal.description}
              onChange={(e) => setCatModal({ ...catModal, description: e.target.value })}
              maxLength={500}
              rows={2}
              placeholder="该目录的归档范围说明"
              className={`${inputCls} resize-none`}
            />
          </Field>
        </Modal>
      )}

      {/* 上传弹窗（支持多文件 + 拖拽） */}
      {uploadModal && (
        <Modal
          title="上传材料"
          wide
          onClose={() => !uploading && setUploadModal(null)}
          footer={
            <>
              <Button size="sm" variant="secondary" disabled={uploading} onClick={() => setUploadModal(null)}>
                {uploading ? '关闭' : '取消'}
              </Button>
              <Button
                size="sm"
                loading={uploading}
                disabled={uploading || (uploadModal.files || []).every((f) => f.status !== 'pending')}
                onClick={handleUpload}
              >
                上传{(uploadModal.files || []).filter((f) => f.status !== 'success').length > 0
                  ? ` (${(uploadModal.files || []).filter((f) => f.status !== 'success').length})`
                  : ''}
              </Button>
            </>
          }
        >
          {/* 大面积拖拽区域：文件 / 文件夹（保留原目录结构） */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!uploading) setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
            onDrop={async (e) => {
              e.preventDefault()
              setDragOver(false)
              if (uploading) return
              const dropped = await collectDroppedItems(e.dataTransfer)
              if (dropped.length === 0) {
                toast.warning('没有可上传的文件')
                return
              }
              setUploadModal((prev) => ({
                ...prev,
                files: [...(prev.files || []), ...dropped],
              }))
            }}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-muted'
            }`}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">拖拽文件或文件夹到此处</p>
              <p className="text-xs text-muted-foreground">
                文件夹会按原目录结构迁入当前目录，类似 Windows 复制文件夹
              </p>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={uploading}
                onClick={() => document.getElementById('dlv-upload-input')?.click()}
              >
                选择文件
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={uploading}
                onClick={() => document.getElementById('dlv-upload-folder')?.click()}
              >
                <Folder className="h-3.5 w-3.5" />
                选择文件夹
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              支持 {ALLOWED_EXTS.length} 种类型，单文件 ≤ 200MB
            </p>
            <input
              id="dlv-upload-input"
              type="file"
              multiple
              accept={ALLOWED_EXTS.map((e) => `.${e}`).join(',')}
              onChange={(e) => {
                const picked = Array.from(e.target.files || []).map((file) => toUploadItem(file)).filter(Boolean)
                if (picked.length === 0) return
                setUploadModal((prev) => ({
                  ...prev,
                  files: [...(prev.files || []), ...picked],
                }))
                e.target.value = ''
              }}
              className="hidden"
            />
            <input
              id="dlv-upload-folder"
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              onChange={(e) => {
                const picked = Array.from(e.target.files || []).map((file) => toUploadItem(file)).filter(Boolean)
                if (picked.length === 0) {
                  toast.warning('文件夹中没有可上传的文件')
                  e.target.value = ''
                  return
                }
                setUploadModal((prev) => ({
                  ...prev,
                  files: [...(prev.files || []), ...picked],
                }))
                e.target.value = ''
              }}
              className="hidden"
            />
          </div>

          {/* 待上传列表 */}
          {(uploadModal.files || []).length > 0 && (
            <div className="mt-3 max-h-44 overflow-y-auto rounded-md border border-border">
              {(uploadModal.files || []).map((item, idx) => (
                <div
                  key={idx}
                  className="relative flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-0"
                >
                  <FileIcon ext={(item.file.name.split('.').pop() || '').toLowerCase()} className="h-3.5 w-3.5" />
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-foreground"
                    title={item.relativePath || item.file.name}
                  >
                    {(item.relativePath && item.relativePath.includes('/'))
                      ? item.relativePath.replace(/\//g, ' / ')
                      : item.file.name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {fmtSize(item.file.size)}
                  </span>
                  {/* 状态图标 */}
                  {item.status === 'uploading' && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  )}
                  {item.status === 'success' && (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                  )}
                  {item.status === 'failed' && (
                    <span className="shrink-0" title={item.error}>
                      <XCircle className="h-3.5 w-3.5 text-red-500" />
                    </span>
                  )}
                  {/* 移除按钮（上传中禁用） */}
                  {!uploading && (
                    <button
                      type="button"
                      title="移除"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-red-500"
                      onClick={() =>
                        setUploadModal((prev) => ({
                          ...prev,
                          files: prev.files.filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {/* 上传中进度条（不定宽 animate-pulse） */}
                  {item.status === 'uploading' && (
                    <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {!uploading && (uploadModal.files || []).length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => document.getElementById('dlv-upload-input')?.click()}
              >
                <Plus className="h-3 w-3" />
                继续添加文件
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => document.getElementById('dlv-upload-folder')?.click()}
              >
                <FolderPlus className="h-3 w-3" />
                继续添加文件夹
              </button>
              {(() => {
                const dirs = new Set(
                  (uploadModal.files || []).map((f) => dirKeyOf(f.relativePath)).filter(Boolean)
                )
                if (dirs.size === 0) return null
                return (
                  <span className="text-[11px] text-muted-foreground">
                    将创建 {dirs.size} 个文件夹
                  </span>
                )
              })()}
            </div>
          )}

          {/* 统一批量设置区 */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="版本（可选，应用于全部）">
              <input
                value={uploadModal.version}
                onChange={(e) => setUploadModal({ ...uploadModal, version: e.target.value })}
                maxLength={50}
                placeholder="如 v1.0 / 2024-06"
                className={inputCls}
              />
            </Field>
            <Field label="上传到">
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                {activeCat?.name || '—'}
                {(uploadModal.files || []).some((f) => dirKeyOf(f.relativePath)) && (
                  <span className="mt-0.5 block text-[11px]">文件夹将按原结构创建到此目录下</span>
                )}
              </div>
            </Field>
          </div>
          <Field label="描述（可选，应用于全部）">
            <AutoGrowTextarea
              value={uploadModal.description}
              onChange={(e) => setUploadModal({ ...uploadModal, description: e.target.value })}
              rows={2}
              placeholder="材料说明"
              className={`${inputCls} resize-none`}
            />
          </Field>
        </Modal>
      )}

      {/* 编辑弹窗 */}
      {editModal && (
        <Modal
          title="编辑材料"
          onClose={() => !editSaving && setEditModal(null)}
          footer={
            <>
              <Button size="sm" variant="secondary" disabled={editSaving} onClick={() => setEditModal(null)}>取消</Button>
              <Button size="sm" loading={editSaving} onClick={handleEditSave}>保存</Button>
            </>
          }
        >
          <Field label="名称">
            <input
              value={editModal.name}
              onChange={(e) => setEditModal({ ...editModal, name: e.target.value })}
              maxLength={200}
              className={inputCls}
            />
          </Field>
          <Field label="版本（可选）">
            <input
              value={editModal.version}
              onChange={(e) => setEditModal({ ...editModal, version: e.target.value })}
              maxLength={50}
              className={inputCls}
            />
          </Field>
          <Field label="描述（可选）">
            <AutoGrowTextarea
              value={editModal.description}
              onChange={(e) => setEditModal({ ...editModal, description: e.target.value })}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <Field label="替换文件（可选）" hint={editModal.file ? `新文件：${editModal.file.name}` : `当前文件：${editModal.filename}`}>
            <input
              type="file"
              accept={ALLOWED_EXTS.map((e) => `.${e}`).join(',')}
              onChange={(e) => setEditModal({ ...editModal, file: e.target.files?.[0] || null })}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-primary"
            />
          </Field>
        </Modal>
      )}

      {/* 移动目录弹窗 */}
      {moveModal && (
          <Modal
            title={`移动目录「${moveModal.name}」`}
            onClose={() => !moveSaving && setMoveModal(null)}
            footer={
              <>
                <Button size="sm" variant="secondary" disabled={moveSaving} onClick={() => setMoveModal(null)}>取消</Button>
                <Button
                  size="sm"
                  loading={moveSaving}
                  disabled={moveSaving || moveModal.targetParentId === (moveModal.currentParentId || 0)}
                  onClick={handleMoveSave}
                >
                  确认移动
                </Button>
              </>
            }
          >
            <Field
              label="选择新的父级目录"
              hint={
                moveLevelInfo.willChangeLevel
                  ? `层级将从 L${moveLevelInfo.currentLevel} 变为 L${moveLevelInfo.targetLevel}`
                  : `层级保持 L${moveLevelInfo.currentLevel}（≤ ${MAX_LEVEL}）`
              }
            >
              <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px]">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setMoveExpandedIds(new Set(moveExpandableIds))}
                >
                  展开全部
                </button>
                <span className="text-muted-foreground">|</span>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setMoveExpandedIds(new Set())}
                >
                  收起全部
                </button>
              </div>
              <div
                data-allow-scroll
                className="max-h-64 overflow-y-auto overscroll-contain rounded-md border border-border p-1.5"
              >
                {/* 根级选项 */}
                <button
                  type="button"
                  onClick={() => setMoveModal({ ...moveModal, targetParentId: 0 })}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                    moveModal.targetParentId === 0
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-transparent hover:bg-muted text-foreground'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      moveModal.targetParentId === 0 ? 'border-primary' : 'border-border'
                    }`}
                  >
                    {moveModal.targetParentId === 0 && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="font-medium">根级（最顶层）</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">L1</span>
                </button>
                {/* 目录树：点箭头逐级展开，点行选中为目标 */}
                {moveTargetList.length > 0 ? (
                  moveTargetList.map((n) => {
                    const selected = moveModal.targetParentId === n.id
                    const expanded = moveExpandedIds.has(n.id)
                    return (
                      <div
                        key={n.id}
                        className="flex items-center gap-0.5"
                        style={{ paddingLeft: `${4 + n.depth * 16}px` }}
                      >
                        {n.hasChildren ? (
                          <button
                            type="button"
                            title={expanded ? '折叠' : '展开'}
                            onClick={() => toggleMoveExpand(n.id)}
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {expanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        ) : (
                          <span className="inline-block w-[18px] shrink-0" aria-hidden />
                        )}
                        <button
                          type="button"
                          onClick={() => setMoveModal({ ...moveModal, targetParentId: n.id })}
                          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                            selected
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-transparent hover:bg-muted text-foreground'
                          }`}
                        >
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                              selected ? 'border-primary' : 'border-border'
                            }`}
                          >
                            {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                          </span>
                          {n.hasChildren ? (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
                          ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
                          )}
                          <span className="min-w-0 flex-1 truncate" title={n.name}>{n.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">L{n.level}</span>
                        </button>
                      </div>
                    )
                  })
                ) : (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    没有可选的目标目录
                  </div>
                )}
              </div>
            </Field>
            {moveLevelInfo.targetLevel > MAX_LEVEL && (
              <p className="mt-2 text-xs text-red-500">
                目标层级 L{moveLevelInfo.targetLevel} 超过上限 {MAX_LEVEL}，请选择更浅的父级
              </p>
            )}
          </Modal>
      )}

      {/* 批量移动材料弹窗 */}
      {batchMoveModal && (
        <Modal
          title={`批量移动 ${selectedIds.size > 0 ? `${selectedIds.size} 个材料` : ''}${selectedIds.size > 0 && selectedCatIds.size > 0 ? ' + ' : ''}${selectedCatIds.size > 0 ? `${selectedCatIds.size} 个目录` : ''}`}
          onClose={() => !batchMoving && setBatchMoveModal(null)}
          footer={
            <>
              <Button size="sm" variant="secondary" disabled={batchMoving} onClick={() => setBatchMoveModal(null)}>取消</Button>
              <Button
                size="sm"
                loading={batchMoving}
                disabled={batchMoving || batchMoveModal.targetCategoryId === null}
                onClick={handleBatchMove}
              >
                <Move className="h-3.5 w-3.5" />
                确认移动
              </Button>
            </>
          }
        >
          <Field
            label="目标目录"
            hint={
              selectedCatIds.size > 0
                ? '材料改挂到该目录；目录改挂为该目录的子目录（内含文件与子目录一并跟随，落盘文件不动）'
                : '所选材料将全部移动到该目录下（源目录保持不变，仅重挂目录索引）'
            }
          >
            <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px]">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setBatchMoveExpandedIds(new Set(batchMoveExpandableIds))}
              >
                展开全部
              </button>
              <span className="text-muted-foreground">|</span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setBatchMoveExpandedIds(new Set())}
              >
                收起全部
              </button>
            </div>
            <div
              data-allow-scroll
              className="max-h-72 overflow-y-auto overscroll-contain rounded-md border border-border p-1.5"
            >
              {/* 根级选项：仅目录可以移到最顶层，材料必须归属具体目录 */}
              {selectedCatIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => setBatchMoveModal({ targetCategoryId: 0 })}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                    batchMoveModal.targetCategoryId === 0
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-transparent hover:bg-muted text-foreground'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      batchMoveModal.targetCategoryId === 0 ? 'border-primary' : 'border-border'
                    }`}
                  >
                    {batchMoveModal.targetCategoryId === 0 && (
                      <span className="h-2 w-2 rounded-full bg-primary" />
                    )}
                  </span>
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="font-medium">根级（最顶层）</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">L1</span>
                </button>
              )}
              {batchMoveTargetList.length > 0 ? (
                batchMoveTargetList.map((n) => {
                  const selected = batchMoveModal.targetCategoryId === n.id
                  const expanded = batchMoveExpandedIds.has(n.id)
                  return (
                    <div
                      key={n.id}
                      className="flex items-center gap-0.5"
                      style={{ paddingLeft: `${4 + n.depth * 16}px` }}
                    >
                      {n.hasChildren ? (
                        <button
                          type="button"
                          title={expanded ? '折叠' : '展开'}
                          onClick={() => toggleBatchMoveExpand(n.id)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : (
                        <span className="inline-block w-[18px] shrink-0" aria-hidden />
                      )}
                      <button
                        type="button"
                        onClick={() => setBatchMoveModal({ targetCategoryId: n.id })}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                          selected
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-transparent hover:bg-muted text-foreground'
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            selected ? 'border-primary' : 'border-border'
                          }`}
                        >
                          {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        {n.hasChildren ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
                        )}
                        <span className="min-w-0 flex-1 truncate" title={n.name}>{n.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">L{n.level}</span>
                      </button>
                    </div>
                  )
                })
              ) : (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  没有可选的目标目录
                </div>
              )}
            </div>
          </Field>
          {batchMoveModal.targetCategoryId !== null && batchMoveModal.targetCategoryId !== undefined ? (
            <p className="mt-2 text-xs text-muted-foreground">
              将移动到：
              <b className="text-foreground">
                {batchMoveModal.targetCategoryId === 0
                  ? '根级（最顶层）'
                  : (catIndex.byId.get(batchMoveModal.targetCategoryId)?.name || '—')}
              </b>
              {batchMoveModal.targetCategoryId === 0 && selectedIds.size > 0 && (
                <span className="ml-1 text-amber-500">
                  （材料不能挂到根级，将只移动目录）
                </span>
              )}
            </p>
          ) : null}
        </Modal>
      )}

      {/* 使用教程 */}
      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="材料管理使用教程"
        subtitle="了解目录树浏览、上传材料、预览编辑与批量下载"
        sections={DELIVERABLE_TUTORIAL}
      />

      {/* 导出进度浮层 */}
      {exportProgress && (
        <div className="fixed bottom-6 right-6 z-[300] w-80 rounded-xl border border-border bg-card p-4 shadow-2xl">
          <div className="mb-2 flex items-center gap-2">
            <FolderArchive className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">
              {exportProgress.phase === 'packing' ? '正在打包目录' : '正在下载压缩包'}
            </span>
          </div>
          <div className="mb-1 text-xs text-muted-foreground">
            {exportProgress.phase === 'packing' ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                服务器正在递归打包「{exportProgress.name}」的文件…
              </span>
            ) : exportProgress.percent >= 0 ? (
              <span className="tabular-nums">{exportProgress.percent}%</span>
            ) : (
              <span className="tabular-nums">已下载 {fmtSize(exportProgress.loaded || 0)}</span>
            )}
          </div>
          {/* 进度条 */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            {exportProgress.phase === 'packing' ? (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" style={{ animation: 'slide 1.2s ease-in-out infinite' }} />
            ) : exportProgress.percent >= 0 ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${exportProgress.percent}%` }}
              />
            ) : (
              <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
            )}
          </div>
        </div>
      )}

      {/* 打包进度动画 keyframes */}
      <style>{`
        @keyframes slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </PageContainer>
  )
}
