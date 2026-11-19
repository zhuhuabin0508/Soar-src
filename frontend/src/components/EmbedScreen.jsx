import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Maximize2, Minimize2, Monitor, RefreshCw } from 'lucide-react'
import { EmptyState } from './ui'
import { hasPermission } from '../utils/permissions'

const DESIGN_W = 1920
const DESIGN_H = 1080

export default function EmbedScreen({
  title,
  subtitle,
  perm,
  fetchUrl,
  loadLabel = '刷新',
}) {
  const canView = hasPermission(perm, 'view')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [fit, setFit] = useState({ scale: 1, w: DESIGN_W, h: DESIGN_H })
  const boxRef = useRef(null)
  const stageRef = useRef(null)

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await fetchUrl()
      const next = data?.url || ''
      if (!next) {
        setError('未获取到大屏地址')
        setUrl('')
        return
      }
      setUrl(next)
    } catch (err) {
      setUrl('')
      setError(err.message || `加载${title}失败`)
    } finally {
      setLoading(false)
    }
  }, [canView, fetchUrl, title])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const apply = () => {
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (!cw || !ch) return
      // 全屏时按 cover 铺满整屏（边缘少量裁切、无黑边）；
      // 窗口内按 contain 等比完整显示，保证内容不被裁掉
      const pick = document.fullscreenElement ? Math.max : Math.min
      const scale = pick(cw / DESIGN_W, ch / DESIGN_H)
      setFit({ scale, w: DESIGN_W * scale, h: DESIGN_H * scale })
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [loading, error, fullscreen])

  const toggleFull = async () => {
    const el = boxRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch {
      return
    }
  }

  if (!canView) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={Monitor} title={`无权访问${title}`} description={`请联系管理员开通「${title}」查看权限`} />
      </div>
    )
  }

  return (
    <div ref={boxRef} className="relative flex h-full min-h-0 flex-col bg-[#020d1a]">
      {/* 右上角操作区：全屏时默认隐藏，鼠标滑入才显示 */}
      <div
        className={`absolute right-3 top-3 z-20 flex items-center gap-1.5 transition-opacity duration-200 ${
          fullscreen ? 'opacity-0 hover:opacity-100 focus-within:opacity-100' : 'opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 rounded-md border border-white/15 bg-black/55 px-2 py-1 text-xs text-white/80 backdrop-blur-sm transition hover:border-primary/60 hover:text-primary disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          <span>{loadLabel}</span>
        </button>
        <button
          type="button"
          onClick={toggleFull}
          className="flex items-center gap-1 rounded-md border border-white/15 bg-black/55 px-2 py-1 text-xs text-white/80 backdrop-blur-sm transition hover:border-primary/60 hover:text-primary"
        >
          {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          <span>{fullscreen ? '退出全屏' : '全屏'}</span>
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-md border border-white/15 bg-black/55 px-2 py-1 text-xs text-white/80 backdrop-blur-sm transition hover:border-primary/60 hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" />
            <span>新窗口</span>
          </a>
        ) : null}
      </div>
      <div ref={stageRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {loading ? (
          <div className="text-sm text-muted-foreground">正在加载大屏…</div>
        ) : error ? (
          <EmptyState
            icon={Monitor}
            title={`无法打开${title}`}
            description={error}
            action={(
              <button type="button" onClick={load} className="btn-primary btn-sm">
                重试
              </button>
            )}
          />
        ) : (
          <div className="relative shrink-0" style={{ width: fit.w, height: fit.h }}>
            <iframe
              title={title}
              src={url}
              allow="fullscreen; autoplay"
              className="absolute left-0 top-0 origin-top-left border-0"
              style={{
                width: DESIGN_W,
                height: DESIGN_H,
                transform: `scale(${fit.scale})`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
