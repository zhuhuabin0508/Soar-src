// Word / Excel 浏览器内预览：docx-preview 渲染 Word，SheetJS 渲染表格
import { useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { renderAsync } from 'docx-preview'
import * as XLSX from 'xlsx'

const EXCEL_MAX_ROWS = 2000
const EXCEL_MAX_COLS = 80
const ZOOM_MIN = 50
const ZOOM_MAX = 160
const ZOOM_STEP = 10

function colLetter(n) {
  let s = ''
  let x = n + 1
  while (x > 0) {
    const m = (x - 1) % 26
    s = String.fromCharCode(65 + m) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

function ZoomBar({ scale, onFit, onChange }) {
  const pct = Math.round(scale * 100)
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        disabled={pct <= ZOOM_MIN}
        onClick={() => onChange(Math.max(ZOOM_MIN, pct - ZOOM_STEP))}
        title="缩小"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">{pct}%</span>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        disabled={pct >= ZOOM_MAX}
        onClick={() => onChange(Math.min(ZOOM_MAX, pct + ZOOM_STEP))}
        title="放大"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onFit}
        title="适应宽度"
      >
        <RotateCcw className="mr-0.5 inline h-3 w-3" />
        适应
      </button>
    </div>
  )
}

function DocxView({ buffer }) {
  const scrollRef = useRef(null)
  const hostRef = useRef(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState('fit')
  const [fitScale, setFitScale] = useState(1)
  const [manualPct, setManualPct] = useState(100)

  const scale = mode === 'fit' ? fitScale : manualPct / 100

  const measureFit = () => {
    const scroll = scrollRef.current
    const page = hostRef.current?.querySelector('section.docx')
    if (!scroll || !page) return
    const available = Math.max(240, scroll.clientWidth - 48)
    const pageW = page.scrollWidth || page.offsetWidth
    if (pageW > 0) setFitScale(Math.min(1, available / pageW))
  }

  useEffect(() => {
    const el = hostRef.current
    if (!el || !buffer) return
    el.innerHTML = ''
    setError('')
    setReady(false)
    let alive = true
    renderAsync(buffer, el, undefined, {
      className: 'docx-preview-body',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    })
      .then(() => {
        if (!alive) return
        setReady(true)
        requestAnimationFrame(measureFit)
      })
      .catch(() => {
        if (alive) setError('Word 文档解析失败，请下载后查看')
      })
    return () => {
      alive = false
      el.innerHTML = ''
    }
  }, [buffer])

  useEffect(() => {
    if (!ready) return
    const scroll = scrollRef.current
    if (!scroll) return
    const ro = new ResizeObserver(() => {
      if (mode === 'fit') measureFit()
    })
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [ready, mode])

  if (error) {
    return <p className="p-6 text-center text-sm text-red-500">{error}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted px-3 py-1.5">
        <span className="text-xs text-muted-foreground">Word 预览</span>
        <ZoomBar
          scale={scale}
          onFit={() => {
            setMode('fit')
            requestAnimationFrame(measureFit)
          }}
          onChange={(pct) => {
            setMode('manual')
            setManualPct(pct)
          }}
        />
      </div>
      <div ref={scrollRef} className="docx-preview-scroll min-h-0 flex-1 overflow-auto">
        <div
          className="docx-preview-scale"
          style={{ zoom: scale }}
        >
          <div ref={hostRef} className="docx-preview-host" />
        </div>
      </div>
    </div>
  )
}

function ExcelView({ buffer }) {
  const parsed = useMemo(() => {
    try {
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
      return { wb, names: wb.SheetNames || [], error: '' }
    } catch {
      return { wb: null, names: [], error: 'Excel 解析失败，请下载后查看' }
    }
  }, [buffer])

  const [idx, setIdx] = useState(0)
  const [zoomPct, setZoomPct] = useState(100)

  useEffect(() => {
    setIdx(0)
    setZoomPct(100)
  }, [buffer])

  const grid = useMemo(() => {
    if (!parsed.wb || !parsed.names[idx]) {
      return { rows: [], colCount: 0, truncated: false, totalRows: 0, totalCols: 0 }
    }
    const sheet = parsed.wb.Sheets[parsed.names[idx]]
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
    const totalRows = raw.length
    const totalCols = raw.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    const sliced = raw.slice(0, EXCEL_MAX_ROWS).map((r) => {
      const row = Array.isArray(r) ? r.slice(0, EXCEL_MAX_COLS) : []
      while (row.length < Math.min(totalCols, EXCEL_MAX_COLS)) row.push('')
      return row
    })
    return {
      rows: sliced,
      colCount: Math.min(totalCols, EXCEL_MAX_COLS),
      truncated: totalRows > EXCEL_MAX_ROWS || totalCols > EXCEL_MAX_COLS,
      totalRows,
      totalCols,
    }
  }, [parsed, idx])

  if (parsed.error) {
    return <p className="p-6 text-center text-sm text-red-500">{parsed.error}</p>
  }
  if (!parsed.names.length) {
    return <p className="p-6 text-center text-sm text-muted-foreground">该工作簿没有工作表</p>
  }

  return (
    <div className="excel-preview-root flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {grid.totalRows} 行 · {grid.totalCols} 列
          {grid.truncated ? `（预览最多 ${EXCEL_MAX_ROWS} 行 / ${EXCEL_MAX_COLS} 列）` : ''}
        </span>
        <ZoomBar
          scale={zoomPct / 100}
          onFit={() => setZoomPct(100)}
          onChange={setZoomPct}
        />
      </div>
      <div className="excel-preview min-h-0 flex-1 overflow-auto">
        <table style={{ zoom: zoomPct / 100 }}>
          <thead>
            <tr>
              <th className="excel-gutter" />
              {Array.from({ length: grid.colCount }, (_, c) => (
                <th key={c}>{colLetter(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r}>
                <th className="excel-gutter">{r + 1}</th>
                {Array.from({ length: grid.colCount }, (_, c) => (
                  <td key={c} title={row[c] != null ? String(row[c]) : ''}>
                    {row[c] != null && row[c] !== '' ? String(row[c]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="excel-sheets flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-t border-border px-1 py-1">
        {parsed.names.map((name, i) => (
          <button
            key={`${name}-${i}`}
            type="button"
            onClick={() => setIdx(i)}
            className={`excel-sheet-tab ${i === idx ? 'is-active' : ''}`}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function OfficePreview({ buffer, ext }) {
  if (ext === 'docx') return <DocxView buffer={buffer} />
  if (ext === 'xlsx' || ext === 'xls') return <ExcelView buffer={buffer} />
  return <p className="p-6 text-center text-sm text-muted-foreground">不支持的办公文档类型</p>
}
