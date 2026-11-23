import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeSelectedKeys,
  removeSelectedKeys,
  toggleSelectedKey,
  toggleSelectedPage,
  isPageAllSelected,
  isPagePartiallySelected,
  toggleKeysInSet,
  isAllSelectedInSet,
} from './selection.js'

const PAGE1 = ['a', 'b', 'c']
const PAGE2 = ['d', 'e', 'f']

// 模拟一次真实的「第 1 页勾选 → 翻页 → 第 2 页勾选」操作
function selectRows(selected, keys, checked = true) {
  return keys.reduce((acc, key) => toggleSelectedKey(acc, key, checked), selected)
}

test('单页勾选与取消：只影响当前操作行', () => {
  let selected = selectRows([], ['a', 'b'])
  assert.deepEqual(selected, ['a', 'b'])

  selected = toggleSelectedKey(selected, 'a', false)
  assert.deepEqual(selected, ['b'])

  selected = toggleSelectedKey(selected, 'b', false)
  assert.deepEqual(selected, [])
})

test('连续多页勾选：第 1 页选择在翻到第 2 页后仍然保留', () => {
  let selected = selectRows([], PAGE1)
  assert.deepEqual(selected, PAGE1)

  // 翻页不改变 selectedKeys，继续在第 2 页勾选
  selected = selectRows(selected, PAGE2)
  assert.deepEqual(selected, [...PAGE1, ...PAGE2])
  assert.equal(selected.length, 6)
})

test('翻页后再次勾选：不产生重复项，历史勾选不丢失', () => {
  let selected = selectRows([], ['a'])
  selected = selectRows(selected, ['d'])
  // 回到第 1 页重新勾选已选项（checkbox 事件重复触发）
  selected = selectRows(selected, ['a'])
  assert.deepEqual(selected, ['a', 'd'])
  assert.equal(selected.length, 2)
})

test('跨页取消：取消第 1 页勾选保留第 2 页选项', () => {
  let selected = selectRows([], [...PAGE1, ...PAGE2])
  selected = toggleSelectedKey(selected, 'b', false)
  assert.deepEqual(selected, ['a', 'c', 'd', 'e', 'f'])

  // 回到第 1 页取消剩余两项，第 2 页仍保留
  selected = selectRows(selected, ['a', 'c'], false)
  assert.deepEqual(selected, PAGE2)
})

test('表头全选当前页：合并历史选择，不覆盖其它页', () => {
  const selected = toggleSelectedPage(['a', 'd'], PAGE2, true)
  assert.deepEqual(selected, ['a', 'd', 'e', 'f'])
})

test('表头取消当前页：只移除当前页，不影响其它页', () => {
  const selected = toggleSelectedPage(['a', 'b', 'd', 'e'], PAGE1, false)
  assert.deepEqual(selected, ['d', 'e'])
})

test('全选/取消同一页可反复切换，且不误删其它页', () => {
  let selected = toggleSelectedPage(['x'], PAGE1, true)
  assert.deepEqual(selected, ['x', ...PAGE1])

  selected = toggleSelectedPage(selected, PAGE1, false)
  assert.deepEqual(selected, ['x'])

  selected = toggleSelectedPage(selected, PAGE1, true)
  assert.deepEqual(selected, ['x', ...PAGE1])
})

test('翻页后当前页全选状态按页独立计算', () => {
  const selected = [...PAGE1, 'd']
  assert.equal(isPageAllSelected(selected, PAGE1), true)
  assert.equal(isPageAllSelected(selected, PAGE2), false)
  assert.equal(isPagePartiallySelected(selected, PAGE2), true)
  assert.equal(isPagePartiallySelected(selected, PAGE1), false)
})

test('空页 / 空选择集的判定与操作安全', () => {
  assert.equal(isPageAllSelected([], []), false)
  assert.equal(isPagePartiallySelected([], []), false)
  assert.deepEqual(toggleSelectedPage([], [], true), [])
  assert.deepEqual(removeSelectedKeys(['a'], []), ['a'])
  assert.deepEqual(mergeSelectedKeys(['a'], []), ['a'])
})

test('完整流程：多页选择 → 跨页取消 → 翻页再勾选 → 当前页全选/取消', () => {
  let selected = []

  // 第 1 页勾选 a、c
  selected = selectRows(selected, ['a', 'c'])
  // 翻到第 2 页勾选 d、f
  selected = selectRows(selected, ['d', 'f'])
  assert.deepEqual(selected, ['a', 'c', 'd', 'f'])

  // 回到第 1 页取消 a
  selected = toggleSelectedKey(selected, 'a', false)
  assert.deepEqual(selected, ['c', 'd', 'f'])

  // 第 2 页全选（e 加入），再取消整页（d、e、f 移除）
  selected = toggleSelectedPage(selected, PAGE2, true)
  assert.deepEqual(selected, ['c', 'd', 'f', 'e'])
  selected = toggleSelectedPage(selected, PAGE2, false)
  assert.deepEqual(selected, ['c'])

  // 翻回第 1 页全选，最终应为 a、b、c
  selected = toggleSelectedPage(selected, PAGE1, true)
  assert.deepEqual([...selected].sort(), [...PAGE1].sort())
})

test('Set 版本：自实现表格的跨页全选/取消语义与数组版本一致', () => {
  let selected = new Set(['x'])
  selected = toggleKeysInSet(selected, PAGE1, true)
  assert.deepEqual([...selected], ['x', 'a', 'b', 'c'])

  selected = toggleKeysInSet(selected, PAGE1, false)
  assert.deepEqual([...selected], ['x'])

  selected = toggleKeysInSet(selected, PAGE2, true)
  assert.deepEqual([...selected], ['x', 'd', 'e', 'f'])
  assert.equal(isAllSelectedInSet(selected, PAGE2), true)
  assert.equal(isAllSelectedInSet(selected, PAGE1), false)

  // 返回新 Set，不修改入参
  const original = new Set(['a'])
  toggleKeysInSet(original, ['b'], true)
  assert.deepEqual([...original], ['a'])
})
