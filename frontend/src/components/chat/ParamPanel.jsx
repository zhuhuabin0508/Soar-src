/**
 * 参数设置面板（对标 new-api Playground 参数面板）
 *
 * Popover 弹出层，包含 6 个可独立开关的 LLM 参数：
 * temperature / top_p / max_tokens / frequency_penalty / presence_penalty / seed
 *
 * 借鉴 new-api 的"按需启用"模式：每个参数有独立开关，只有启用的才写入请求体，
 * 避免覆盖模型默认值。参数配置按 agentId 隔离持久化（由调用方管理 state）。
 *
 * Props:
 * - params: 当前参数配置对象 { temperature: { enabled, value }, ... }
 * - onChange: (nextParams) => void  更新参数（替换整个 params 对象）
 * - provider: 当前选中模型的 provider（anthropic/openai），用于禁用不支持的参数
 *              anthropic 不支持 frequency_penalty / presence_penalty / seed
 */
import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, X, RotateCcw, ChevronDown } from 'lucide-react'
import { PARAM_DEFS, defaultOverride } from '../../hooks/useChatOverrides'

export default function ParamPanel({ params = {}, onChange, provider = 'openai' }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  // 计算已启用参数数（用于触发按钮 Badge）
  const enabledCount = Object.values(params).filter((c) => c?.enabled).length

  // 点击外部关闭 Popover
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        popoverRef.current?.contains(e.target)
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // 切换某参数开关
  const toggleParam = (key) => {
    const cur = params[key] || { enabled: false, value: PARAM_DEFS[key]?.defaultValue }
    onChange({
      ...params,
      [key]: { ...cur, enabled: !cur.enabled },
    })
  }

  // 更新某参数值
  const updateParamValue = (key, value) => {
    const cur = params[key] || { enabled: false, value: PARAM_DEFS[key]?.defaultValue }
    onChange({
      ...params,
      [key]: { ...cur, value },
    })
  }

  // 重置全部：恢复默认（全部禁用 + 默认值）
  const resetAll = () => {
    onChange({ ...defaultOverride().params })
  }

  // Anthropic 不支持的参数（前端禁用并提示）
  const isUnsupported = (key) => {
    if (provider === 'anthropic') {
      return ['frequency_penalty', 'presence_penalty', 'seed'].includes(key)
    }
    return false
  }

  return (
    <div className="relative">
      {/* 触发按钮 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition ${
          enabledCount > 0
            ? 'border-primary/40 bg-muted text-foreground'
            : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        title="参数设置（仅本次会话生效）"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>参数</span>
        {enabledCount > 0 && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
            {enabledCount}
          </span>
        )}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Popover 弹出层 */}
      {open && (
        <>
          {/* 透明遮罩：仅用于捕获外部点击（实际由 useEffect 处理，此处兜底） */}
          <div className="fixed inset-0 z-dropdown" onClick={() => setOpen(false)} />
          <div
            ref={popoverRef}
            className="absolute right-0 top-9 z-dropdown w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                <span>参数设置</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground transition hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 参数列表 */}
            <div className="max-h-[60vh] overflow-y-auto px-3 py-2">
              {Object.entries(PARAM_DEFS).map(([key, def]) => {
                const cfg = params[key] || { enabled: false, value: def.defaultValue }
                const unsupported = isUnsupported(key)
                const disabled = !cfg.enabled || unsupported
                return (
                  <div
                    key={key}
                    className={`border-b border-border py-2 last:border-b-0 ${
                      disabled ? 'opacity-50' : ''
                    }`}
                  >
                    {/* 参数行头部：开关 + 名称 + 数值输入 */}
                    <div className="flex items-center gap-2">
                      {/* 自定义开关（复用 AgentEditor devMode 样式） */}
                      <button
                        type="button"
                        onClick={() => !unsupported && toggleParam(key)}
                        disabled={unsupported}
                        className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                          cfg.enabled && !unsupported
                            ? 'bg-primary'
                            : 'bg-secondary'
                        } ${unsupported ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={unsupported ? `${def.label}（当前模型不支持）` : undefined}
                      >
                        <span
                          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                            cfg.enabled && !unsupported ? 'left-3.5' : 'left-0.5'
                          }`}
                        />
                      </button>

                      {/* 参数名 */}
                      <span className="shrink-0 text-xs font-medium text-foreground">
                        {def.label}
                      </span>

                      {/* 数值输入（右侧） */}
                      <input
                        type="number"
                        value={cfg.value ?? ''}
                        min={def.min}
                        max={def.max}
                        step={def.step}
                        disabled={disabled}
                        onChange={(e) => {
                          const v = e.target.value
                          updateParamValue(key, v === '' ? null : Number(v))
                        }}
                        className="ml-auto h-6 w-16 shrink-0 rounded border border-border bg-secondary px-1.5 text-right text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed"
                      />
                    </div>

                    {/* 描述 + 滑块 */}
                    <div className="mt-1 pl-9">
                      <div className="text-xs text-muted-foreground">
                        {unsupported ? (
                          <span className="text-warning">当前模型（Anthropic）不支持此参数</span>
                        ) : (
                          def.desc
                        )}
                      </div>
                      {!unsupported && key !== 'seed' && (
                        <input
                          type="range"
                          value={cfg.value ?? def.min}
                          min={def.min}
                          max={def.max}
                          step={def.step}
                          disabled={!cfg.enabled}
                          onChange={(e) => updateParamValue(key, Number(e.target.value))}
                          className="mt-1 w-full accent-primary disabled:opacity-50"
                        />
                      )}
                      {/* seed 无滑块（数值范围太大，仅数字输入） */}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 底部操作 */}
            <div className="flex items-center justify-between border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={resetAll}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                <span>重置全部</span>
              </button>
              <span className="text-xs text-muted-foreground">
                已启用 {enabledCount} / 6
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                完成
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
