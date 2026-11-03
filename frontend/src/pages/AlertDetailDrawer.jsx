// 告警详情抽屉：60% 宽，Tab 分组展示标准模型全部字段
// - 基础信息：名称/描述/处置建议/等级/置信度/阶段/ATT&CK/标签/威胁定性/策略名/设备类型
// - 源目的信息：IP/端口/区域/国家省市（含多值数组）
// - 资产与主体：主机 IP/资产 ID/分组/主体/账号（容器字段仅 relate_asset_type=1 显示）
// - 举证信息：proof_description / base_content 代码块（可复制）
// - 扩展字段：extensions JSON 格式化（按策略不同内容不同）
// - 原始数据：raw_data 格式化高亮（可复制/下载）
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { X, Copy, Download, FileJson, Info, ArrowLeftRight, Server, FileText, Braces, FileCode, ShieldCheck } from 'lucide-react'
import { toast } from '../store/toastStore'
import { alertApi } from '../api/alert'
import { inputBaseCls } from '../components/property/FormControls'
import {CompactSelect, AutoGrowTextarea } from '../components/ui'
import { hasPermission, guardNavPermission } from '../utils/permissions'
import usersApi from '../api/users'
import useLockBackgroundScroll from '../hooks/useLockBackgroundScroll'

// Tab 定义
const TABS = [
  { key: 'basic', label: '基础信息', icon: Info },
  { key: 'endpoint', label: '源目的信息', icon: ArrowLeftRight },
  { key: 'asset', label: '资产与主体', icon: Server },
  { key: 'proof', label: '举证信息', icon: FileText },
  { key: 'ext', label: '扩展字段', icon: Braces },
  { key: 'raw', label: '原始数据', icon: FileCode },
  { key: 'handle', label: '处置记录', icon: ShieldCheck },
]

// 状态机流转规则
const TRANSITIONS = {
  0: [0, 10, 70, 20, 30, 40, 50, 60, 80],
  10: [10, 70, 0, 20, 30, 40, 50, 60, 80],
  70: [70, 0, 10, 20, 30, 40, 50, 60, 80],
  20: [20, 70],
  30: [30, 70, 0], 40: [40, 70, 0], 50: [50, 70, 0], 60: [60, 70, 0], 80: [80, 70, 0],
}
const DEAL_STATUS_OPTS = [
  { v: 0, label: '未处置' }, { v: 10, label: '生成事件' }, { v: 20, label: '已关闭' },
  { v: 30, label: '已加白' }, { v: 40, label: '已驳回' }, { v: 50, label: '已忽略' },
  { v: 60, label: '已遏制' }, { v: 70, label: '处置中' }, { v: 80, label: '误报' },
]
const STATUS_LABELS = Object.fromEntries(DEAL_STATUS_OPTS.map((o) => [o.v, o.label]))
const ACTION_LABELS = {
  status_change: '状态变更', assign: '指派', comment: '备注',
  reopen: '重新打开', close: '关闭',
}

const fmtTime = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '--')

// 数组 IP（["1.2.3.4","5.6.7.8"]）→ 逗号串；非数组原样返回
function fmtIpList(v) {
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v).join(', ') } catch { return v }
  }
  return v || '--'
}

