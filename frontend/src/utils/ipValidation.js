// IP / CIDR / 范围 / 通配 前端统一校验（与后端 app/core/ip_validation.py 规则一致）
//
// 合法输入：
// - IPv4 / IPv6 单地址
// - CIDR（IPv4 前缀下限 /8；IPv6 不限）
// - IPv4 范围：a.b.c.d-e.f.g.h 或末段简写 a.b.c.1-100；跨度上限 2^24 个地址
//   （IPv4 约一个 /8；IPv6 范围沿用同一上限）
// - IPv4 末段通配：10.0.0.* / 10.0.*.* / 10.*.*.*（拒绝 *.*.*.* 与中间通配）
// - 多值：逗号 / 分号 / 顿号 / 空白分隔
// 非法输入：主机名、待定、N/A、端口、注释、前导零等文本
//
// 提供「即时校验」：返回 null 表示合法，否则返回可直接展示的中文错误消息。

export const IPV4_CIDR_MIN_PREFIX = 8
export const IPV4_RANGE_MAX_ADDRS = 2 ** 24
export const MAX_EXPRESSION_LEN = 2048

const SEPARATOR_RE = /[,;，；、\s]+/
const OCTET_RE = /^(?:0|[1-9]\d{0,2})$/
const PREFIX_RE = /^\d{1,3}$/

function labelOf(label) {
  return label ? `字段'${label}'` : 'IP 字段'
}

function fail(message) {
  return { ok: false, error: message }
}

export function splitIPExpression(value) {
  const s = value === null || value === undefined ? '' : String(value).trim()
  if (!s) return []
  return s.split(SEPARATOR_RE).map((p) => p.trim()).filter(Boolean)
}

function parseIPv4(s) {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const p of parts) {
    if (!OCTET_RE.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function parseIPv6(s) {
  if (!s.includes(':')) return null
  if (s.includes('%')) return null // 拒绝 zone id（fe80::1%eth0）
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part) => {
    if (part === '') return []
    const out = []
    const groups = part.split(':')
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i]
      if (g.includes('.')) {
        // 末尾内嵌 IPv4（::ffff:192.0.2.1）
        if (i !== groups.length - 1) return null
        const v4 = parseIPv4(g)
        if (v4 === null) return null
        out.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
        out.push(parseInt(g, 16))
      }
    }
    return out
  }
  const head = parseGroups(halves[0])
  if (head === null) return null
  let tail = []
  if (halves.length === 2) {
    tail = parseGroups(halves[1])
    if (tail === null) return null
  }
  let groups
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill(0), ...tail]
  } else {
    groups = head
    if (groups.length !== 8) return null
  }
  let value = 0n
  for (const g of groups) value = (value << 16n) | BigInt(g)
  return value
}

function parseAddress(s, version) {
  return version === 6 ? parseIPv6(s) : parseIPv4(s)
}

function detectVersion(s) {
  return s.includes(':') ? 6 : 4
}

function parseWildcard(token) {
  const parts = token.split('.')
  if (parts.length !== 4) return fail('通配格式需为四段，如 10.0.0.*')
  const values = []
  let stars = 0
  let metStar = false
  for (const part of parts) {
    if (part === '*') {
      stars += 1
      metStar = true
      continue
    }
    if (metStar) return fail('通配符只能出现在末尾连续段（如 10.0.*.*）')
    if (!OCTET_RE.test(part)) return fail('通配前必须是合法 IPv4 段（0-255，无前导零）')
    const n = Number(part)
    if (n > 255) return fail('通配前必须是合法 IPv4 段（0-255，无前导零）')
    values.push(n)
  }
  if (stars === 0) return fail('不是通配格式')
  if (stars > 3 || values.length === 0) {
    return fail('通配不能覆盖全部四段（*.*.*.*），至少保留一段固定前缀')
  }
  let start = 0n
  let end = 0n
  for (let i = 0; i < 4; i += 1) {
    if (i < values.length) {
      start = (start << 8n) | BigInt(values[i])
      end = (end << 8n) | BigInt(values[i])
    } else {
      start = start << 8n
      end = (end << 8n) | 255n
    }
  }
  return { ok: true, interval: { version: 4, start, end, kind: 'wildcard', text: token } }
}

