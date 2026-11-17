// API 对接指南：接入流程、鉴权、开放资源目录、调用示例、错误码与检查清单
// 布局与「工具」页保持一致：卡片容器 + 语义令牌 + DataTable / PillTabs
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpen, Check, Copy, Gauge, KeyRound, ListChecks, Lock, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { DataTable, PillTabs } from '../../components/ui'
import { openAdminApi } from '../../api/openApi'
import { toast } from '../../store/toastStore'

// 默认资源目录：接口不可用时兜底展示（与开放网关实际资源保持一致）
const RESOURCE_FALLBACK = [
  { code: 'alerts', name: '告警事件', description: '标准化告警列表：告警名称、等级、威胁类型、源/目的 IP、处置状态、发生时间等' },
  { code: 'assets', name: '资产清单', description: '资产名称 / 标识 / 类型 / IP / 部门 / 负责人 / 重要性 / 生命周期状态' },
  { code: 'banned_ips', name: '封禁记录', description: 'IP 封禁记录：封禁等级、时长、到期时间、归属地、违规次数与状态' },
  { code: 'tickets', name: '安全工单', description: '工单编号 / 标题 / 状态 / 优先级 / 当前节点（默认排除已归档）' },
  { code: 'executions', name: '执行记录', description: '工作流执行历史：所属工作流、执行状态、触发类型、开始与完成时间' },
  { code: 'dashboard_stats', name: '安全统计汇总', description: '告警 / 封禁 / 工单 / 执行的聚合指标（聚合结构，无分页）' },
  { code: 'ticket_monitor', name: '工单监控大屏', description: '大屏聚合数据：KPI、趋势、分布、团队排名与下钻集（聚合结构）' },
]

// 聚合类资源：响应为 dict，无 items 分页包装
const AGGREGATE_RESOURCES = new Set(['dashboard_stats', 'ticket_monitor'])

const ERROR_ROWS = [
  { code: '200', message: '调用成功', advice: '—' },
  { code: '401', message: 'API Key 格式错误 / 密钥无效', advice: '检查 X-API-Key 请求头，确认 Access Key 与 Secret 用英文冒号拼接' },
  { code: '403', message: '应用停用 / 密钥过期 / IP 不在白名单 / 未授权资源', advice: '联系管理员确认应用状态、白名单与资源授权' },
  { code: '404', message: '资源不存在', advice: '资源编码拼写错误，先调 GET /open 确认可用资源' },
  { code: '429', message: '超出限流配额 / 密钥连续失败被临时锁定', advice: '指数退避重试（建议 ≥ 60s），或联系管理员调高配额' },
  { code: '500', message: '服务内部错误', advice: '携带调用时间与请求参数联系平台管理员' },
]

const STEPS = [
  { icon: KeyRound, title: '创建接入应用', desc: '在「应用管理」新建应用，填写用途并授权可调取的数据资源。' },
  { icon: Lock, title: '保存 API 密钥', desc: '创建后一次性展示 Access Key + Secret，请加密保存，页面关闭后不可再查看。' },
  { icon: ShieldCheck, title: '配置访问策略', desc: '按需设置 IP 白名单、每分钟调用配额与密钥有效期。' },
  { icon: Gauge, title: '联调与监控', desc: '先调 GET /open 获取资源目录，再按资源接口拉取数据，调用情况见「调用监控 / 调用日志」。' },
]

const LANG_TABS = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'javascript', label: 'JavaScript' },
]

const CODE_SAMPLES = {
  curl: `curl -H "X-API-Key: <access_key>:<secret>" \\
  "<base_url>/open/alerts?page=1&page_size=20"`,
  python: `import requests

BASE_URL = "<base_url>"
API_KEY = "<access_key>:<secret>"

resp = requests.get(
    BASE_URL + "/open/alerts",
    headers={"X-API-Key": API_KEY},
    params={"page": 1, "page_size": 100},
    timeout=10,
)
resp.raise_for_status()
payload = resp.json()

print("总数:", payload["data"]["total"])
for item in payload["data"]["items"]:
    print(item["alert_name"], item["risk_level_name"])`,
  javascript: `const BASE_URL = '<base_url>'
const API_KEY = '<access_key>:<secret>'
const url = BASE_URL + '/open/alerts?page=1&page_size=20'

const res = await fetch(url, {
  headers: { 'X-API-Key': API_KEY },
})
if (!res.ok) throw new Error('调用失败: ' + res.status)
const payload = await res.json()

console.log('总数:', payload.data.total)
console.table(payload.data.items)`,
}