// 键值行
function KV({ label, value, mono, full }) {
  const display = value === undefined || value === null || value === '' ? '--' : value
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 truncate text-sm text-foreground ${mono ? 'font-mono text-[13px]' : ''}`} title={String(display)}>{display}</div>
    </div>
  )
}

// JSON 代码块（复制按钮）
function CodeBlock({ text, max = 520 }) {
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => toast.success('已复制到剪贴板')).catch(() => toast.error('复制失败'))
  }
  return (
    <div className="group relative rounded-lg border border-border bg-muted">
      <button
        className="absolute right-2 top-2 z-base flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100"
        onClick={copy}
      >
        <Copy className="h-3 w-3" /> 复制
      </button>
      <pre className="max-h-[520px] overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground">{text}</pre>
    </div>
  )
}

export default function AlertDetailDrawer({ open, alertId, onClose, onHandled }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('basic')
  const [handleLogs, setHandleLogs] = useState([])
  const [users, setUsers] = useState([])
  const [handleForm, setHandleForm] = useState({ to_status: 70, assignee_id: '', comment: '' })
  const [submitting, setSubmitting] = useState(false)
  const canHandle = hasPermission('alert', 'handle')

  useEffect(() => {
    if (!open || !alertId) return
    setLoading(true)
    setDetail(null)
    setTab('basic')
    alertApi.detail(alertId)
      .then(setDetail)
      .catch((e) => toast.error(e.message || '详情加载失败'))
      .finally(() => setLoading(false))
    if (canHandle) {
      alertApi.handleLogs(alertId).then(setHandleLogs).catch(() => {})
      usersApi.list().then((items) => setUsers((items || []).filter((u) => u.is_active !== false))).catch(() => {})
    }
  }, [open, alertId])

  // 当切换到处置 Tab 时刷新日志
  useEffect(() => {
    if (tab === 'handle' && alertId && canHandle) {
      alertApi.handleLogs(alertId).then(setHandleLogs).catch(() => {})
    }
  }, [tab, alertId])

  // 根据当前状态计算可选目标状态
  const currentStatus = detail?.deal_status ?? 0
  const allowedTargets = TRANSITIONS[currentStatus] || []

  const submitHandle = () => {
    setSubmitting(true)
    alertApi.handle(alertId, {
      to_status: handleForm.to_status,
      assignee_id: handleForm.assignee_id ? Number(handleForm.assignee_id) : null,
      comment: handleForm.comment,
    }).then(() => {
      toast.success('处置操作成功')
      setHandleForm({ to_status: 70, assignee_id: '', comment: '' })
      // 刷新详情+日志
      alertApi.detail(alertId).then(setDetail).catch(() => {})
      alertApi.handleLogs(alertId).then(setHandleLogs).catch(() => {})
      onHandled?.()
    }).catch((e) => toast.error(e.message || '处置失败'))
    .finally(() => setSubmitting(false))
  }

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useLockBackgroundScroll(open)

  if (!open) return null

  const isContainer = detail?.relate_asset_type === 1
  const rawJson = detail?.raw_data ? JSON.stringify(detail.raw_data, null, 2) : ''
  const extJson = detail?.extensions ? JSON.stringify(detail.extensions, null, 2) : ''

  const downloadRaw = () => {
    if (!rawJson) return
    const blob = new Blob([rawJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `alert_${detail?.uuid || alertId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex h-full w-3/5 min-w-[720px] flex-col border-l border-border bg-card shadow-2xl animate-[adSlideIn_0.2s_ease-out]">
        <style>{`@keyframes adSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

        {/* 标题栏 */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground" title={detail?.alert_name}>
              {detail?.alert_name || (loading ? '加载中…' : '--')}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{detail?.uuid || '--'}</span>
              {detail?.device_type && <span>· {detail.device_type}</span>}
              {detail?.occur_timestamp && <span>· {fmtTime(detail.occur_timestamp)}</span>}
            </div>
          </div>
          <button className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 栏 */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition ${
                tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setTab(key)}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div data-allow-scroll className="flex-1 overflow-y-auto overscroll-contain p-6">
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
          ) : !detail ? (
            <div className="py-16 text-center text-sm text-muted-foreground">未找到告警数据</div>
          ) : (
            <>
              {tab === 'basic' && (
                <div className="grid grid-cols-2 gap-x-8 gap-y-5">
                  <KV label="告警名称" value={detail.alert_name} full />
                  <KV label="风险等级" value={detail.risk_level_name || '未知'} />
                  <KV label="严重度" value={detail.severity >= 0 ? `${detail.severity} / 100` : '--'} mono />
                  <KV label="置信度" value={detail.confidence >= 0 ? `${detail.confidence}%` : '--'} mono />
                  <KV label="攻击阶段" value={detail.stage_name} />
                  <KV label="威胁定性" value={[detail.threat_class, detail.threat_type, detail.threat_sub_type].filter(Boolean).join(' / ') || '--'} />
                  <KV label="处置状态" value={detail.deal_status_name} />
                  <KV label="解析状态" value={detail.parse_status} />
                  {/* 设备类型未识别时显示灰字 + 去配置链接（引导完成设备接入绑定） */}
                  <div>
                    <div className="text-[11px] text-muted-foreground">设备类型</div>
                    {detail.device_type ? (
                      <div className="mt-0.5 truncate text-sm text-foreground" title={detail.device_type}>{detail.device_type}</div>
                    ) : (
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-sm text-muted-foreground">未识别</span>
                        <button
                          type="button"
                          className="text-xs text-primary transition hover:underline"
                          title="打开设备接入指引，完成设备接入与解析模板配置"
                          onClick={() => navigate('/device-onboard')}
                        >
                          去配置
                        </button>
                      </div>
                    )}
                  </div>
                  <KV label="租户 / 客户" value={[detail.tenant, detail.customer].filter(Boolean).join(' / ') || '--'} />
                  <KV label="首次发生" value={fmtTime(detail.first_timestamp)} mono />
                  <KV label="最近发生" value={fmtTime(detail.last_timestamp)} mono />
                  <KV label="上报时间" value={fmtTime(detail.upload_time)} mono />
                  <KV label="告警描述" value={detail.description} full />
                  <KV label="处置建议" value={detail.recommendation} full />
                  {/* ATT&CK 技术 */}
                  <div className="col-span-2">
                    <div className="text-[11px] text-muted-foreground">ATT&CK 技术</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {(Array.isArray(detail.attck_technique) ? detail.attck_technique : []).length === 0 ? (
                        <span className="text-sm text-muted-foreground">--</span>
                      ) : (
                        (Array.isArray(detail.attck_technique) ? detail.attck_technique : []).map((t, i) => (
                          <span key={i} className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">{typeof t === 'string' ? t : JSON.stringify(t)}</span>
                        ))
                      )}
                    </div>
                  </div>
                  {/* 风险标签 */}
                  <div className="col-span-2">
                    <div className="text-[11px] text-muted-foreground">风险标签</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {(Array.isArray(detail.risk_tag) ? detail.risk_tag : []).length === 0 ? (
                        <span className="text-sm text-muted-foreground">--</span>
                      ) : (
                        (Array.isArray(detail.risk_tag) ? detail.risk_tag : []).map((t, i) => (
                          <span key={i} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary">{t}</span>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'endpoint' && (
                <div className="grid grid-cols-2 gap-x-8 gap-y-5">
                  <KV label="源 IP" value={fmtIpList(detail.src_ip)} mono full />
                  <KV label="源端口" value={detail.src_port} mono />
                  <KV label="源 IP 标签" value={detail.src_ip_tag_name} />
                  <KV label="源区域" value={[detail.src_region_name, detail.src_region_id].filter(Boolean).join(' / ') || '--'} />
                  <KV label="源国家" value={detail.src_country} />
                  <KV label="源省份 / 城市" value={[detail.src_province, detail.src_city].filter(Boolean).join(' / ') || '--'} />
                  <KV label="目的 IP" value={fmtIpList(detail.dst_ip)} mono full />
                  <KV label="目的端口" value={detail.dst_port} mono />
                  <KV label="目的区域" value={[detail.dst_region_name, detail.dst_region_id].filter(Boolean).join(' / ') || '--'} />
                  <KV label="方向" value={detail.direction_name} />
                  <KV label="协议" value={detail.protocol} mono />
                  <KV label="XFF 客户端 IP" value={detail.xff_client_ip} mono />
                  <KV label="攻击状态" value={detail.attack_state_name} />
                </div>
              )}

              {tab === 'asset' && (
                <div className="grid grid-cols-2 gap-x-8 gap-y-5">
                  <KV label="资产类型" value={detail.relate_asset_type_name || (isContainer ? '容器' : '主机')} />
                  {detail.relate_asset_id ? (
                    <div>
                      <div className="text-[11px] text-muted-foreground">关联资产（资产库匹配）</div>
                      <button
                        className="mt-0.5 flex max-w-full items-baseline gap-1 text-left text-sm text-primary underline-offset-2 hover:underline"
                        title={`点击查看资产：${detail.relate_asset_ip || detail.relate_asset_name}`}
                        onClick={() => { if (!guardNavPermission('asset_list', 'view', '资产清单')) return; navigate(`/assets/list?keyword=${encodeURIComponent(detail.relate_asset_ip || detail.relate_asset_name || '')}`) }}
                      >
                        <span className="truncate">{detail.relate_asset_name || `资产 #${detail.relate_asset_id}`}</span>
                        {detail.relate_asset_ip && (
                          <span className="shrink-0 font-mono text-[12px] text-muted-foreground">（{detail.relate_asset_ip}）</span>
                        )}
                      </button>
                    </div>
                  ) : (
                    <KV label="关联资产（资产库匹配）" value="--" />
                  )}
                  <KV label="主机 IP" value={fmtIpList(detail.host_ip)} mono />
                  <KV label="资产 ID" value={detail.asset_id} mono />
                  <KV label="区域 ID" value={detail.region_id} mono />
                  <KV label="分组 ID" value={detail.group_id} mono />
                  <KV label="主体类型" value={detail.subject_type} />
                  <KV label="用户名" value={detail.user_name} />
                  <KV label="账号" value={[detail.account_name, detail.account_id].filter(Boolean).join(' / ') || '--'} />
                  <KV label="Agent ID" value={detail.agent_id} mono />
                  {/* 容器字段仅 relate_asset_type=1（容器）时显示 */}
                  {isContainer && (
                    <div className="col-span-2 rounded-lg border border-border bg-muted p-4">
                      <div className="mb-3 text-xs font-medium text-muted-foreground">容器信息</div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
                        <KV label="容器名称" value={detail.extensions?.container_name || detail.extensions?.containerName || '--'} />
                        <KV label="镜像" value={detail.extensions?.image_name || detail.extensions?.imageName || '--'} />
                        <KV label="Pod" value={detail.extensions?.pod_name || detail.extensions?.podName || '--'} />
                        <KV label="命名空间" value={detail.extensions?.namespace || '--'} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === 'proof' && (
                <div className="space-y-5">
                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">举证类型</div>
                    <div className="text-sm text-foreground">{detail.proof_type || '--'}</div>
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">举证描述</div>
                    {detail.proof_description
                      ? <CodeBlock text={detail.proof_description} />
                      : <div className="text-sm text-muted-foreground">--</div>}
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">基础内容</div>
                    {detail.base_content
                      ? <CodeBlock text={detail.base_content} />
                      : <div className="text-sm text-muted-foreground">--</div>}
                  </div>
                </div>
              )}

              {tab === 'ext' && (
                extJson && extJson !== '{}'
                  ? <CodeBlock text={extJson} max={640} />
                  : <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                      <FileJson className="h-10 w-10 opacity-40" />
                      <span className="text-sm">该告警无扩展字段</span>
                    </div>
              )}

              {tab === 'raw' && (
                rawJson ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">设备推送的原始日志全文（已格式化）</span>
                      <button className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:text-primary" onClick={downloadRaw}>
                        <Download className="h-3 w-3" /> 下载 JSON
                      </button>
                    </div>
                    <CodeBlock text={rawJson} max={640} />
                  </div>
                ) : (
                  <div className="py-16 text-center text-sm text-muted-foreground">原始数据为空</div>
                )
              )}

              {tab === 'handle' && (
                <div className="space-y-6">
                  {/* 当前状态摘要 */}
                  <div className="grid grid-cols-3 gap-4 rounded-lg border border-border bg-muted p-4">
                    <div>
                      <div className="text-[11px] text-muted-foreground">当前处置状态</div>
                      <div className="mt-1 text-sm font-medium text-foreground">
                        {STATUS_LABELS[detail.deal_status] || detail.deal_status_name || '--'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">指派处理人</div>
                      <div className="mt-1 text-sm text-foreground">{detail.assignee_name || '未指派'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">最近处置时间</div>
                      <div className="mt-1 font-mono text-[13px] text-foreground">{fmtTime(detail.handled_at)}</div>
                    </div>
                  </div>

                  {/* 处置表单 */}
                  {canHandle ? (
                    <div className="rounded-lg border border-border p-4">
                      <div className="mb-3 text-sm font-medium text-foreground">处置操作</div>
                      <div className="space-y-4">
                        <div>
                          <label className="mb-1 block text-xs text-muted-foreground">目标状态</label>
                          <CompactSelect
                            size="lg"
                            block
                            value={handleForm.to_status}
                            onChange={(e) => setHandleForm((f) => ({ ...f, to_status: Number(e.target.value) }))}
                          >
                            {DEAL_STATUS_OPTS
                              .filter((o) => allowedTargets.includes(o.v))
                              .map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                          </CompactSelect>
                          {allowedTargets.length === 0 && (
                            <span className="text-[11px] text-muted-foreground">当前状态无可用流转</span>
                          )}
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-muted-foreground">指派处理人（可选）</label>
                          <CompactSelect
                            size="lg"
                            block
                            value={handleForm.assignee_id}
                            onChange={(e) => setHandleForm((f) => ({ ...f, assignee_id: e.target.value }))}
                          >
                            <option value="">不指派</option>
                            {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                          </CompactSelect>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-muted-foreground">处置备注</label>
                          <AutoGrowTextarea
                            className={`${inputBaseCls} min-h-[60px] w-full resize-none`}
                            placeholder="输入处置备注..."
                            value={handleForm.comment}
                            onChange={(e) => setHandleForm((f) => ({ ...f, comment: e.target.value }))}
                          />
                        </div>
                        <div className="flex justify-end">
                          <button
                            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={submitting || allowedTargets.length === 0}
                            onClick={submitHandle}
                          >
                            {submitting ? '提交中...' : '提交处置'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-muted p-4 text-center text-sm text-muted-foreground">
                      无处置权限
                    </div>
                  )}

                  {/* 处置时间线 */}
                  <div>
                    <div className="mb-3 text-sm font-medium text-foreground">处置时间线</div>
                    {handleLogs.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">暂无处置记录</div>
                    ) : (
                      <div className="space-y-3">
                        {handleLogs.map((log) => (
                          <div key={log.id} className="flex gap-3 rounded-lg border border-border bg-muted p-3">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {ACTION_LABELS[log.action] || log.action}
                                </span>
                                {log.from_status_name && log.to_status_name && (
                                  <span className="text-xs text-muted-foreground">
                                    {log.from_status_name} → {log.to_status_name}
                                  </span>
                                )}
                              </div>
                              {log.to_assignee && (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  指派: {log.to_assignee}
                                  {log.from_assignee && log.from_assignee !== log.to_assignee && `（原: ${log.from_assignee}）`}
                                </div>
                              )}
                              {log.comment && (
                                <div className="mt-1 text-sm text-foreground">{log.comment}</div>
                              )}
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                {log.operator_name} · {fmtTime(log.created_at)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
