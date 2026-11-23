// 数据密度切换器:紧凑/标准/宽松
//
// 全局共享(通过 densityStore),影响所有 DataTable 的行高、内边距、字号
// 持久化到 localStorage,跨页面 / 跨刷新保持
//
// 用法(放在 Pagination 旁边):
//   import DensitySwitcher from './DensitySwitcher'
//   <div className="flex items-center justify-between">
//     <DensitySwitcher />
//     <Pagination ... />
//   </div>
import { useState, useRef, useEffect } from 'react'
import { Rows3, Rows4, ChevronDown } from 'lucide-react'
import { useDensityStore } from '../store/densityStore'

const OPTIONS = [
  { value: 'compact', label: '紧凑', desc: '行高 32px', Icon: Rows3 },
  { value: 'standard', label: '标准', desc: '行高 44px', Icon: Rows4 },
  { value: 'comfortable', label: '宽松', desc: '行高 56px', Icon: Rows4 },
]

export default function DensitySwitcher({ className = '' }) {
  const density = useDensityStore((s) => s.density)
  const setDensity = useDensityStore((s) => s.setDensity)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const cur = OPTIONS.find((o) => o.value === density) || OPTIONS[1]
  const CurIcon = cur.Icon

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`数据密度：${cur.label}（行高 ${cur.desc.replace('行高 ', '')}）`}
        aria-label="切换数据密度"
        className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <CurIcon className="h-3.5 w-3.5" />
        <span>行高 {cur.desc.replace('行高 ', '')}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-dropdown mb-1 w-44 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
          <div className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            数据密度
          </div>
          {OPTIONS.map((opt) => {
            const Icon = opt.Icon
            const active = density === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setDensity(opt.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent ${
                  active ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <div className="flex-1">
                  <div className="text-xs font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.desc}</div>
                </div>
                {active && <span className="text-xs text-primary">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
