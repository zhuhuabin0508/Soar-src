/**
 * 服务端会话同步纯函数测试（node --test）
 *
 * 回归目标：换浏览器登录后，服务端会话必须能合并进本地列表并拉取消息；
 * 同时本地已有内容不能被覆盖或误删，时间序正确。
 *
 * 运行：cd frontend && npm run test:chat
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mergeServerSessions,
  serverSessionsToConversations,
  toDisplayMessages,
  toMillis,
} from './chatSync.js'

const localConv = (sid, { title = '', createdAt = 1, updatedAt = createdAt, messages = [], ...rest } = {}) => ({
  sid,
  title,
  createdAt,
  updatedAt,
  messages,
  ...rest,
})

test('服务端时间解析：带时区 ISO 与毫秒时间戳都能转成毫秒', () => {
  assert.equal(toMillis('2026-10-29T10:00:00+08:00'), Date.parse('2026-10-29T02:00:00Z'))
  assert.equal(toMillis(1234), 1234)
  assert.equal(toMillis(undefined, 9), 9)
  assert.equal(toMillis('bad-date', 9), 9)
})

test('服务端会话结构转换：过滤非法/重复条目', () => {
  const out = serverSessionsToConversations([
    null,
    'x',
    { session_id: '  ' },
    { session_id: 's1', title: '标题1', created_at: '2026-10-29T10:00:00+08:00', updated_at: '2026-10-29T11:00:00+08:00' },
    { session_id: 's1', title: '重复' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].sid, 's1')
  assert.equal(out[0].title, '标题1')
  assert.deepEqual(out[0].messages, [])
  assert.equal(out[0].updatedAt, Date.parse('2026-10-29T03:00:00Z'))
  // 服务端存在的会话标记为已同步
  assert.equal(out[0].synced, true)
})

test('合并：本地曾同步过的会话若服务端已删除，则移除本地残留', () => {
  const local = [
    localConv('deleted-elsewhere', {
      synced: true,
      messages: [{ id: 'm1', role: 'user', content: '别处删掉的会话', timestamp: 1 }],
    }),
    localConv('local-draft', { messages: [] }),
  ]
  const { list, missingSids } = mergeServerSessions(local, [])
  assert.deepEqual(list.map((c) => c.sid), ['local-draft'])
  assert.deepEqual(missingSids, [])
})

test('合并：服务端独有会话追加并列入 missingSids，本地已有会话保留消息', () => {
  const local = [
    localConv('local-1', {
      title: '本地标题',
      updatedAt: 100,
      messages: [{ id: 'm1', role: 'user', content: '本地内容', timestamp: 100 }],
    }),
  ]
  const server = [
    { session_id: 'local-1', title: '', created_at: '1970-01-01T00:00:00+00:00', updated_at: '2026-10-29T10:00:00+08:00' },
    { session_id: 'server-1', title: 'B 浏览器的问题', created_at: '2026-10-28T10:00:00+08:00', updated_at: '2026-10-28T10:05:00+08:00' },
  ]

  const { list, missingSids } = mergeServerSessions(local, server)

  assert.deepEqual(missingSids, ['server-1'])
  assert.equal(list.length, 2)
  const kept = list.find((c) => c.sid === 'local-1')
  // 本地消息完整保留，标题不被空标题覆盖，时间取较大值
  assert.equal(kept.messages.length, 1)
  assert.equal(kept.title, '本地标题')
  assert.equal(kept.updatedAt, Date.parse('2026-10-29T02:00:00Z'))
  // 服务端独有会话进入列表但消息为空（由调用方按 missingSids 拉取）
  const restored = list.find((c) => c.sid === 'server-1')
  assert.deepEqual(restored.messages, [])
  assert.equal(restored.title, 'B 浏览器的问题')
  // 按 updatedAt 倒序
  assert.equal(list[0].sid, 'local-1')
})

test('合并：时间以服务端为准，本地时钟偏差不会导致排序错乱', () => {
  const skewedNow = Date.parse('2035-01-01T00:00:00Z')
  const local = [localConv('s1', { updatedAt: skewedNow })]
  const server = [
    { session_id: 's1', created_at: '2026-10-01T10:00:00+08:00', updated_at: '2026-10-02T10:00:00+08:00' },
    { session_id: 's2', created_at: '2026-10-03T10:00:00+08:00', updated_at: '2026-10-03T10:00:00+08:00' },
  ]

  const { list } = mergeServerSessions(local, server)
  assert.equal(list[0].sid, 's2')
  assert.equal(list.find((c) => c.sid === 's1').updatedAt, Date.parse('2026-10-02T02:00:00Z'))
})

test('合并：分页快照不完整时不得把本地已同步会话当成已删除', () => {
  const local = [
    localConv('still-on-later-page', {
      synced: true,
      messages: [{ id: 'm1', role: 'user', content: '本页没有但后面还有', timestamp: 1 }],
    }),
  ]
  // 只拿到第一页（不完整）：即使本页没有该会话也不能删除本地记录
  const { list } = mergeServerSessions(local, [], { allowRemoteDeletion: false })
  assert.deepEqual(list.map((c) => c.sid), ['still-on-later-page'])
  // 完整快照才允许按服务端结果删除
  const complete = mergeServerSessions(local, [], { allowRemoteDeletion: true })
  assert.deepEqual(complete.list, [])
})

test('合并：本地有、服务端没有的会话不删除（如刚新建未发送）', () => {
  const local = [localConv('draft'), localConv('old')]
  const { list, missingSids } = mergeServerSessions(local, [])
  assert.deepEqual(list.map((c) => c.sid), ['draft', 'old'])
  assert.deepEqual(missingSids, [])
})

test('合并：超过上限只保留最新条目，missingSids 不包含被截断会话', () => {
  const local = [localConv('local-new', { updatedAt: 50 })]
  const server = [
    { session_id: 's1', updated_at: '2026-10-29T10:00:00+08:00' },
    { session_id: 's2', updated_at: '2026-10-29T09:00:00+08:00' },
    { session_id: 's3', updated_at: '2026-10-29T08:00:00+08:00' },
  ]
  const { list, missingSids } = mergeServerSessions(local, server, { max: 2 })
  assert.equal(list.length, 2)
  assert.equal(list[0].sid, 's1')
  // s3 被截断，不能返回给调用方去拉取（避免无效请求）
  assert.deepEqual(missingSids.sort(), ['s1', 's2'])
})

test('空/非法输入安全降级', () => {
  assert.deepEqual(mergeServerSessions(null, null), { list: [], missingSids: [] })
  assert.deepEqual(serverSessionsToConversations(null), [])
})

test('服务端消息转换：只保留 user/assistant，补齐 call_id 与时间戳', () => {
  // 接口返回的已是展示结构（timestamp 为带时区 ISO 字符串）
  const rows = [
    { id: 1, role: 'user', content: '请查一下', timestamp: '2026-10-29T10:00:00+08:00' },
    {
      id: 2,
      role: 'assistant',
      content: '查询完成',
      timestamp: '2026-10-29T10:00:01+08:00',
      toolCalls: [
        { id: 'call-1', name: 'search_assets', args: { q: 'x' }, status: 'done', result: 'ok' },
      ],
    },
    { id: 3, role: 'tool', content: '工具结果', timestamp: '2026-10-29T10:00:02+08:00' },
    { id: 4, role: 'assistant', content: '', timestamp: '2026-10-29T10:00:03+08:00' },
    { id: 5, role: 'system', content: '忽略我' },
  ]

  const msgs = toDisplayMessages(rows, 0)
  assert.equal(msgs.length, 2)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant'])
  assert.equal(msgs[0].timestamp, Date.parse('2026-10-29T02:00:00Z'))
  assert.equal(msgs[1].toolCalls.length, 1)
  // 服务端 id -> 前端 call_id，时间线组件按 call_id 渲染
  assert.equal(msgs[1].toolCalls[0].call_id, 'call-1')
  assert.equal(msgs[1].toolCalls[0].name, 'search_assets')
})

test('服务端消息转换：无工具调用时不产生空 toolCalls 字段', () => {
  const msgs = toDisplayMessages([{ id: 1, role: 'assistant', content: '普通回答' }], 0)
  assert.equal(msgs.length, 1)
  assert.equal('toolCalls' in msgs[0], false)
  assert.deepEqual(toDisplayMessages(null), [])
})
