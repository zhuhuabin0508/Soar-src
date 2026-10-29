// 全局 Toast 容器：固定在右上角（顶栏下方，留 12px 呼吸空间），渲染 toast 队列。
// 在 App.jsx 中挂载一次即可，任意位置调用 toast.success() 等均会在此显示。
//
// 视觉（对标 B 端设计系统）：
// - Toast 圆角 radius-md（6px）+ 0.5px 微边框（border-border/70）
// - 阴影用 popover 级柔和弥散投影（低透明度冷灰调，弃生硬的 shadow-xl）
// - 图标容器化：8×8 浅底深字（80% 法则）承载语义色，替代裸图标 + 左侧重色条
//
// 动画：
// - 入场 toast-enter：24px 小偏移 + 0.96→1 轻缩放 + 淡入，easeOutExpo 柔和减速停靠
// - 离场：leaving 状态 220ms 加速曲线淡出右移，快速让位
// - 底部 2px 语义色进度条线性收缩（时长 = toast duration），与倒计时同步
//
// 交互：
// - 悬停暂停倒计时与进度条（长内容阅读不被打断），移开按剩余时长恢复
// - 支持 onClick：点击卡片主体或操作按钮触发回调并关闭
import { useEffect } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Info, X, ArrowUpRight } from 'lucide-react'
import { useToastStore } from '../store/toastStore'

const VARIANT_STYLE = {
  success: {
    icon: <CheckCircle2 className="h-[18px] w-[18px] text-success" />,
    chip: 'bg-success/10',
    timer: 'bg-success/50',
  },
  error: {
    icon: <XCircle className="h-[18px] w-[18px] text-destructive" />,
    chip: 'bg-destructive/10',
    timer: 'bg-destructive/50',
  },
  warning: {
    icon: <AlertTriangle className="h-[18px] w-[18px] text-warning" />,
    chip: 'bg-warning/10',
    timer: 'bg-warning/50',
  },
  info: {
    icon: <Info className="h-[18px] w-[18px] text-info" />,
    chip: 'bg-info/10',
    timer: 'bg-info/50',
  },
}

// popover 级柔和弥散投影（设计系统 --shadow-popover 配方）
const SHADOW = '0 4px 6px -1px rgba(15, 23, 42, 0.06), 0 2px 4px -2px rgba(15, 23, 42, 0.05)'

function ToastItem({ item }) {
  const { dismiss, remove, pause, resume } = useToastStore.getState()
  const style = VARIANT_STYLE[item.variant] || VARIANT_STYLE.info

  // leaving 标记后等待动画再移除
  useEffect(() => {
    if (item.leaving) {
      const t = setTimeout(() => remove(item.id), 220)
      return () => clearTimeout(t)
    }
  }, [item.leaving, item.id, remove])

  const handleClick = () => {
    if (item.onClick) {
      item.onClick()
      dismiss(item.id)
    }
  }

  return (
    <div
      className={`pointer-events-auto relative flex w-80 items-start gap-3 overflow-hidden rounded-md border bg-card p-3.5 pb-4 ${
        item.leaving
          ? 'border-border/70 opacity-0 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.4,0,1,1)] translate-x-6 scale-[0.97]'
          : 'toast-enter border-border/70 opacity-100'
      } ${item.onClick ? 'cursor-pointer hover:border-primary/40' : ''}`}
      style={{ boxShadow: SHADOW }}
      role="alert"
      onClick={item.onClick ? handleClick : undefined}
      onMouseEnter={() => pause(item.id)}
      onMouseLeave={() => resume(item.id)}
    >
      {/* 语义图标：浅底容器承载（80% 浅底深字法则） */}
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] ${style.chip}`}>
        {style.icon}
      </span>
      <div className="min-w-0 flex-1">
        {item.title && (
          <div className="text-sm font-semibold leading-5 text-foreground">
            {item.title}
          </div>
        )}
        <div
          className={`text-[13px] leading-relaxed text-foreground/90 break-words ${
            item.title ? 'mt-1' : ''
          }`}
        >
          {item.message}
        </div>
        {item.onClick && item.actionLabel && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleClick()
            }}
            className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            {item.actionLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          dismiss(item.id)
        }}
        className="-mr-1 -mt-1 shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {/* 倒计时进度条：时长 = toast duration，悬停时与倒计时同步暂停 */}
      {item.duration > 0 && !item.leaving && (
        <span
          aria-hidden
          className={`toast-timer absolute bottom-0 left-0 right-0 h-[2px] origin-left ${style.timer}`}
          style={{
            animation: `toast-timer ${item.duration}ms linear forwards`,
            animationPlayState: item.paused ? 'paused' : 'running',
          }}
        />
      )}
    </div>
  )
}

export default function ToastContainer() {
  const items = useToastStore((s) => s.items)
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[100] flex flex-col gap-2.5">
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>
  )
}
