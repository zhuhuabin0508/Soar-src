/**
 * 会话列表纯函数边界测试（node --test）
 *
 * 回归目标：新建会话只能创建新的上下文，不得删除/清空该智能体下已存在的历史会话条目。
 * 运行：cd frontend && npm run test:chat
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  clearAllConversations,
  createConversation,
  deriveConversationTitle,
  fillConversationMessages,
  findConversation,
  normalizeConversations,
  startNewConversation,
  updateConversationMessages,
} from './chatConversations.js'

const msg = (id, role, content) => ({ id, role, content, timestamp: Number(id) || 0 })

function seed(list) {
  return list.map((c) => ({ ...c, messages: [...c.messages] }))
}

test('新建会话保留已有会话及其消息', () => {
  const first = createConversation({ sid: 's1', now: 100 })
  first.messages = [msg('1', 'user', '你好'), msg('2', 'assistant', '你好，有什么可以帮你')]
  first.title = deriveConversationTitle(first.messages)
  const { list, sid, created } = startNewConversation([first], 's1', { now: 200, sid: 's2' })

  assert.equal(created, true)
  assert.equal(sid, 's2')
  assert.equal(list.length, 2)
  // 新会话在头部且为空
  assert.deepEqual(list[0].messages, [])
  // 历史会话完整保留
  const kept = findConversation(list, 's1')
  assert.ok(kept)
  assert.equal(kept.messages.length, 2)
  assert.equal(kept.title, '你好')
})

test('同一智能体连续多次新建会话，全部历史条目都可切换查看', () => {
  let list = [createConversation({ sid: 's0', now: 10 })]
  list[0].messages = [msg('1', 'user', '第一轮'), msg('2', 'assistant', '第一轮回复')]
  let activeSid = 's0'

  const sids = []
  for (let i = 1; i <= 3; i += 1) {
    const result = startNewConversation(list, activeSid, { now: 100 + i, sid: `s${i}` })
    list = result.list
    activeSid = result.sid
    sids.push(result.sid)
    // 每次新建后都往新会话写入一轮消息，模拟真实使用
    list = updateConversationMessages(
      list,
      result.sid,
      [msg(`${i}0`, 'user', `第${i}个会话`), msg(`${i}1`, 'assistant', `回复${i}`)],
      100 + i
    )
  }

  assert.deepEqual(sids, ['s1', 's2', 's3'])
  assert.equal(list.length, 4)
  // 最初的会话没有被删除，内容仍完整
  const original = findConversation(list, 's0')
  assert.equal(original.messages.length, 2)
  assert.equal(original.messages[0].content, '第一轮')
  // 每个会话都能被找到（可切换）
  for (const sid of ['s0', ...sids]) {
    assert.ok(findConversation(list, sid), `会话 ${sid} 应保留`)
  }
  // 最近新建的会话在最前面
  assert.equal(list[0].sid, 's3')
})

test('当前会话仍为空白时重复新建不堆叠空会话', () => {
  const blank = createConversation({ sid: 'b1', now: 1 })
  const first = startNewConversation([blank], 'b1', { now: 2, sid: 'b2' })
  assert.equal(first.created, false)
  assert.equal(first.sid, 'b1')
  assert.equal(first.list.length, 1)
  const second = startNewConversation(first.list, first.sid, { now: 3, sid: 'b3' })
  assert.equal(second.created, false)
  assert.equal(second.list.length, 1)
})

test('更新消息只作用于目标会话，其它会话不受影响', () => {
  const a = createConversation({ sid: 'a', now: 1 })
  a.messages = [msg('1', 'user', 'A 会话')]
  const b = createConversation({ sid: 'b', now: 2 })
  b.messages = [msg('2', 'user', 'B 会话')]
  const before = seed([a, b])

  const next = updateConversationMessages([a, b], 'b', (prev) => [...prev, msg('3', 'assistant', 'B 回复')], 9)

  assert.equal(findConversation(next, 'a').messages.length, 1)
  assert.equal(findConversation(next, 'a').messages[0].content, 'A 会话')
  assert.equal(findConversation(next, 'b').messages.length, 2)
  assert.equal(findConversation(next, 'b').title, 'B 会话')
  // 原数组未被原地修改
  assert.equal(a.messages.length, 1)
  assert.equal(b.messages.length, 1)
  assert.deepEqual(before, [
    { ...a },
    { ...b },
  ])
})

test('服务端历史填充只补空会话，且不改变 updatedAt', () => {
  const empty = createConversation({ sid: 'restored', now: 100 })
  const already = createConversation({ sid: 'local', now: 200 })
  already.messages = [msg('1', 'user', '本地内容')]
  const serverMsgs = [msg('2', 'user', '服务端问题'), msg('3', 'assistant', '服务端回答')]

  const next = fillConversationMessages([empty, already], 'restored', serverMsgs)

  const restored = findConversation(next, 'restored')
  assert.equal(restored.messages.length, 2)
  // 只查看历史不应把旧会话顶到列表最前面
  assert.equal(restored.updatedAt, 100)
  assert.equal(restored.title, '服务端问题')
  assert.equal(restored.synced, true)
  // 本地已有消息的会话不被覆盖
  assert.equal(findConversation(next, 'local').messages[0].content, '本地内容')

  // 本地已有消息 / 服务端为空 / 目标不存在时都返回原数组（便于 React 跳过渲染）
  const list = [already]
  assert.equal(fillConversationMessages(list, 'local', serverMsgs), list)
  const untouched = [empty]
  assert.equal(fillConversationMessages(untouched, 'restored', []), untouched)
  assert.equal(fillConversationMessages(untouched, 'missing', serverMsgs), untouched)
})

test('会话不存在时更新返回原数组，避免误写入其它会话', () => {
  const only = createConversation({ sid: 'only', now: 1 })
  const list = [only]
  const result = updateConversationMessages(list, 'missing', [msg('1', 'user', 'x')], 5)
  assert.equal(result, list)
  assert.equal(findConversation(result, 'only').messages.length, 0)
})

test('updater 返回非法值时保持原会话不变', () => {
  const conv = createConversation({ sid: 'v', now: 1 })
  conv.messages = [msg('1', 'user', '保留内容')]
  const result = updateConversationMessages([conv], 'v', () => undefined, 2)
  assert.equal(result[0].messages.length, 1)
  assert.equal(result[0].messages[0].content, '保留内容')
})

test('标题取首条用户消息，去掉仅附件注入前缀并截断', () => {
  const messages = [
    msg('1', 'assistant', '欢迎'),
    msg('2', 'user', '[用户上传了以下文件，可使用 read_document 工具读取完整内容：\n- a.xlsx\n]\n\n请分析这张表'),
  ]
  assert.equal(deriveConversationTitle(messages), '请分析这张表')
  const long = [msg('1', 'user', '一'.repeat(50))]
  assert.equal(deriveConversationTitle(long, 10), `${'一'.repeat(10)}…`)
  assert.equal(deriveConversationTitle([]), '')
})

test('单个会话消息超上限时只保留最新消息', () => {
  const conv = createConversation({ sid: 'cap', now: 1 })
  const many = Array.from({ length: MAX_MESSAGES_PER_CONVERSATION + 10 }, (_, i) =>
    msg(String(i), i % 2 === 0 ? 'user' : 'assistant', `m${i}`)
  )
  const result = updateConversationMessages([conv], 'cap', many, 2)
  assert.equal(result[0].messages.length, MAX_MESSAGES_PER_CONVERSATION)
  assert.equal(result[0].messages[result[0].messages.length - 1].content, `m${MAX_MESSAGES_PER_CONVERSATION + 9}`)
})

test('会话条目超上限时只丢弃最旧条目，不丢当前会话', () => {
  const list = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => {
    const c = createConversation({ sid: `s${i}`, now: i })
    c.messages = [msg(String(i), 'user', `会话${i}`)]
    return c
  })
  const active = list[0]
  const { list: next, sid } = startNewConversation(list, active.sid, { now: 999, sid: 'fresh' })
  assert.equal(next.length, MAX_CONVERSATIONS)
  assert.equal(next[0].sid, 'fresh')
  assert.equal(sid, 'fresh')
  // 被丢弃的是最旧（尾部）条目
  assert.equal(findConversation(next, `s${MAX_CONVERSATIONS - 1}`), undefined)
  // 原当前会话仍保留
  assert.ok(findConversation(next, 's0'))
})

test('normalizeConversations 修正脏数据且不抛异常', () => {
  const raw = [
    null,
    'not-an-object',
    { title: '缺少 sid' },
    { sid: 'ok', messages: 'not-array', createdAt: 'bad' },
    { sid: 'ok', messages: [] }, // sid 重复，丢弃
    { sid: 'ok2', messages: [msg('1', 'user', '内容'), { nope: true }], title: '标题' },
  ]
  const result = normalizeConversations(raw)
  assert.deepEqual(result.map((c) => c.sid), ['ok', 'ok2'])
  assert.deepEqual(result[0].messages, [])
  assert.equal(result[1].messages.length, 1)
  assert.equal(result[1].title, '标题')
  assert.equal(normalizeConversations(null).length, 0)
})

test('normalizeConversations 保留同步标记：旧缓存有消息视为已同步，空白草稿不算', () => {
  const result = normalizeConversations([
    { sid: 'legacy-solid', messages: [msg('1', 'user', '旧缓存')], createdAt: 1, updatedAt: 2 },
    { sid: 'legacy-draft', messages: [], createdAt: 1, updatedAt: 2 },
    { sid: 'explicit', synced: true, messages: [], createdAt: 1, updatedAt: 2 },
    { sid: 'local-new', synced: false, messages: [], createdAt: 1, updatedAt: 2 },
  ])
  const bySid = Object.fromEntries(result.map((c) => [c.sid, c]))
  assert.equal(bySid['legacy-solid'].synced, true)
  assert.equal(bySid['legacy-draft'].synced, false)
  assert.equal(bySid['explicit'].synced, true)
  assert.equal(bySid['local-new'].synced, false)
  // 新建会话默认未同步，避免把本地草稿当作服务端已删会话
  assert.equal(createConversation({ sid: 'x' }).synced, false)
})

test('清空全部历史为显式操作，返回单条空白会话', () => {
  const list = clearAllConversations({ now: 7, sid: 'fresh' })
  assert.equal(list.length, 1)
  assert.equal(list[0].sid, 'fresh')
  assert.deepEqual(list[0].messages, [])
  assert.equal(list[0].createdAt, 7)
})
