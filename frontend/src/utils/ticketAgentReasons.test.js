import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_REASON_MODULES, parseAgentReasonModules } from './ticketAgentReasons.js'

const FULL = [
  '【处置建议】建议立即封禁 1.2.3.4，边界防火墙入向阻断 24 小时。',
  '【监测要点】监测 1.2.3.4 的 HTTP 高频请求与并发突增，方向外到内。',
  '【情报现状与触发条件】知道创宇置信度 0.85；若置信度降至 0.6 以下需重新研判。',
  '【责任归属】境外地址，无内部资产归属。',
  '【协同处置】通知网络运营组复核近 7 天会话。',
]

test('模块名与顺序固定', () => {
  assert.deepEqual(AGENT_REASON_MODULES, [
    '处置建议', '监测要点', '情报现状与触发条件', '责任归属', '协同处置',
  ])
})

test('标准五条：逐条精准映射，无错位', () => {
  const { modules, matched } = parseAgentReasonModules(FULL)
  assert.equal(matched, true)
  assert.equal(modules['处置建议'], '建议立即封禁 1.2.3.4，边界防火墙入向阻断 24 小时。')
  assert.equal(modules['监测要点'], '监测 1.2.3.4 的 HTTP 高频请求与并发突增，方向外到内。')
  assert.equal(modules['情报现状与触发条件'], '知道创宇置信度 0.85；若置信度降至 0.6 以下需重新研判。')
  assert.equal(modules['责任归属'], '境外地址，无内部资产归属。')
  assert.equal(modules['协同处置'], '通知网络运营组复核近 7 天会话。')
})

test('单条含多个模块：仍能正确拆分', () => {
  const text = '【处置建议】封禁。\n【监测要点】观测 80 端口。'
  const { modules } = parseAgentReasonModules([text])
  assert.equal(modules['处置建议'], '封禁。')
  assert.equal(modules['监测要点'], '观测 80 端口。')
  assert.equal(modules['责任归属'], '')
})

test('容忍序号、冒号与括号内空白', () => {
  const { modules } = parseAgentReasonModules([
    '1. 【 处置建议 】：封禁该 IP。',
    '2）【监测要点】: 观测并发。',
  ])
  assert.equal(modules['处置建议'], '：封禁该 IP。')
  assert.equal(modules['监测要点'], ': 观测并发。')
})

test('缺失模块为空串，其余不受影响', () => {
  const { modules } = parseAgentReasonModules([
    '【处置建议】封禁。',
    '【协同处置】通知部门。',
  ])
  assert.equal(modules['处置建议'], '封禁。')
  assert.equal(modules['监测要点'], '')
  assert.equal(modules['情报现状与触发条件'], '')
  assert.equal(modules['责任归属'], '')
  assert.equal(modules['协同处置'], '通知部门。')
})

test('输出顺序错乱：按模块名归属，不按位置错配', () => {
  const { modules } = parseAgentReasonModules([
    '【协同处置】先写协同。',
    '【责任归属】再写归属。',
    '【处置建议】最后写处置。',
  ])
  assert.equal(modules['协同处置'], '先写协同。')
  assert.equal(modules['责任归属'], '再写归属。')
  assert.equal(modules['处置建议'], '最后写处置。')
  assert.equal(modules['监测要点'], '')
})

test('保留内容原始换行与标点', () => {
  const body = '第一行：封禁。\n第二行：时长 24 小时；标注工单号。\n第三行：复核。'
  const { modules } = parseAgentReasonModules([`【处置建议】${body}`])
  assert.equal(modules['处置建议'], body)
})

test('同模块重复出现：按顺序合并，不丢内容', () => {
  const { modules } = parseAgentReasonModules([
    '【监测要点】第一部分。',
    '【监测要点】第二部分。',
  ])
  assert.equal(modules['监测要点'], '第一部分。\n第二部分。')
})

test('无模块前缀的旧格式：不臆造字段，matched=false', () => {
  const { modules, matched } = parseAgentReasonModules(['该 IP 存在风险，建议封禁。'])
  assert.equal(matched, false)
  AGENT_REASON_MODULES.forEach((name) => assert.equal(modules[name], ''))
})

test('空值/字符串输入不抛错', () => {
  for (const input of [null, undefined, '', [], '【监测要点】观测。']) {
    const { modules } = parseAgentReasonModules(input)
    AGENT_REASON_MODULES.forEach((name) => assert.equal(typeof modules[name], 'string'))
  }
  assert.equal(parseAgentReasonModules('【监测要点】观测。').modules['监测要点'], '观测。')
})

test('正文中的其他书名号不被误切', () => {
  const { modules } = parseAgentReasonModules([
    '【责任归属】命中资产「Nginx 代理服务器」，归属【市政数局】。',
  ])
  assert.equal(modules['责任归属'], '命中资产「Nginx 代理服务器」，归属【市政数局】。')
  assert.equal(modules['处置建议'], '')
})
