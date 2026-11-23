// 青藤实时查询弹窗：按设备 + 模块 + 条件调用青藤接口，结果不落库
import { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { govCloudApi } from '../../api/govcloud'
import { Button, EmptyState } from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { inputCls } from '../../components/property/FormControls'

export default function RealtimeQueryModal({
  open,
  deviceId,
  deviceName,
  groupCode,
  initialModule,
  onClose,
}) {
  const [modules, setModules] = useState([])
  const [module, setModule] = useState('')
  const [form, setForm] = useState({
    keyword: '', agentId: '', ip: '', hostname: '', port: '', osType: '',
  })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setResult(null)
    setError('')
    setLoading(false)
    govCloudApi.realtimeModules(groupCode)
      .then((res) => {
        const list = res?.modules || []
        setModules(list)
        const preferred = list.find((m) => m.value === initialModule) || list[0]
        setModule(preferred?.value || '')
      })
      .catch((e) => setError(e.message || '加载实时查询模块失败'))
  }, [open, groupCode, initialModule])

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!module) return
    const hasFilter = ['keyword', 'agentId', 'ip', 'hostname', 'port']
      .some((k) => String(form[k] || '').trim())
    if (!hasFilter) {
      setError('至少填写一个查询条件：关键词 / Agent ID / IP / 主机名 / 端口')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await govCloudApi.realtimeQuery({
        deviceId,
        module,
        keyword: form.keyword.trim(),
        agentId: form.agentId.trim(),
        ip: form.ip.trim(),
        hostname: form.hostname.trim(),
        port: form.port.trim(),
        osType: form.osType,
        limit: 50,
      })
      setResult(res)
    } catch (err) {
      setError(err.message || '实时查询失败')
    } finally {
      setLoading(false)
    }
  }

  const columns = result?.columns || []
  const rows = result?.rows || []

  return (
    <Modal open={open} size="xl" title={`实时查询 · ${deviceName || ''}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          实时调用青藤接口，结果不落库；需要入库请在卡片上使用「同步」。
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">模块</div>
              <select className={inputCls} value={module} onChange={(e) => setModule(e.target.value)}>
                {modules.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">关键词</div>
              <input className={inputCls} value={form.keyword} onChange={setField('keyword')} placeholder="名称 / 版本 / 路径" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Agent ID</div>
              <input className={inputCls} value={form.agentId} onChange={setField('agentId')} placeholder="精确匹配" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">主机 IP</div>
              <input className={inputCls} value={form.ip} onChange={setField('ip')} placeholder="青藤为模糊匹配" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">主机名</div>
              <input className={inputCls} value={form.hostname} onChange={setField('hostname')} placeholder="可选" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">端口</div>
              <input className={inputCls} type="number" min="1" max="65535" value={form.port} onChange={setField('port')} placeholder="站点/端口/数据库" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">系统类型</div>
              <select className={inputCls} value={form.osType} onChange={setField('osType')}>
                <option value="">全部</option>
                <option value="linux">Linux</option>
                <option value="win">Windows</option>
              </select>
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={loading || !module}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                {loading ? '查询中' : '查询'}
              </Button>
              <span className="pb-1 text-xs text-muted-foreground">最多 50 条</span>
            </div>
          </div>
        </form>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>模块：{result.module_label}</span>
              <span>命中 <span className="font-medium text-foreground">{result.matched}</span> 条</span>
              <span>扫描 {result.scanned} 条</span>
              <span>接口总数 {result.total} 条</span>
              <span>查询时间：{result.queried_at}</span>
            </div>
            {(result.warnings || []).map((w, i) => (
              <div key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                {w}
              </div>
            ))}
            {rows.length === 0 ? (
              <EmptyState
                icon={Search}
                title="没有匹配结果"
                description="调整关键词、IP 或端口后重试；也可以改用资产同步全量拉取"
                bordered
              />
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-secondary text-muted-foreground">
                    <tr>
                      {columns.map((c) => (
                        <th key={c.key} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => (
                      <tr key={idx} className="border-t border-border/60 hover:bg-secondary/40">
                        {columns.map((c) => (
                          <td key={c.key} className="max-w-[320px] truncate whitespace-nowrap px-3 py-1.5" title={String(row[c.key] ?? '')}>
                            {row[c.key] === '' || row[c.key] == null ? '—' : String(row[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