/** 解析单个片段；返回 {ok, interval} 或 {ok:false, error} */
export function parseIPToken(token, opts = {}) {
  const allowCidr = opts.allowCidr !== false
  const allowRange = opts.allowRange !== false
  const allowWildcard = opts.allowWildcard !== false
  const elem = String(token ?? '').trim()
  if (!elem) return fail('为空')
  if (elem.includes('%')) return fail('不支持带 zone id 的地址')

  if (elem.includes('*')) {
    if (!allowWildcard) return fail('不支持通配符')
    return parseWildcard(elem)
  }

  if (elem.includes('/')) {
    if (!allowCidr) return fail('不支持 CIDR 网段')
    const pieces = elem.split('/')
    if (pieces.length !== 2 || !PREFIX_RE.test(pieces[1])) {
      return fail('不是合法的网段（CIDR）格式')
    }
    const addrStr = pieces[0]
    const version = detectVersion(addrStr)
    const maxBits = version === 6 ? 128 : 32
    const prefix = Number(pieces[1])
    if (prefix > maxBits) return fail('不是合法的网段（CIDR）格式')
    const addr = parseAddress(addrStr, version)
    if (addr === null) return fail('不是合法的网段（CIDR）格式')
    if (version === 4 && prefix < IPV4_CIDR_MIN_PREFIX) {
      return fail(
        `掩码 /${prefix} 过小（疑似笔误）；IPv4 网段前缀不得小于 /${IPV4_CIDR_MIN_PREFIX}`,
      )
    }
    const bits = BigInt(maxBits)
    const hostBits = bits - BigInt(prefix)
    let start = addr
    let end = addr
    if (hostBits > 0n) {
      const mask = ((1n << bits) - 1n) ^ ((1n << hostBits) - 1n)
      start = addr & mask
      end = start | ((1n << hostBits) - 1n)
    }
    return {
      ok: true,
      interval: {
        version,
        start,
        end,
        kind: 'cidr',
        // IPv6 归一化为小写，但必须保留前缀（/64），否则归一化值丢失网段
        text: version === 6 ? `${addrStr.toLowerCase()}/${prefix}` : elem,
      },
    }
  }

  if (elem.includes('-')) {
    if (!allowRange) return fail('不支持 IP 范围')
    if (elem.split('-').length !== 2) return fail('范围格式不合法（应为 起始IP-结束IP）')
    const [startStr, endStr] = elem.split('-').map((p) => p.trim())
    if (!startStr || !endStr) return fail('范围缺少起始或结束地址')
    const version = detectVersion(elem)
    const start = parseAddress(startStr, version)
    if (start === null) {
      return fail(`范围起始地址无效：'${startStr}'（需完整 ${version === 6 ? 'IPv6' : 'IPv4'}）`)
    }
    let end = null
    if (version === 4 && /^\d+$/.test(endStr)) {
      const last = Number(endStr)
      if (last <= 255) {
        end = (start & ~0xffn) | BigInt(last)
      }
    } else {
      end = parseAddress(endStr, version)
    }
    if (end === null) {
      return fail(`范围结束地址无效：'${endStr}'（需完整 ${version === 6 ? 'IPv6' : 'IPv4'} 或末段数字）`)
    }
    if (start > end) return fail('起始 IP 大于结束 IP（倒置范围，疑似丢字/笔误）')
    const span = end - start + 1n
    if (span > BigInt(IPV4_RANGE_MAX_ADDRS)) {
      return fail(
        `范围跨度过大（${IPV4_RANGE_MAX_ADDRS.toLocaleString('en-US')} 个地址上限），疑似笔误`,
      )
    }
    return {
      ok: true,
      interval: {
        version,
        start,
        end,
        kind: 'range',
        text: version === 6 ? `${startStr.toLowerCase()}-${endStr.toLowerCase()}` : elem,
      },
    }
  }

  const version = detectVersion(elem)
  const addr = parseAddress(elem, version)
  if (addr === null) {
    return fail('不是合法的 IP 地址（支持 IPv4/IPv6/CIDR/范围/通配，不支持主机名、待定、N/A 等文本）')
  }
  return {
    ok: true,
    interval: {
      version,
      start: addr,
      end: addr,
      kind: 'single',
      text: version === 6 ? elem.toLowerCase() : elem,
    },
  }
}

