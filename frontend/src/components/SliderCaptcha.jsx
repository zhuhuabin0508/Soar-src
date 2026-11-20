// 登录页滑块拼图验证码：拖动拼图块对准背景缺口，松手提交 x 坐标
// - 后端 GET /auth/captcha 返回 {captcha_id, image, slider_image, slider_y, slider_size}
// - 松手后调用父组件 onTry(x)（内部调 POST /auth/captcha/check 预校验，不消费验证码）：
//   passed → 显示「验证通过」并回调 onComplete(x)（父组件用 x 发起登录）
//   未对准 → 提示重试并复位滑块（背景不变，用户可重拖同一张图）
//   expired → 调 onRefresh 自动换图（同一图累计 5 次未对准会被后端作废）
// - 换图（image prop 变化）自动复位滑块位置与状态
// - Pointer Events 实现，同时支持鼠标与触摸屏拖动
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CheckCircle2, RefreshCw, Loader2, AlertCircle } from 'lucide-react'

// 与后端 captcha.py 常量一致（固定尺寸渲染，坐标即背景图像素坐标，无需缩放换算）
const BG_WIDTH = 300
const BG_HEIGHT = 150

export default function SliderCaptcha({
  image, sliderImage, sliderY, sliderSize = 44,
  verified, onTry, onComplete, onRefresh, disabled = false,
}) {
  const [offset, setOffset] = useState(0) // 拼图块当前 x 偏移（0 ~ BG_WIDTH-sliderSize）
  const [dragging, setDragging] = useState(false)
  const [checking, setChecking] = useState(false) // 松手后预校验请求进行中
  const [tryError, setTryError] = useState('') // 预校验失败提示（未对准等）
  const trackRef = useRef(null)

  // 换图自动复位：image 变化时清空滑块位置、错误提示与通过态
  useEffect(() => {
    setOffset(0)
    setDragging(false)
    setChecking(false)
    setTryError('')
  }, [image])

  // 拖动逻辑：pointerdown 记录起点；move/up 挂 window（合成事件与触摸均可靠）
  const handlePointerDown = useCallback((e) => {
    if (verified || disabled || checking) return
    e.preventDefault()
    // pointer capture 把后续事件锁定到轨道元素（真实拖动出轨道不丢事件）；失败不阻塞
    try { trackRef.current?.setPointerCapture(e.pointerId) } catch { /* 合成事件/老浏览器无 active pointer */ }
    setDragging(true)
    setTryError('')
  }, [verified, disabled, checking])

  const handlePointerMove = useCallback((e) => {
    if (!dragging || verified || disabled || checking) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    // 以滑轨左缘为原点换算目标 x（滑块按钮宽度与拼图块同尺寸）
    const x = e.clientX - rect.left - sliderSize / 2
    setOffset(Math.max(0, Math.min(BG_WIDTH - sliderSize, x)))
  }, [dragging, verified, disabled, checking, sliderSize])

  const handlePointerUp = useCallback(async () => {
    if (!dragging) return
    setDragging(false)
    // 拖动不足 2px 视为误触，自动复位
    if (offset < 2) {
      setOffset(0)
      return
    }
    if (verified || checking) return
    const x = Math.round(offset)
    setChecking(true)
    try {
      const res = (await onTry?.(x)) || {}
      if (res.passed) {
        setTryError('')
        onComplete?.(x) // 父组件置 verified=true 并发起登录
        return
      }
      // 未通过：复位滑块；验证图已作废时提示换图（onRefresh 会换图并复位）
      setOffset(0)
      if (res.expired) {
        setTryError('验证图已失效，已为您更换，请重新拖动')
        onRefresh?.()
      } else {
        setTryError('未对准缺口，请重新拖动')
      }
    } catch {
      setOffset(0)
      setTryError('校验服务暂时不可用，请重试')
    } finally {
      setChecking(false)
    }
  }, [dragging, offset, verified, checking, onTry, onComplete, onRefresh])

  // 拖动期间全局监听 move/up（合成事件无法 setPointerCapture，挂 window 保证可靠）
  useEffect(() => {
    if (!dragging) return undefined
    const move = (e) => handlePointerMove(e)
    const done = () => handlePointerUp()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
  }, [dragging, handlePointerMove, handlePointerUp])

  return (
    <div className="select-none">
      {/* 拼图区：背景图（含缺口）+ 浮动拼图块 */}
      <div className="relative w-[300px] overflow-hidden rounded-lg border border-border bg-muted"
        style={{ height: BG_HEIGHT }}>
        {image ? (
          <img src={image} alt="验证码背景" draggable={false}
            className="block h-full w-full" style={{ objectFit: 'fill' }} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
          </div>
        )}
        {sliderImage && (
          <img src={sliderImage} alt="拼图块" draggable={false}
            className="pointer-events-none absolute drop-shadow-md"
            style={{ left: offset, top: sliderY, width: sliderSize, height: sliderSize }} />
        )}
        {/* 预校验进行中遮罩 */}
        {checking && !dragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* 滑轨区 */}
      <div
        ref={trackRef}
        className={`relative mt-2 h-10 w-[300px] overflow-hidden rounded-lg border transition-colors ${
          verified ? 'border-emerald-500/50 bg-emerald-500/10'
            : tryError ? 'border-destructive/50 bg-destructive/5'
            : dragging ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted'
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* 轨道提示文案 */}
        {!verified && !checking && (
          <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 text-xs text-muted-foreground transition-opacity"
            style={{ opacity: dragging || offset > 0 ? 0 : 1 }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
            按住滑块拖动，对准缺口
          </span>
        )}
        {/* 校验中提示 */}
        {checking && !verified && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />正在校验...
          </span>
        )}
        {/* 已完成提示 */}
        {verified && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 text-xs font-medium text-emerald-500">
            <CheckCircle2 className="h-3.5 w-3.5" />验证通过
          </span>
        )}
        {/* 进度填充条 */}
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 rounded-lg transition-[background] ${
            verified ? 'bg-emerald-500/15' : 'bg-primary/10'
          }`}
          style={{ width: offset + sliderSize }}
        />
        {/* 滑块按钮 */}
        <div
          className={`absolute top-0 flex h-10 cursor-grab items-center justify-center rounded-lg border shadow-sm transition-colors active:cursor-grabbing ${
            verified
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-primary/50 bg-primary text-primary-foreground'
          } ${disabled || checking ? 'opacity-60' : ''}`}
          style={{ left: offset, width: sliderSize + 8, transform: 'translateX(-4px)' }}
        >
          {verified
            ? <CheckCircle2 className="h-4 w-4" />
            : checking
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <ChevronRight className={`h-4 w-4 ${dragging ? 'animate-pulse' : ''}`} />}
        </div>
      </div>

      {/* 预校验失败提示 */}
      {tryError && !verified && (
        <div className="mt-1.5 flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>{tryError}</span>
        </div>
      )}

      {/* 刷新按钮 */}
      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled || checking}
        className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground transition hover:text-primary disabled:opacity-50"
      >
        <RefreshCw className="h-3 w-3" />
        <span>看不清？点击刷新验证码</span>
      </button>
    </div>
  )
}