const CHECKLIST = [
  '已获得 Access Key + Secret，并确认已授权所需资源',
  '（如启用）出口 IP 已加入应用白名单',
  'GET /open 能正常返回当前应用的资源目录',
  '各资源接口试调通过（HTTP 200）',
  '已实现 401 / 403 / 429 错误处理与指数退避',
  '已确认每分钟配额满足业务峰值调用量',
  'Secret 已加密保存，未写入前端代码或日志',
]

const BEST_PRACTICES = [
  { title: '分页拉取', desc: '全量同步按 page 递增循环拉取，直到 items 为空或累计达到 total；page_size 建议固定 100。' },
  { title: '增量同步', desc: '使用 start_time / end_time 按时间窗口拉取增量，避免每次全量扫描。' },
  { title: '限流退避', desc: '收到 429 后按指数退避重试，峰值 QPS 不高于「每分钟配额 ÷ 60」。' },
  { title: '密钥安全', desc: 'Secret 仅展示一次，泄露后立即在「应用管理」重置，旧密钥即时失效。' },
]

// 卡片区块：与列表页卡片边框/内边距一致
function Section({ title, description, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export default function GuideTab({ refreshKey = 0 }) {
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(true)
  const [hint, setHint] = useState('')
  const [lang, setLang] = useState('curl')
  const [copied, setCopied] = useState('')
  const [checks, setChecks] = useState(() => CHECKLIST.map(() => false))

  const baseUrl = useMemo(
    () => (typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : 'http://<平台地址>/api/v1'),
    []
  )

  const loadResources = useCallback(async () => {
    setLoading(true)
    try {
      const res = await openAdminApi.listResources()
      const items = res?.data?.items || []
      setResources(items.length > 0 ? items : RESOURCE_FALLBACK)
      setHint(items.length > 0 ? '' : '暂未获取到资源目录，下方展示默认开放资源')
    } catch {
      setResources(RESOURCE_FALLBACK)
      setHint('资源目录加载失败，下方展示默认开放资源')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadResources() }, [loadResources, refreshKey])

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      toast.success('已复制到剪贴板')
      setTimeout(() => setCopied(''), 1600)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  const resourceColumns = [
    {
      key: 'code', header: '资源编码', width: '170px',
      render: (r) => <span className="font-mono text-xs text-primary">{r.code}</span>,
    },
    { key: 'name', header: '资源名称', width: '140px' },
    {
      key: 'description', header: '说明', width: '380px',
      render: (r) => (
        <span className="inline-block max-w-[360px] truncate align-bottom text-xs text-muted-foreground" title={r.description || ''}>
          {r.description || '-'}
        </span>
      ),
    },
    {
      key: 'mode', header: '响应结构', width: '110px',
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {AGGREGATE_RESOURCES.has(r.code) ? '聚合' : '分页 items'}
        </span>
      ),
    },
    {
      key: '__path', header: '调用路径', width: '230px',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <code className="truncate font-mono text-xs text-foreground">GET /open/{r.code}</code>
          <button
            type="button"
            title="复制路径"
            onClick={() => copyText(`GET ${baseUrl}/open/${r.code}`, `path-${r.code}`)}
            className="shrink-0 text-muted-foreground transition hover:text-primary"
          >
            {copied === `path-${r.code}` ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      ),
    },
  ]

  const errorColumns = [
    { key: 'code', header: '状态码', width: '90px', render: (r) => <span className="font-mono text-xs text-foreground">{r.code}</span> },
    { key: 'message', header: '含义', width: '260px', render: (r) => <span className="text-xs text-foreground">{r.message}</span> },
    { key: 'advice', header: '排查建议', render: (r) => <span className="text-xs text-muted-foreground">{r.advice}</span> },
  ]

  const authLine = 'X-API-Key: <access_key>:<secret>'
  const doneCount = checks.filter(Boolean).length

  return (
    <div className="flex flex-col gap-4">
      {/* 接入流程 */}
      <Section title="接入流程" description="四步完成第三方系统对接，全程只读调用，无写操作面">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, desc }, idx) => (
            <div key={title} className="flex items-start gap-3 rounded-md border border-border bg-background p-3.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold tabular-nums text-primary">0{idx + 1}</span>
                  <span className="text-sm font-medium text-foreground">{title}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 开放资源目录 */}
      <Section
        title="开放资源目录"
        description={hint || '实际可调用范围以管理员为当前应用授权的资源子集为准'}
        actions={
          <button type="button" className="btn-secondary btn-sm" onClick={loadResources} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        }
      >
        <div className="overflow-hidden rounded-lg border border-border">
          <DataTable
            columns={resourceColumns}
            data={resources}
            loading={loading}
            rowKey="code"
            emptyText="暂无开放资源"
            emptyIcon={BookOpen}
            emptyDescription="请联系管理员在应用管理中授权资源"
          />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 鉴权 */}
        <Section title="鉴权方式" description="请求头携带 API Key，Access Key 与 Secret 用英文冒号拼接">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
              <code className="truncate font-mono text-xs text-foreground">{authLine}</code>
              <button
                type="button"
                onClick={() => copyText(authLine, 'auth')}
                className="shrink-0 text-muted-foreground transition hover:text-primary"
                title="复制鉴权头"
              >
                {copied === 'auth' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>· 服务地址：<code className="font-mono text-foreground">{baseUrl}</code></li>
              <li>· 请求方法：全部为 <code className="font-mono text-foreground">GET</code>，响应为 JSON</li>
              <li>· Secret 仅在创建或重置时展示一次，请加密保存</li>
              <li>· 连续 10 次密钥校验失败将临时锁定该 Key 10 分钟</li>
            </ul>
          </div>
        </Section>

        {/* 错误码 */}
        <Section title="错误码约定" description="失败响应体为 FastAPI 标准格式：{ detail: &quot;...&quot; }">
          <div className="overflow-hidden rounded-lg border border-border">
            <DataTable columns={errorColumns} data={ERROR_ROWS} rowKey="code" />
          </div>
        </Section>
      </div>

      {/* 调用示例 */}
      <Section
        title="调用示例"
        description="以告警事件（alerts）为例；替换 <base_url>、Access Key 与 Secret 后即可运行"
        actions={
          <PillTabs items={LANG_TABS} value={lang} onChange={setLang} />
        }
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => copyText(CODE_SAMPLES[lang].replace('<base_url>', baseUrl), `code-${lang}`)}
            className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            {copied === `code-${lang}` ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
            {copied === `code-${lang}` ? '已复制' : '复制'}
          </button>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background p-4 pr-20 font-mono text-xs leading-relaxed text-foreground">
            {CODE_SAMPLES[lang].replace('<base_url>', baseUrl)}
          </pre>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 检查清单 */}
        <Section
          title="对接检查清单"
          description={`已完成 ${doneCount} / ${CHECKLIST.length} 项`}
        >
          <div className="flex flex-col gap-1">
            {CHECKLIST.map((item, idx) => (
              <label
                key={item}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 transition hover:bg-accent"
              >
                <input
                  type="checkbox"
                  checked={checks[idx]}
                  onChange={(e) => setChecks((prev) => prev.map((v, i) => (i === idx ? e.target.checked : v)))}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span className={`text-xs leading-relaxed ${checks[idx] ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  {item}
                </span>
              </label>
            ))}
          </div>
        </Section>

        {/* 最佳实践 */}
        <Section title="调用规范与最佳实践" description="保障同步稳定性与密钥安全">
          <div className="flex flex-col gap-2.5">
            {BEST_PRACTICES.map(({ title, desc }) => (
              <div key={title} className="flex items-start gap-2.5 rounded-md border border-border bg-background p-3">
                <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">{title}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

