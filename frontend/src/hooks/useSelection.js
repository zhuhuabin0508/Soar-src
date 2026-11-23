// 批量选择 hook：管理跨页累计的选中 rowKey 集合，配合 DataTable 的 selectable 模式
//
// 用法：
//   const { selectedKeys, setSelectedKeys, clear, isSelected, count, toggle, toggleAll } = useSelection()
//   <DataTable selectable selectedKeys={selectedKeys} onSelectChange={setSelectedKeys} rowKey="id" />
//   <BatchActions selectedCount={count} onClear={clear} actions={[...]} />
//
// 跨页约定：selectedKeys 在翻页时保持不变；toggleAll(pageKeys, checked) 只合并/移除当前页，
// 不会覆盖其它页已勾选项。仅筛选条件或数据源变化时才由页面主动 clear()。
import { useState, useCallback, useMemo } from 'react'
import {
  mergeSelectedKeys,
  removeSelectedKeys,
  toggleSelectedKey,
  toggleSelectedPage,
} from '../utils/selection'

export function useSelection(initial = []) {
  const [selectedKeys, setSelectedKeys] = useState(initial)

  const clear = useCallback(() => setSelectedKeys([]), [])

  const isSelected = useCallback((key) => selectedKeys.includes(key), [selectedKeys])

  const count = selectedKeys.length

  // 批量替换：用于全选整个数据集（不限于当前页）
  const selectAll = useCallback((keys) => setSelectedKeys(keys), [])

  // 合并一批 keys（跨页追加，不丢失历史选择）
  const add = useCallback((keys) => {
    setSelectedKeys((prev) => mergeSelectedKeys(prev, keys))
  }, [])

  // 移除一批 keys（跨页取消，只影响指定项）
  const remove = useCallback((keys) => {
    setSelectedKeys((prev) => removeSelectedKeys(prev, keys))
  }, [])

  const toggle = useCallback((key, checked) => {
    setSelectedKeys((prev) => toggleSelectedKey(prev, key, checked))
  }, [])

  // 当前页全选/取消：只作用于当前页 keys，保留其它页已选
  const toggleAll = useCallback((pageKeys, checked) => {
    setSelectedKeys((prev) => toggleSelectedPage(prev, pageKeys, checked))
  }, [])

  const memo = useMemo(
    () => ({
      selectedKeys,
      count,
      clear,
      isSelected,
      selectAll,
      add,
      remove,
      toggle,
      toggleAll,
      setSelectedKeys,
    }),
    [selectedKeys, count, clear, isSelected, selectAll, add, remove, toggle, toggleAll],
  )

  return memo
}

export default useSelection
