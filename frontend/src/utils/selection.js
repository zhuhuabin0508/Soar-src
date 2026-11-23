// 列表跨页多选状态工具
//
// 统一约定：
// - selectedKeys 是「跨页累计」的 rowKey 集合，翻页时不得整体覆盖或清空；
// - pageKeys 是当前页可见行的 rowKey；
// - 页内全选/取消只增量合并或移除当前页 keys，不能影响其它页已勾选项。
//
// 该模块为纯函数，供 DataTable、useSelection 及自实现表格（资产/材料等）共用，
// 便于用单元测试覆盖单页勾选、连续多页、跨页取消、翻页后再勾选等场景。

// 合并：保留历史已选，并追加新 keys（自动去重）
export function mergeSelectedKeys(selectedKeys = [], keys = []) {
  if (!keys.length) return selectedKeys
  return [...new Set([...selectedKeys, ...keys])]
}

// 移除：只删除指定 keys，其它页已选项保持不变
export function removeSelectedKeys(selectedKeys = [], keys = []) {
  if (!keys.length) return selectedKeys
  const removeSet = new Set(keys)
  return selectedKeys.filter((key) => !removeSet.has(key))
}

// 单行勾选/取消
export function toggleSelectedKey(selectedKeys = [], key, checked) {
  return checked
    ? mergeSelectedKeys(selectedKeys, [key])
    : removeSelectedKeys(selectedKeys, [key])
}

// 当前页全选/取消：只作用于 pageKeys，跨页已选保持不变
export function toggleSelectedPage(selectedKeys = [], pageKeys = [], checked) {
  return checked
    ? mergeSelectedKeys(selectedKeys, pageKeys)
    : removeSelectedKeys(selectedKeys, pageKeys)
}

// 当前页是否全部选中
export function isPageAllSelected(selectedKeys = [], pageKeys = []) {
  if (pageKeys.length === 0) return false
  const selectedSet = new Set(selectedKeys)
  return pageKeys.every((key) => selectedSet.has(key))
}

// 当前页是否部分选中（用于表头半选态）
export function isPagePartiallySelected(selectedKeys = [], pageKeys = []) {
  if (pageKeys.length === 0) return false
  const selectedSet = new Set(selectedKeys)
  let hit = 0
  for (const key of pageKeys) if (selectedSet.has(key)) hit += 1
  return hit > 0 && hit < pageKeys.length
}

// ===== Set 版本：供自实现表格使用（资产列表等） =====

// 在 Set 上批量勾选/取消，返回新 Set（不修改原对象）
export function toggleKeysInSet(prevSet, keys = [], checked) {
  const next = new Set(prevSet)
  for (const key of keys) {
    if (checked) next.add(key)
    else next.delete(key)
  }
  return next
}

// Set 中是否包含全部 keys
export function isAllSelectedInSet(selectedSet, keys = []) {
  if (keys.length === 0) return false
  return keys.every((key) => selectedSet.has(key))
}
