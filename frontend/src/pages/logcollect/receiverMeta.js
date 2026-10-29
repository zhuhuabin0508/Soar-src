// 日志采集三层信息架构共享元数据（接收器 / 数据源条目 / 解析模板）
// 与后端 AdapterRegistry / entry_registry.LISTEN_PROTOCOLS 声明保持一致

// 监听型协议：按来源 IP 自动生成条目
export const LISTEN_PROTOCOLS = new Set(['syslog', 'snmp_trap', 'netflow', 'pcap'])

// 源类型元数据：flat=true 沿用独立扁平列（syslog_port / kafka_*）；
// 其余类型配置统一存 adapter_config（JSON），fields 驱动动态表单
export const SOURCE_TYPE_META = {
  syslog: { label: 'Syslog 监听', flat: true },
  kafka: { label: 'Kafka 消费', flat: true },
  snmp_trap: {
    label: 'SNMP Trap 接收',
    hint: '接收交换机/防火墙等设备主动上报的 SNMP Trap 事件（UDP）',
    fields: [
      { key: 'port', label: '监听端口', type: 'number', placeholder: '1162', hint: '默认 1162，避开特权端口 162；需与发送端目标端口一致' },
      { key: 'bind', label: '监听地址', type: 'ip', placeholder: '0.0.0.0', hint: '0.0.0.0 监听所有接口' },
      { key: 'entry_discovery', label: '条目自动发现', type: 'bool', defaultTrue: true, full: true, hint: '按来源 IP 自动生成数据源条目，未配置的条目跟随接收器默认模板（日志零丢失）' },
      { key: 'entry_max_count', label: '条目数量上限', type: 'number', placeholder: '1000', hint: '超过上限后新来源不再建条目，走接收器默认配置' },
    ],
  },
  netflow: {
    label: 'NetFlow 接收',
    hint: '接收路由器/交换机的 NetFlow v5/v9 与 IPFIX 流量记录（UDP）',
    fields: [
      { key: 'port', label: '监听端口', type: 'number', placeholder: '2055', hint: 'NetFlow 常用 2055，IPFIX 为 4739；需与发送端一致' },
      { key: 'bind', label: '监听地址', type: 'ip', placeholder: '0.0.0.0' },
      { key: 'versions', label: '启用版本', placeholder: 'v5,v9,ipfix', hint: '逗号分隔，默认全部启用' },
      { key: 'entry_discovery', label: '条目自动发现', type: 'bool', defaultTrue: true, full: true, hint: '按 Exporter 来源 IP 自动生成数据源条目，未配置的条目跟随接收器默认模板' },
      { key: 'entry_max_count', label: '条目数量上限', type: 'number', placeholder: '1000', hint: '超过上限后新来源不再建条目，走接收器默认配置' },
    ],
  },
  file_tail: {
    label: '日志文件跟踪',
    hint: 'tail -F 跟踪后端所在主机日志文件增量，自动处理轮转/截断，游标断点续读',
    fields: [
      { key: 'path', label: '文件路径', required: true, full: true, placeholder: '/var/log/app/*.log', hint: '支持 glob 通配符，可匹配多个文件' },
      { key: 'encoding', label: '文件编码', placeholder: 'utf-8' },
      { key: 'poll_interval_seconds', label: '轮询间隔（秒）', type: 'number', placeholder: '2' },
      { key: 'from_beginning', label: '从文件头读起', type: 'bool', hint: '默认从文件末尾只读新增行' },
    ],
  },
  rest_api: {
    label: 'REST API 拉取',
    hint: '定时调用第三方接口分页拉取告警/日志，游标自动持久化、失败不推进（不丢数据）',
    fields: [
      { key: 'base_url', label: '接口基础地址', required: true, full: true, placeholder: 'https://api.example.com', hint: '含协议与主机，不含路径' },
      { key: 'path', label: '请求路径', placeholder: '/api/v1/alerts' },
      { key: 'method', label: '请求方法', type: 'select', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }] },
      { key: 'poll_interval_seconds', label: '拉取间隔（秒）', type: 'number', placeholder: '30' },
      { key: 'records_path', label: '记录数组路径', full: true, placeholder: 'data.items', hint: '响应 JSON 中记录数组的点分路径；留空则整个响应作为一条记录' },
      { key: 'pagination', label: '分页方式', type: 'select', options: [{ value: 'none', label: '不分页' }, { value: 'page', label: '页码递增' }, { value: 'cursor', label: '游标翻页' }] },
      { key: 'cursor_path', label: '游标字段路径', placeholder: 'data.next_cursor', hint: '仅游标翻页时需要' },
      { key: 'timeout', label: '请求超时（秒）', type: 'number', placeholder: '15' },
      { key: 'auth.type', label: '认证方式', type: 'select', options: [
        { value: 'none', label: '无认证' }, { value: 'basic', label: 'Basic' },
        { value: 'bearer', label: 'Bearer Token' }, { value: 'api_key', label: 'API Key 请求头' },
      ] },
      { key: 'auth.username', label: 'Basic 用户名', showIf: (c) => getCfg(c, 'auth.type') === 'basic' },
      { key: 'auth.password', label: 'Basic 密码', showIf: (c) => getCfg(c, 'auth.type') === 'basic' },
      { key: 'auth.token', label: 'Bearer Token', full: true, showIf: (c) => getCfg(c, 'auth.type') === 'bearer' },
      { key: 'auth.key', label: 'API Key 头名', placeholder: 'X-API-Key', showIf: (c) => getCfg(c, 'auth.type') === 'api_key' },
      { key: 'auth.value', label: 'API Key 值', showIf: (c) => getCfg(c, 'auth.type') === 'api_key' },
      { key: 'headers', label: '附加请求头(JSON)', type: 'json', full: true, placeholder: '{"X-Tenant": "soc"}' },
      { key: 'params', label: '查询参数(JSON)', type: 'json', full: true, placeholder: '{"page_size": 100}' },
      { key: 'body_template', label: 'POST 请求体模板(JSON)', type: 'json', full: true, placeholder: '{"since": "2026-01-01"}' },
      { key: 'verify_tls', label: '校验 TLS 证书', type: 'bool', hint: '默认关闭，兼容自签证书环境' },
    ],
  },
  jdbc: {
    label: '数据库拉取',
    hint: '定时查询第三方数据库增量拉取（水位断点续拉，失败不推进水位不丢数据）',
    fields: [
      { key: 'url', label: '数据库连接串', required: true, full: true, placeholder: 'mysql+pymysql://user:pass@host:3306/db', hint: 'SQLAlchemy URL 格式' },
      { key: 'query', label: '查询 SQL', required: true, type: 'textarea', full: true, placeholder: 'SELECT * FROM alerts WHERE id > :since ORDER BY id LIMIT :limit', hint: ':since 自动绑定为上次拉取水位，:limit 为批量大小' },
      { key: 'cursor_column', label: '水位列名', placeholder: 'id', hint: '自增 ID 或时间列；默认取结果集首列' },
      { key: 'initial_cursor', label: '首次拉取起点', placeholder: 'latest', hint: 'latest=从最新开始 / earliest=从最旧开始 / 直接填起始值' },
      { key: 'poll_interval_seconds', label: '轮询间隔（秒）', type: 'number', placeholder: '10' },
      { key: 'batch_size', label: '单次批量上限', type: 'number', placeholder: '1000' },
    ],
  },
  pcap: {
    label: '端口镜像抓包',
    hint: 'scapy 抓取流量摘要（五元组+标志位），容器需 NET_RAW 能力，Windows 需 Npcap',
    fields: [
      { key: 'iface', label: '监听网卡', placeholder: 'eth0', hint: '留空使用默认接口' },
      { key: 'bpf_filter', label: 'BPF 过滤器', placeholder: 'ip 或 tcp port 514' },
      { key: 'emit_mode', label: '上报模式', type: 'select', options: [{ value: 'batch', label: '批量聚合' }, { value: 'per_packet', label: '逐包上报' }] },
      { key: 'batch_size', label: '批量大小', type: 'number', placeholder: '50', hint: '仅批量模式生效' },
      { key: 'include_payload', label: '记录载荷样本', type: 'bool', hint: '保存前 64 字节十六进制载荷' },
      { key: 'entry_discovery', label: '条目自动发现', type: 'bool', defaultTrue: true, full: true, hint: '按对端 IP 自动生成数据源条目；逐包模式来源较多时建议控制上限' },
      { key: 'entry_max_count', label: '条目数量上限', type: 'number', placeholder: '1000', hint: '超过上限后新来源不再建条目，走接收器默认配置' },
    ],
  },
}