/** 解析多值表达式：{ok, normalized, intervals} 或 {ok:false,error} */
export function parseIPExpression(value, opts = {}) {
  const label = opts.label || ''
  const s = value === null || value === undefined ? '' : String(value).trim()
  if (!s) return { ok: true, normalized: '', intervals: [] }
  if (s.length > (opts.maxLen || MAX_EXPRESSION_LEN)) {
    return fail(`${labelOf(label)}过长（${s.length} > ${opts.maxLen || MAX_EXPRESSION_LEN} 字符），请拆分后重试`)
  }
  const intervals = []
  const texts = []
  const tokens = splitIPExpression(s)
  if (tokens.length === 0) {
    // 仅由分隔符组成（如 "," / "；"）不是空值，属于误输入（与后端一致）
    return fail(`${labelOf(label)}不是合法的 IP 表达式（请输入 IP / CIDR / 范围）`)
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const elem = tokens[i]
    const where = `${labelOf(label)}第${i + 1}段 '${elem}' `
    const res = parseIPToken(elem, opts)
    if (!res.ok) return fail(`${where}${res.error}`)
    intervals.push(res.interval)
    texts.push(res.interval.text)
  }
  if (opts.allowMulti === false && intervals.length > 1) {
    return fail(`${labelOf(label)}只允许填写一个地址`)
  }
  return { ok: true, normalized: texts.join(','), intervals }
}

/** 校验并归一化；合法返回 null，非法返回中文错误消息 */
export function validateIPExpression(value, label = '', opts = {}) {
  const res = parseIPExpression(value, { label, ...opts })
  return res.ok ? null : res.error
}

/** 单个 IP（拒绝 CIDR/范围/通配/多值/文本） */
export function validateSingleIP(value, label = '', opts = {}) {
  const s = value === null || value === undefined ? '' : String(value).trim()
  if (!s) return opts.allowEmpty ? null : `${labelOf(label)}不能为空`
  const res = parseIPExpression(s, {
    label,
    allowCidr: false,
    allowRange: false,
    allowWildcard: false,
  })
  if (!res.ok) return res.error
  if (res.intervals.length > 1) return `${labelOf(label)}只允许填写一个 IP 地址`
  if (res.intervals.length === 0) return `${labelOf(label)}不是合法的 IP 地址` // 防御
  return null
}

/** 监听地址：空 / 单 IPv4 / 单 IPv6（含 0.0.0.0、::） */
export function validateListenBind(value, label = '监听地址') {
  return validateSingleIP(value, label, { allowEmpty: true })
}

/** 封禁目标：单 IP / CIDR / 范围 / 多值；不允许通配 */
export function validateBanTarget(value, label = '封禁目标') {
  return validateIPExpression(value, label, { allowWildcard: false })
}

/** IP/CIDR 列表（告警 in_cidr）：不允许范围与通配 */
export function validateCidrList(value, label = '') {
  return validateIPExpression(value, label, { allowRange: false, allowWildcard: false })
}

const IP_LIKE_KEY_RE = /^(?:[a-z0-9]+_)*(?:ip|ips|cidr|cidrs|eip|eips|ipaddr|ipaddress|ipv4|ipv6)$/
// 「IP 词 + 地址词」组合（ip_address / ipv4_addr / src_ip_addr 等）；
// 地址词前必须有 IP 词，避免把裸 address（如 email_address）当成 IP 字段
const IP_ADDR_KEY_RE = /^(?:[a-z0-9]+_)*(?:ip|ips|ipv4|ipv6|eip|eips)_(?:addr|addrs|address|addresses)$/

/** 字段 key 是否像 IP 字段（无模板/extra_fields 兜底校验用） */
export function looksLikeIPKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (!k) return false
  if (IP_LIKE_KEY_RE.test(k) || IP_ADDR_KEY_RE.test(k)) return true
  return /(?:^|_)(?:ip|ips|cidr|cidrs|eip|eips)$/.test(k)
}

/** 模板字段是否是 IP 字段（type=ip/cidr 或映射到标准 ip 列） */
export function isIPFieldDef(fdef) {
  if (!fdef) return false
  return (
    fdef.type === 'ip' ||
    fdef.type === 'cidr' ||
    String(fdef.mapped_to || '') === 'standard:ip'
  )
}
