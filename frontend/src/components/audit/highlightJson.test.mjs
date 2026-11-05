import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'AuditLogsPanel.jsx'), 'utf8')
const matched = src.match(/function highlightJson\(jsonStr\) \{[\s\S]*?\n\}/)
if (!matched) {
  throw new Error('highlightJson not found')
}
const highlightJson = new Function(`${matched[0]}\nreturn highlightJson`)()
const html = highlightJson('{"path":"/api/v1/<img src=x onerror=alert(1)>"}')
if (html.includes('<img') || html.includes('<script')) {
  throw new Error(`html was not escaped: ${html}`)
}
if (!html.includes('&lt;img') || !html.includes('&gt;')) {
  throw new Error(`expected escaped tags: ${html}`)
}
console.log('highlight-ok')
