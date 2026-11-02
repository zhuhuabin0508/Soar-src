/**
 * generate_document 工具产物解析（前端共享）。
 *
 * 从消息的工具调用结果中提取可下载的文档文件信息，供两处使用：
 * - ToolTimeline 的绿色文件卡片
 * - 对话正文中文件名点击下载（MarkdownRenderer 的 fileLinks 属性）
 */

/**
 * 解析单个工具调用的成功结果为文档文件信息。
 *
 * @param {object} tc 工具调用条目 { name, result, ... }
 *   result 可能是对象，也可能是 JSON 字符串（历史消息回放两种都出现）。
 * @returns {{ok: boolean, file_id: number, file_name: string,
 *            file_type?: string, file_size?: number}|null}
 *   仅 generate_document 成功（ok 且有 file_id）时返回结果，否则 null。
 */
export function parseDocFile(tc) {
  if (!tc || tc.name !== 'generate_document' || tc.result == null) return null
  let result = tc.result
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return null }
  }
  if (result && typeof result === 'object' && result.ok && result.file_id) return result
  return null
}

/**
 * 从消息的工具调用列表中收集全部可下载文档文件（按 file_id 去重，保持生成顺序）。
 *
 * @param {Array} toolCalls 消息上的 toolCalls 数组
 * @returns {Array<{file_id: number, file_name: string}>}
 */
export function collectDocFiles(toolCalls) {
  const files = []
  const seen = new Set()
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    const f = parseDocFile(tc)
    if (!f) continue
    const key = String(f.file_id)
    if (seen.has(key)) continue
    seen.add(key)
    files.push({ file_id: f.file_id, file_name: f.file_name || '' })
  }
  return files
}
