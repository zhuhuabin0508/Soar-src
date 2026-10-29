/**
 * 本地会话缓存测试（node --test）
 *
 * 回归目标：
 * - key 必须按「登录用户 + 智能体」隔离，同一浏览器切换账号不得串对话；
 * - 登出/凭证失效必须清空全部用户的对话缓存，不残留给后续使用者（访客）；
 * - 无痕模式 / 禁用存储 / 配额超限 / 脏 JSON 时必须优雅降级，不能抛异常。
 *
 * 运行：cd frontend && npm run test:chat
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activeSidKey,
  conversationsKey,
  loadActiveSid,
  loadConversations,
  purgeChatCaches,
  saveActiveSid,
  saveConversations,
} from './chatStorage.js'

/** 内存版 localStorage 替身 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
    dump: () => Object.fromEntries(map),
  }
}

/** 无痕模式/禁用存储：所有操作都抛异常 */
const blockedStorage = {
  getItem() { throw new Error('storage disabled') },
  setItem() { throw new Error('storage disabled') },
}

const conv = (sid, messages = []) => ({
  sid,
  title: messages[0]?.content || '',
  createdAt: 1,
  updatedAt: 1,
  messages,
})

test('会话 key 按用户和智能体双维度隔离', () => {
  assert.notEqual(conversationsKey(1, 10), conversationsKey(2, 10))
  assert.notEqual(conversationsKey(1, 10), conversationsKey(1, 11))
  assert.equal(conversationsKey(1, 10), conversationsKey('1', '10'))
  // 未登录（匿名）使用独立命名空间，不落进任何真实用户的 key
  assert.notEqual(conversationsKey(null, 10), conversationsKey(1, 10))
  assert.match(conversationsKey(null, 10), /anonymous/)
  assert.notEqual(activeSidKey(1, 10), activeSidKey(2, 10))
})

test('同一浏览器切换账号不会读到上一个账号的对话', () => {
  const storage = memoryStorage()
  saveConversations(storage, 1, 10, [conv('a-user', [{ role: 'user', content: '用户A的问题' }])])

  // 用户 B 首次登录，同一智能体应为空
  assert.deepEqual(loadConversations(storage, 2, 10), [])
  saveConversations(storage, 2, 10, [conv('b-user', [{ role: 'user', content: '用户B的问题' }])])

  // 两个账号各自的数据都完整保留，互不覆盖
  assert.equal(loadConversations(storage, 1, 10)[0].sid, 'a-user')
  assert.equal(loadConversations(storage, 2, 10)[0].sid, 'b-user')
  assert.equal(storage.dump()[conversationsKey(1, 10)].includes('用户A的问题'), true)
  assert.equal(storage.dump()[conversationsKey(2, 10)].includes('用户B的问题'), true)
})

test('活动会话 ID 同样按用户隔离', () => {
  const storage = memoryStorage()
  saveActiveSid(storage, 1, 10, 's-a')
  saveActiveSid(storage, 2, 10, 's-b')
  assert.equal(loadActiveSid(storage, 1, 10), 's-a')
  assert.equal(loadActiveSid(storage, 2, 10), 's-b')
  assert.equal(loadActiveSid(storage, 3, 10), '')
})

test('往返读写保持会话内容完整', () => {
  const storage = memoryStorage()
  const list = [
    conv('s1', [
      { id: 'm1', role: 'user', content: '问题', timestamp: 100 },
      { id: 'm2', role: 'assistant', content: '回答', timestamp: 200 },
    ]),
    conv('s2'),
  ]
  assert.equal(saveConversations(storage, 7, 3, list), true)
  assert.deepEqual(loadConversations(storage, 7, 3), list)
})

test('无痕模式（存储被禁用）读写都不抛异常', () => {
  assert.deepEqual(loadConversations(blockedStorage, 1, 10), [])
  assert.equal(saveConversations(blockedStorage, 1, 10, [conv('s')]), false)
  assert.equal(loadActiveSid(blockedStorage, 1, 10), '')
  assert.equal(saveActiveSid(blockedStorage, 1, 10, 's'), false)
  // storage 为空（SSR / 初始化失败）时也不能抛异常
  assert.deepEqual(loadConversations(null, 1, 10), [])
  assert.equal(saveConversations(undefined, 1, 10, []), false)
})

test('脏 JSON 与非法数据降级为空列表', () => {
  const storage = memoryStorage({ [conversationsKey(1, 10)]: '{not-json' })
  assert.deepEqual(loadConversations(storage, 1, 10), [])

  const storage2 = memoryStorage({ [conversationsKey(1, 10)]: '"just-a-string"' })
  assert.deepEqual(loadConversations(storage2, 1, 10), [])

  assert.equal(saveConversations(memoryStorage(), 1, 10, 'bad'), true)
  // 保存非数组时落盘为 []，下次读取仍是数组
  const storage3 = memoryStorage()
  saveConversations(storage3, 1, 10, null)
  assert.deepEqual(loadConversations(storage3, 1, 10), [])
})

test('不可序列化的会话内容不抛异常，返回写入失败', () => {
  const circular = conv('loop')
  circular.self = circular
  const storage = memoryStorage()
  // JSON.stringify 会因循环引用抛错：必须被捕获并按失败返回
  assert.equal(saveConversations(storage, 1, 10, [circular]), false)
  assert.deepEqual(loadConversations(storage, 1, 10), [])
})

test('登出清空全部用户的对话缓存，不影响无关 key', () => {
  const storage = memoryStorage()
  // 两个用户各自的对话缓存 + 活动会话
  saveConversations(storage, 1, 10, [conv('a-user', [{ role: 'user', content: '用户A的问题' }])])
  saveConversations(storage, 2, 10, [conv('b-user', [{ role: 'user', content: '用户B的问题' }])])
  saveActiveSid(storage, 1, 10, 's-a')
  // 无关 key 不应被波及
  storage.setItem('soar_token', 'token-value')
  storage.setItem('unrelated_key', 'keep-me')

  const removed = purgeChatCaches(storage)

  assert.equal(removed, 3)
  assert.deepEqual(loadConversations(storage, 1, 10), [])
  assert.deepEqual(loadConversations(storage, 2, 10), [])
  assert.equal(loadActiveSid(storage, 1, 10), '')
  assert.equal(storage.getItem('soar_token'), 'token-value')
  assert.equal(storage.getItem('unrelated_key'), 'keep-me')
})

test('清空缓存在存储禁用/缺失时不抛异常', () => {
  // blockedStorage 的 length 为 undefined：循环体不执行，静默返回 0
  assert.equal(purgeChatCaches(blockedStorage), 0)
  assert.equal(purgeChatCaches(null), 0)
  assert.equal(purgeChatCaches(undefined), 0)
  assert.equal(purgeChatCaches(memoryStorage()), 0)
})
