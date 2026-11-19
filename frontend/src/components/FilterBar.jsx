// 统一列表筛选栏：搜索 + 自定义字段筛选 + 右侧操作区
// 配合 DataTable + Pagination + BatchActions 构成第三批「数据管理」列表基线。
//
// 用法：
//   <FilterBar
//     search={{ value, onChange, placeholder }}
//     filters={[{ key, label, value, onChange, options:[{value,label}] }]}
//     actions={<Button>新建</Button>}
//   />
import { CompactSelect, SearchInput } from './ui'

export function FilterBar({ search, filters = [], actions, className = '' }) {
  const hasSearch = !!search
  const hasFilters = filters.length > 0
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-3 ${className}`}>
      {hasSearch && (
        <SearchInput
          value={search.value}
          onChange={search.onChange}
          placeholder={search.placeholder || '搜索...'}
          className="min-w-[200px] flex-1"
          onClear={() => search.onChange('')}
          data-hotkey="search"
        />
      )}
      {hasFilters &&
        filters.map((f) => (
          <label key={f.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {f.label && <span className="whitespace-nowrap">{f.label}</span>}
            <CompactSelect
              size="sm"
              value={f.value}
              onChange={(e) => f.onChange(e.target.value)}
            >
              {f.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </CompactSelect>
          </label>
        ))}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export default FilterBar