// 协议标签配色
export const PROTOCOL_TAG_CLS = {
  syslog: 'bg-primary/15 text-primary',
  kafka: 'bg-purple-500/15 text-purple-400',
  snmp_trap: 'bg-amber-500/15 text-amber-400',
  netflow: 'bg-cyan-500/15 text-cyan-400',
  file_tail: 'bg-emerald-500/15 text-emerald-400',
  rest_api: 'bg-blue-500/15 text-blue-400',
  jdbc: 'bg-indigo-500/15 text-indigo-400',
  pcap: 'bg-rose-500/15 text-rose-400',
}

// 接收器运行状态徽标元数据
export const RECEIVER_STATUS_META = {
  running: { label: '运行中', cls: 'bg-success/15 text-success' },
  listening: { label: '监听中', cls: 'bg-success/15 text-success' },
  binding: { label: '绑定端口中', cls: 'bg-primary/15 text-primary' },
  connecting: { label: '连接中', cls: 'bg-primary/15 text-primary' },
  stopped: { label: '已停止', cls: 'bg-secondary text-muted-foreground' },
  start_failed: { label: '启动失败', cls: 'bg-destructive/15 text-destructive' },
  failed: { label: '运行异常', cls: 'bg-destructive/15 text-destructive' },
  unconfigured: { label: '未配置', cls: 'bg-secondary text-muted-foreground' },
}

