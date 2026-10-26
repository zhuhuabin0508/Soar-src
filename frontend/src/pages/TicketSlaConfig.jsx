// 工单 SLA 目标配置页：按优先级（紧急/高危/中危/低危）设定响应时限与解决时限
// - 响应时限 = 工单发起 → 首次节点提交；解决时限 = 工单创建 → 完成关闭
// - 留空 = 该优先级对应维度不设目标（不参与大屏 SLA 统计）
// - 配置实时作用于监控大屏 SLA 时效分析与超时预警口径
import { useCallback, useEffect, useState } from 'react'
import { TimerReset, RotateCcw, RefreshCw } from 'lucide-react'
import { toast } from '../store/toastStore'
import { inputCls, labelCls } from '../components/property/FormControls'
import { Button, PageContainer, DataTable, EmptyState } from '../components/ui'
import { hasPermission } from '../utils/permissions'
import ticketApi from '../api/tickets'

const PRIORITIES = [
  ['critical', '紧急'],
  ['high', '高危'],
  ['medium', '中危'],
  ['low', '低危'],
]

// 优先级圆点色（紧急红 / 高危橙 / 中危蓝 / 低危灰）
const PRIORITY_DOTS = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-slate-400',
}

// 分钟数 → 可读时长（60 分钟以上显示小时）
const fmtMinutes = (m) => {
  if (m === null || m === undefined) return '不限'
  if (m < 60) return `${m.toLocaleString()} 分钟`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h.toLocaleString()} 小时 ${r.toLocaleString()} 分` : `${h.toLocaleString()} 小时`
}

export default function TicketSlaConfig() {
  const canEdit = hasPermission('ticket_config', 'edit')
  const [config, setConfig] = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    ticketApi.getSlaConfig()
      .then((res) => {
        setConfig(res.config || {})
        setDefaults(res.defaults || {})
      })
      .catch((e) => toast.error(e.message || '加载 SLA 配置失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const setDim = (p, dim, v) => {
    // 输入留空即不限（null）；仅接受正整数
    const val = v === '' ? null : (Number(v) >= 1 ? Math.floor(Number(v)) : '')
    setConfig((c) => ({ ...c, [p]: { ...(c[p] || {}), [dim]: val } }))
  }

  const handleSave = () => {
    // 本地预校验：空字符串视为非法输入（应清空为不限）
    for (const [p] of PRIORITIES) {
      for (const dim of ['response', 'resolve']) {
        const v = config?.[p]?.[dim]
        if (v === '' || v === undefined) {
          return toast.error('时限需为正整数，或清空表示不限')
        }
      }
    }
    setSaving(true)
    ticketApi.updateSlaConfig(config)
      .then((res) => {
        setConfig(res.config)
        toast.success('SLA 目标配置已保存')
      })
      .catch((e) => toast.error(e.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  const slaColumns = [
    {
      key: 'priority', header: '优先级', width: '170px',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOTS[r.key] || 'bg-slate-400'}`} />
          <span className="font-medium text-foreground">{r.label}</span>
        </div>
      ),
    },
    {
      key: 'response', header: '响应时限（分钟）',
      render: (r) => (
        <div className="min-w-0 py-1">
          <label className={`${labelCls} mb-1.5`}>工单发起 → 首次提交</label>
          <input
            type="number" min="1" disabled={!canEdit}
            className={`${inputCls} tabular-nums`} placeholder="留空 = 不限"
            value={config?.[r.key]?.response ?? ''}
            onChange={(e) => setDim(r.key, 'response', e.target.value)}
          />
        </div>
      ),
    },
    {
      key: 'resolve', header: '解决时限（分钟）',
      render: (r) => (
        <div className="min-w-0 py-1">
          <label className={`${labelCls} mb-1.5`}>工单创建 → 完成关闭</label>
          <input
            type="number" min="1" disabled={!canEdit}
            className={`${inputCls} tabular-nums`} placeholder="留空 = 不限"
            value={config?.[r.key]?.resolve ?? ''}
            onChange={(e) => setDim(r.key, 'resolve', e.target.value)}
          />
        </div>
      ),
    },
    {
      key: 'defaults', header: '默认值参考', width: '220px', numeric: true,
      render: (r) => {
        const d = defaults?.[r.key] || {}
        return (
          <span
            className="text-muted-foreground"
            title={`响应 ${fmtMinutes(d.response ?? null)} / 解决 ${fmtMinutes(d.resolve ?? null)}`}
          >
            响应 {fmtMinutes(d.response ?? null)} / 解决 {fmtMinutes(d.resolve ?? null)}
          </span>
        )
      },
    },
  ]

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">SLA 目标配置</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            按工单优先级设定响应与解决时限，超出即计为 SLA 超时并作用于监控大屏时效分析；留空表示不设目标。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary btn-sm" title="刷新 SLA 配置">
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
          {canEdit && config && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfig(structuredClone(defaults))}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />恢复默认
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
                保存配置
              </Button>
            </>
          )}
        </div>
      </div>

      {!config && !loading ? (
        <EmptyState
          icon={TimerReset}
          title="暂无 SLA 配置数据"
          description="请刷新页面重试，或联系管理员检查服务端配置"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <DataTable
            className="table-stagger"
            columns={slaColumns}
            data={PRIORITIES.map(([key, label]) => ({ key, label }))}
            loading={loading}
            rowKey="key"
          />
        </div>
      )}

      {!loading && config && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-card px-6 py-4 text-[13px] text-muted-foreground">
          <TimerReset className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            口径说明：响应 = 工单发起 → 首次节点提交；解决 = 工单创建 → 完成关闭。
            进行中工单按当前时间实时判断是否超出目标；已取消工单仅统计响应超时（取消不计解决）；
            流程模板中节点级的「超时提醒」仍用于通知中心提醒处理分组，与大屏 SLA 统计口径相互独立。
          </p>
        </div>
      )}
    </PageContainer>
  )
}
