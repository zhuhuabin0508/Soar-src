/**
 * generate_document 工具产物解析测试（node --test）
 *
 * 回归目标：对话正文中文件名点击下载依赖从 toolCalls 里正确提取
 * {file_id, file_name}；历史消息的 result 可能是对象或 JSON 字符串，
 * 失败/非法结果必须返回 null 而不是抛错。
 *
 * 运行：cd frontend && npm run test:chat
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectDocFiles, parseDocFile } from './docFiles.js'

const okResult = { ok: true, file_id: 7, file_name: 'IP 风险研判汇总表.xlsx', file_type: 'xlsx', file_size: 2048 }

test('parseDocFile：对象结果正常提取', () => {
  const f = parseDocFile({ name: 'generate_document', result: okResult })
  assert.equal(f.file_id, 7)
  assert.equal(f.file_name, 'IP 风险研判汇总表.xlsx')
})

test('parseDocFile：result 为 JSON 字符串（历史消息回放）也能解析', () => {
  const f = parseDocFile({ name: 'generate_document', result: JSON.stringify(okResult) })
  assert.equal(f.file_id, 7)
  assert.equal(f.file_name, 'IP 风险研判汇总表.xlsx')
})

test('parseDocFile：非 generate_document 工具一律返回 null', () => {
  assert.equal(parseDocFile({ name: 'read_pdf', result: okResult }), null)
  assert.equal(parseDocFile({ name: 'search_assets', result: null }), null)
})

test('parseDocFile：失败或非法结果返回 null 且不抛错', () => {
  assert.equal(parseDocFile({ name: 'generate_document', result: { error: '内容为空' } }), null)
  assert.equal(parseDocFile({ name: 'generate_document', result: { ok: false, file_id: 1 } }), null)
  assert.equal(parseDocFile({ name: 'generate_document', result: { ok: true } }), null) // 缺 file_id
  assert.equal(parseDocFile({ name: 'generate_document', result: 'not-json{' }), null)
  assert.equal(parseDocFile(null), null)
})

test('collectDocFiles：按生成顺序收集并按 file_id 去重', () => {
  const files = collectDocFiles([
    { name: 'search_assets', result: { rows: 3 } },
    { name: 'generate_document', result: { ...okResult, file_id: 7 } },
    { name: 'generate_document', result: { ...okResult, file_id: 8, file_name: '风险清单.docx' } },
    { name: 'generate_document', result: { ...okResult, file_id: 7, file_name: '重复ID.xlsx' } },
  ])
  assert.deepEqual(files, [
    { file_id: 7, file_name: 'IP 风险研判汇总表.xlsx' },
    { file_id: 8, file_name: '风险清单.docx' },
  ])
})

test('collectDocFiles：空入参与全失败结果返回空数组', () => {
  assert.deepEqual(collectDocFiles(undefined), [])
  assert.deepEqual(collectDocFiles(null), [])
  assert.deepEqual(collectDocFiles([
    { name: 'generate_document', result: { error: '格式不支持' } },
    { name: 'generate_document' },
  ]), [])
})
