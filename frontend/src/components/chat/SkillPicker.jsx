/**
 * 技能快捷选择面板（对话输入框上方弹出）。
 *
 * 纯展示组件：技能过滤 / 分类分组 / 分批加载均由父组件（ChatInput）计算后传入，
 * 父组件借此统一处理输入框与搜索框中的键盘导航（↑↓ / Enter / Esc）。
 */
import { useEffect, useRef } from 'react'
import { Check, Search, Sparkles } from 'lucide-react'

export default function SkillPicker({
  open,
  loading,
  error,
  total,
  groups = [],
  hasMore,
  activeIndex,
  onHover,
  onSelect,
  onQueryChange,
  onLoadMore,
  onKeyDown,
  query = '',
  searchRef,
  showSearch = true,
}) {
  const listRef = useRef(null)

  // 键盘导航时保证高亮项可见（block:'nearest' 不打断用户滚动）
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector(`[data-skill-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      role="dialog"
      aria-label="技能选择"
    >
      {showSearch && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索技能名称 / 分类 / 标签"
            aria-label="搜索技能"
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {total} 个技能
          </span>
        </div>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label="技能列表"
        onScroll={(e) => {
          const el = e.currentTarget
          if (hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 48) onLoadMore?.()
        }}
        className="max-h-[45vh] overflow-y-auto overscroll-contain p-1.5 sm:max-h-72"
      >
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <span className="dot-pulse h-2 w-2 rounded-full bg-primary" />
            正在加载技能…
          </div>
        ) : error ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">{error}</div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {query ? '没有匹配的技能' : '暂无可用技能'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.category} className="mb-1 last:mb-0">
              <div className="sticky top-0 z-10 whitespace-nowrap bg-card px-2 py-1 text-xs text-muted-foreground">
                {group.category}
                <span className="ml-1 tabular-nums">({group.items.length})</span>
              </div>
              {group.items.map(({ skill, index }) => {
                const active = index === activeIndex
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-skill-index={index}
                    onMouseEnter={() => onHover?.(index)}
                    onClick={() => onSelect?.(skill)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
                      active ? 'bg-primary/10' : 'hover:bg-muted'
                    }`}
                  >
                    <Sparkles
                      className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <span className="shrink-0 whitespace-nowrap text-xs font-medium text-foreground">
                      {skill.name}
                    </span>
                    {skill.category && (
                      <span className="shrink-0 whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                        {skill.category}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs text-muted-foreground">
                      {skill.description || ''}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })}
            </div>
          ))
        )}
        {hasMore && !loading && (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full rounded-md px-2 py-1.5 text-center text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            滚动或点击加载更多…
          </button>
        )}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="whitespace-nowrap">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
    </div>
  )
}