// 数据源条目三态（+停用）状态元数据
export const ENTRY_STATUS_META = {
  pending: { label: '待配置', cls: 'bg-warning/15 text-warning', desc: '自动发现后尚未配置设备归属与解析模板' },
  active: { label: '已接入', cls: 'bg-success/15 text-success', desc: '已配置并正常接收解析' },
  parse_error: { label: '解析异常', cls: 'bg-destructive/15 text-destructive', desc: '今日存在解析失败日志（fail/unknown），即使另有成功也计入，请检查解析模板与校验规则' },
  disabled: { label: '已停用', cls: 'bg-secondary text-muted-foreground', desc: '停用后该来源日志将被丢弃' },
}

// 解析状态徽标（接收日志明细 / 日志预览共用）
export const PARSE_STATUS_META = {
  received: { label: '已接收', cls: 'bg-secondary text-muted-foreground' },
  success: { label: '解析成功', cls: 'bg-success/15 text-success' },
  partial: { label: '部分解析', cls: 'bg-warning/15 text-warning' },
  fail: { label: '解析失败', cls: 'bg-destructive/15 text-destructive' },
  unknown: { label: '未知类型', cls: 'bg-warning/15 text-warning' },
}

// 设备类型中文映射（条目页设备类型列）
export const DEVICE_TYPE_LABELS = {
  firewall: '防火墙', waf: 'WAF', ips: 'IPS', ids: 'IDS',
  edr: 'EDR', soar: 'SOAR', custom: '自定义',
}

// adapter_config 读写：支持点分路径（auth.type），空值删除键以回落后端默认
export function parseAdapterConfig(v) {
  if (!v) return {}
  if (typeof v === 'object') return { ...v }
  try { return JSON.parse(v) || {} } catch { return {} }
}

export function getCfg(cfg, key) {
  let cur = cfg || {}
  for (const k of String(key).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

export function setCfgValue(cfg, key, value) {
  const parts = String(key).split('.')
  const root = { ...(cfg || {}) }
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...(cur[parts[i]] || {}) }
    cur = cur[parts[i]]
  }
  const last = parts[parts.length - 1]
  if (value === '' || value === undefined || value === null) delete cur[last]
  else cur[last] = value
  return root
}

// 列表「接入信息」：按源类型渲染关键连接信息
export function receiverAccessInfo(r) {
  const cfg = parseAdapterConfig(r.adapter_config)
  switch (r.protocol) {
    case 'syslog': return `${r.syslog_bind || '0.0.0.0'}:${r.syslog_port} (${r.syslog_proto || 'udp'})`
    case 'kafka': return `${r.kafka_topic} ← ${r.kafka_bootstrap}`
    case 'snmp_trap': return `${cfg.bind || '0.0.0.0'}:${cfg.port || 1162}`
    case 'netflow': return `${cfg.bind || '0.0.0.0'}:${cfg.port || 2055}`
    case 'file_tail': return cfg.path || '—'
    case 'rest_api': return `${cfg.base_url || '—'}${cfg.path || ''}`
    case 'jdbc': return (cfg.url || '—').replace(/\/\/([^/@]+)@/, '//***@')
    case 'pcap': return `${cfg.iface || '默认网卡'} · ${cfg.bpf_filter || 'ip'}`
    default: return '—'
  }
}

// 接收器监听端点（bind:port）：同地址+协议重复校验用（与后端 _rec_endpoint 一致）
export function receiverEndpoint(r) {
  const cfg = parseAdapterConfig(r?.adapter_config)
  const norm = (b) => ((b || '').trim() || '0.0.0.0')
  let port = null
  let bind = ''
  if (r?.protocol === 'syslog') { port = r.syslog_port; bind = r.syslog_bind }
  else if (r?.protocol === 'snmp_trap') { port = cfg.port; bind = cfg.bind }
  else if (r?.protocol === 'netflow') { port = cfg.port; bind = cfg.bind }
  if (!port) return null
  return `${norm(bind)}:${Number(port)}`
}

// 接收器行 → 完整 PUT 请求体（以现有接收器值为底组装全量 PUT，设置与处理配置互不覆盖）
export function receiverToBody(r) {
  return {
    device_id: r?.device_id ?? null,
    name: r?.name || '',
    protocol: r?.protocol || 'syslog',
    enabled: r?.enabled !== false,
    syslog_port: r?.syslog_port ?? null,
    syslog_proto: r?.syslog_proto || 'udp',
    syslog_bind: r?.syslog_bind || '0.0.0.0',
    kafka_bootstrap: r?.kafka_bootstrap || '',
    kafka_topic: r?.kafka_topic || '',
    kafka_group: r?.kafka_group || 'soar-ingest',
    kafka_security: r?.kafka_security || '',
    adapter_config: parseAdapterConfig(r?.adapter_config),
    format: r?.format || 'json',
    strategy_id: r?.strategy_id || null,
    notify_interval_minutes: r?.notify_interval_minutes ?? 0,
    description: r?.description || '',
  }
}
