// 设备接入指引：学习深信服 XDR「新增设备接入」流程
// 基础步骤：选择能力 → 选择产品 → 设备信息；随后按所选能力动态追加：
//   日志采集 → 日志采集配置（采集方式/源IP/上报异常/时间校正/编码/解析模板）
//   联动处置 → 联动处置配置（设备IP/端口/API地址/认证/超时重试）
// 最终统一提交：创建设备 →（可选）新建 Syslog 接收器 → 展示接入结果
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ScrollText, Zap, Check, ChevronLeft, ChevronRight, Loader2, CheckCircle2,
  Server, Boxes, Sparkles, Info, FileJson, Radio, Globe, Plus,
} from 'lucide-react'
import { PageContainer, PageHeader, Button, Card, Badge, CompactSelect } from '../../components/ui'
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges'
import { inputCls, labelCls } from '../../components/property/FormControls'
import { devices as devicesApi } from '../../api/client'
import { strategyApi } from '../../api/strategy'
import { toast } from '../../store/toastStore'
import {
  DEVICE_TYPES, DEVICE_TYPE_LABELS, DEVICE_AUTH_TYPES,
} from './constants'
import { validateSingleIP, validateListenBind } from '../../utils/ipValidation'
import { DeviceTypeIcon, Switch } from './Badges'

const logReceivers = devicesApi.logReceivers

// ===== 可选能力（仅日志采集 / 联动处置） =====
const CAPABILITIES = [
  {
    key: 'log',
    label: '日志采集',
    icon: ScrollText,
    desc: '采集设备日志，经解析模板标准化后用于告警检测与分析',
    tags: ['Syslog 接收', '解析模板', '告警检测'],
  },
  {
    key: 'response',
    label: '联动处置',
    icon: Zap,
    desc: '通过 API 对接设备，在剧本中执行封禁 IP、隔离主机等处置动作',
    tags: ['API 对接', '剧本动作'],
  },
]

// 采集方式（Syslog 传输协议）
const COLLECT_METHODS = [
  { v: 'udp', label: 'Syslog（UDP）', desc: '默认方式，开销小' },
  { v: 'tcp', label: 'Syslog（TCP）', desc: '可靠传输，不丢日志' },
]

// 时间校正选项
const TIME_CORRECT_OPTIONS = [
  { v: 'none', label: '不校正（默认）' },
  { v: 'utc8', label: '校正为东八区（UTC+8）' },
  { v: 'utc0', label: '校正为 UTC（UTC+0）' },
  { v: 'custom', label: '自定义偏移' },
]

// 编码方式选项
const ENCODING_OPTIONS = [
  { v: 'utf-8', label: 'UTF-8（默认）' },
  { v: 'gbk', label: 'GBK' },
  { v: 'gb18030', label: 'GB18030' },
]

// 各步表单初始值
const DEVICE_INIT = { name: '', type: '', vendor: '', version: '', description: '' }
const LOG_INIT = {
  receiverMode: 'new',       // 采集器：new=新建采集器 existing=选择现有采集器
  receiverId: '',            // 现有采集器（接收器）ID
  collectProto: 'udp',       // 采集方式：Syslog-UDP / Syslog-TCP（新建时选择）
  port: 514,                 // 监听端口
  bind: '0.0.0.0',           // 监听地址
  receiverName: '',          // 接收器名称（留空自动生成）
  sourceIp: '',              // 源 IP 地址（必填）
  notifyInterval: 0,         // 上报异常通知间隔（分钟）：0=仅首次通知
  timeCorrect: 'none',       // 时间校正：none/utc8/utc0/custom
  tzOffset: 8,               // 自定义时区偏移小时
  encoding: 'utf-8',         // 编码方式
  strategyMode: 'auto',      // 解析模板：auto=自动匹配 specify=指定
  strategyId: '',
}

// 依据已有采集器列表推导默认日志配置（有启用的 Syslog 采集器则默认复用，否则新建）
function defaultLogCfg(receiverList) {
  const firstEnabled = (receiverList || []).find((r) => r.enabled && r.protocol === 'syslog')
  if (firstEnabled) {
    return { ...LOG_INIT, receiverMode: 'existing', receiverId: String(firstEnabled.id) }
  }
  return { ...LOG_INIT }
}

const RESP_INIT = {
  deviceIp: '',              // 设备 IP（必填）
  port: 443,                 // API 端口
  useHttps: true,            // HTTPS 开关
  apiPath: '/api',           // API 地址（路径或完整 URL，必填）
  authType: 'basic',         // 认证方式
  username: '',              // 用户名（basic/qingteng 必填）
  password: '',              // 密码（basic/qingteng 必填）
  apiKey: '',                // API Key（api_key/bearer 必填）
  timeout: 30,               // 超时时间（秒）
  maxRetries: 2,             // 最大重试次数
  verifyTls: false,          // TLS 证书校验
}

// 按所选能力构建步骤序列（能力步在设备信息之后动态插入）
function buildSteps(caps) {
  const steps = [
    { key: 'capability', label: '选择能力', icon: Sparkles, desc: '选择设备需要开启的接入能力，可多选' },
    { key: 'product', label: '选择产品', icon: Boxes, desc: '选择设备所属的产品类型' },
    { key: 'device', label: '设备信息', icon: Server, desc: '登记设备基础信息（名称、厂商、版本、描述）' },
  ]
  if (caps.log) {
    steps.push({ key: 'log', label: '日志采集配置', icon: ScrollText, desc: '配置采集方式、源 IP、上报异常、时间校正与编码' })
  }
  if (caps.response) {
    steps.push({ key: 'response', label: '联动处置配置', icon: Zap, desc: '配置设备 API 连接、认证方式与请求参数' })
  }
  steps.push({ key: 'done', label: '完成', icon: CheckCircle2, desc: '' })
  return steps
}

export default function DeviceOnboard() {
  const navigate = useNavigate()

  // ===== 各步表单状态 =====
  const [caps, setCaps] = useState({ log: false, response: false })
  const [deviceForm, setDeviceForm] = useState(DEVICE_INIT)
  const [logForm, setLogForm] = useState(LOG_INIT)
  const [respForm, setRespForm] = useState(RESP_INIT)

  // 当前步骤（按 key 定位，能力变化导致步骤增减时不会错位）
  const [curKey, setCurKey] = useState('capability')
  const steps = useMemo(() => buildSteps(caps), [caps])
  const stepIdx = Math.max(0, steps.findIndex((s) => s.key === curKey))
  const step = steps[stepIdx]

  // ===== 基础数据 =====
  const [receivers, setReceivers] = useState(null) // null=未加载（仅用于端口冲突预检）
  const [strategies, setStrategies] = useState(null)

  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(null) // 完成摘要
  const [touched, setTouched] = useState(false)

  // 未提交改动检测：统一提交型指引，任意填写即视为脏（完成后复位）
  useUnsavedChanges(touched && !done)

  // 挂载后加载接收器与解析模板列表（已有启用的 Syslog 采集器时默认复用）
  useEffect(() => {
    let alive = true
    logReceivers.list()
      .then((list) => {
        if (!alive) return
        const arr = Array.isArray(list) ? list : []
        setReceivers(arr)
        setLogForm(defaultLogCfg(arr))
      })
      .catch(() => {})
    strategyApi.list()
      .then((list) => { if (alive) setStrategies(Array.isArray(list) ? list : []) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 进入联动处置步时，设备 IP 预填日志源 IP（发送日志与 API 通常同为管理地址）
  useEffect(() => {
    if (curKey === 'response' && !respForm.deviceIp && logForm.sourceIp) {
      setRespForm((f) => ({ ...f, deviceIp: logForm.sourceIp }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey])

  const updateDevice = (patch) => { setDeviceForm((f) => ({ ...f, ...patch })); setTouched(true) }
  const updateLog = (patch) => { setLogForm((f) => ({ ...f, ...patch })); setTouched(true) }
  const updateResp = (patch) => { setRespForm((f) => ({ ...f, ...patch })); setTouched(true) }
  const toggleCap = (key) => { setCaps((c) => ({ ...c, [key]: !c[key] })); setTouched(true) }

  // ===== 联动处置：API 地址拼接 =====
  const buildApiUrl = () => {
    const p = respForm.apiPath.trim()
    if (/^https?:\/\//i.test(p)) return p
    const proto = respForm.useHttps ? 'https' : 'http'
    const path = p ? (p.startsWith('/') ? p : `/${p}`) : ''
    return `${proto}://${respForm.deviceIp}:${respForm.port}${path}`
  }

  // ===== 认证方式动态必填字段 =====
  const needUserPass = ['basic', 'qingteng'].includes(respForm.authType)
  const needApiKey = ['api_key', 'bearer'].includes(respForm.authType)

  // ===== 步骤校验（按 key） =====
  const canNext = () => {
    if (!step) return true
    switch (step.key) {
      case 'capability':
        return caps.log || caps.response
      case 'product':
        return !!deviceForm.type
      case 'device':
        return !!deviceForm.name.trim()
      case 'log': {
        if (!validateSingleIP(logForm.sourceIp, '源 IP 地址')) return false
        if (logForm.receiverMode === 'existing' && !logForm.receiverId) return false
        if (logForm.receiverMode === 'new') {
          const p = Number(logForm.port)
          if (!p || p < 1 || p > 65535) return false
          if (validateListenBind(logForm.bind, '监听地址')) return false
        }
        if (logForm.strategyMode === 'specify' && !logForm.strategyId) return false
        return true
      }
      case 'response': {
        if (!validateSingleIP(respForm.deviceIp, '设备 IP')) return false
        if (!respForm.apiPath.trim()) return false
        if (needUserPass && (!respForm.username.trim() || !respForm.password)) return false
        if (needApiKey && !respForm.apiKey.trim()) return false
        return true
      }
      default:
        return true
    }
  }

  // 离开当前步前的 toast 校验（指出具体缺失项）
  const validateCurrent = () => {
    if (!step) return true
    if (step.key === 'device' && !deviceForm.name.trim()) {
      toast.warning('请填写设备名称'); return false
    }
    if (step.key === 'log') {
      const srcIpMsg = validateSingleIP(logForm.sourceIp, '源 IP 地址')
      if (srcIpMsg) {
        toast.warning(srcIpMsg); return false
      }
      if (logForm.receiverMode === 'existing' && !logForm.receiverId) {
        toast.warning('请选择现有采集器，或切换为新建采集器'); return false
      }
      if (logForm.receiverMode === 'new') {
        const p = Number(logForm.port)
        if (!p || p < 1 || p > 65535) { toast.warning('监听端口需为 1-65535 的整数'); return false }
        const bindMsg = validateListenBind(logForm.bind, '监听地址')
        if (bindMsg) { toast.warning(bindMsg); return false }
      }
      if (logForm.strategyMode === 'specify' && !logForm.strategyId) {
        toast.warning('请选择解析模板，或切换为自动匹配'); return false
      }
    }
    if (step.key === 'response') {
      const devIpMsg = validateSingleIP(respForm.deviceIp, '设备 IP')
      if (devIpMsg) {
        toast.warning(devIpMsg); return false
      }
      if (!respForm.apiPath.trim()) { toast.warning('请填写 API 地址'); return false }
      if (needUserPass && !respForm.username.trim()) { toast.warning('请填写用户名'); return false }
      if (needUserPass && !respForm.password) { toast.warning('请填写密码'); return false }
      if (needApiKey && !respForm.apiKey.trim()) { toast.warning('请填写 API Key'); return false }
    }
    return true
  }

  const next = () => {
    if (stepIdx >= steps.length - 1) return navigate('/devices')
    if (!validateCurrent()) return
    if (step.key === 'response' || (step.key === 'log' && !caps.response)) {
      // 最后一个配置步 → 提交
      return handleSubmit()
    }
    setCurKey(steps[stepIdx + 1].key)
  }
  const prev = () => {
    if (stepIdx > 0 && steps[stepIdx - 1].key !== 'done') setCurKey(steps[stepIdx - 1].key)
  }

  // ===== 最终提交：创建设备 →（新建模式）创建接收器 =====
  const handleSubmit = async () => {
    const newBind = logForm.bind.trim() || '0.0.0.0'
    const newPort = Number(logForm.port)
    const isNewReceiver = caps.log && logForm.receiverMode === 'new'
    // 新建接收器：客户端预检端口冲突（与后端一致：启用中的 syslog 接收器 bind:port 唯一，传输协议不参与判定）
    if (isNewReceiver) {
      const dup = (receivers || []).find(
        (r) => r.enabled && r.protocol === 'syslog'
          && (r.syslog_bind || '0.0.0.0') === newBind && Number(r.syslog_port) === newPort
      )
      if (dup) {
        return toast.warning(`监听地址 ${newBind}:${newPort} 已被接收器「${dup.name}」占用，请更换端口或绑定地址`)
      }
    }
    setSubmitting(true)
    try {
      // 1. 创建设备（IP 归属：启用联动处置时为设备 IP，否则为日志源 IP）
      const dev = await devicesApi.create({
        name: deviceForm.name.trim(),
        type: deviceForm.type,
        vendor: deviceForm.vendor.trim(),
        version: deviceForm.version.trim(),
        description: deviceForm.description.trim(),
        ip_address: caps.response ? respForm.deviceIp.trim() : logForm.sourceIp.trim(),
        api_url: caps.response ? buildApiUrl() : '',
        auth_type: caps.response ? respForm.authType : 'none',
        api_key: caps.response && needApiKey ? respForm.apiKey : '',
        username: caps.response && needUserPass ? respForm.username.trim() : '',
        password: caps.response && needUserPass ? respForm.password : '',
        timeout: caps.response ? Number(respForm.timeout) || 30 : null,
        max_retries: caps.response ? Number(respForm.maxRetries) || 2 : null,
        verify_tls: caps.response ? !!respForm.verifyTls : false,
        enabled: true,
        tags: [],
        ...(caps.log && logForm.strategyMode === 'specify' ? { parser_strategy_id: Number(logForm.strategyId) } : {}),
      })
      // 2. 日志采集能力：新建模式创建 Syslog 接收器并绑定归属设备；现有模式复用所选采集器
      let receiverInfo = null
      if (caps.log) {
        if (isNewReceiver) {
          const receiverName = logForm.receiverName.trim() || `syslog-${newPort}`
          // adapter_config：编码（syslog 适配器实际消费）+ 时间校正（随配置保存，供解析引擎校正日志时间）
          const adapterConfig = {}
          if (logForm.encoding !== 'utf-8') adapterConfig.encoding = logForm.encoding
          if (logForm.timeCorrect === 'utc8') adapterConfig.time_correction = { tz_offset_hours: 8 }
          else if (logForm.timeCorrect === 'utc0') adapterConfig.time_correction = { tz_offset_hours: 0 }
          else if (logForm.timeCorrect === 'custom') {
            adapterConfig.time_correction = { tz_offset_hours: Number(logForm.tzOffset) || 0 }
          }
          // 源 IP 与设备 IP 不一致时，将预期源 IP 记入接收器描述留痕
          const srcIp = logForm.sourceIp.trim()
          const ipMismatch = caps.response && respForm.deviceIp && srcIp !== respForm.deviceIp.trim()
          await logReceivers.create({
            name: receiverName,
            protocol: 'syslog',
            enabled: true,
            syslog_port: newPort,
            syslog_proto: logForm.collectProto,
            syslog_bind: newBind,
            device_id: dev.id,
            format: 'json',
            strategy_id: null,
            notify_interval_minutes: Math.max(0, Number(logForm.notifyInterval) || 0),
            adapter_config: adapterConfig,
            description: ipMismatch ? `预期日志源 IP: ${srcIp}` : '',
          })
          receiverInfo = { mode: 'new', name: receiverName, ep: `${newBind}:${newPort}`, proto: logForm.collectProto }
        } else {
          const r = (receivers || []).find((x) => String(x.id) === String(logForm.receiverId))
          if (r) {
            receiverInfo = {
              mode: 'existing',
              name: r.name,
              ep: `${r.syslog_bind || '0.0.0.0'}:${r.syslog_port}`,
              proto: r.syslog_proto || 'udp',
            }
          }
        }
      }
      setDone({ deviceId: dev.id, receiverInfo, apiUrl: caps.response ? buildApiUrl() : '' })
      setTouched(false)
      setCurKey('done')
      toast.success(`设备「${dev.name}」接入完成`)
    } catch (e) {
      toast.error(e.message || '接入失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  // ===== 重置向导（继续接入下一台） =====
  const resetAll = () => {
    setCaps({ log: false, response: false })
    setDeviceForm(DEVICE_INIT)
    setLogForm(defaultLogCfg(receivers))
    setRespForm(RESP_INIT)
    setDone(null)
    setTouched(false)
    setCurKey('capability')
  }

  // 最后一个配置步（下一步即提交）
  const isLastConfigStep = step && (step.key === 'response' || (step.key === 'log' && !caps.response))

  return (
    <PageContainer>
      <PageHeader
        title="设备接入指引"
        actions={<Button variant="ghost" onClick={() => navigate('/devices')}>返回设备列表</Button>}
      />
      {/* 步骤条 */}
      <div className="mb-6 flex items-center">
        {steps.map((s, i) => {
          const Icon = s.icon
          const finished = i < stepIdx
          const active = i === stepIdx
          return (
            <div key={s.key} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition ${
                    finished ? 'border-primary bg-primary text-primary-foreground'
                      : active ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                  }`}
                >
                  {finished ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </div>
                <div className={`mt-1.5 whitespace-nowrap text-xs ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{s.label}</div>
              </div>
              {i < steps.length - 1 && (
                <div className={`mx-3 h-0.5 flex-1 self-start mt-5 ${i < stepIdx ? 'bg-primary' : 'bg-border'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* 步骤描述 */}
      {step?.desc && <div className="mb-4 text-sm text-muted-foreground">{step.desc}</div>}

      {/* 步骤内容 */}
      <Card bodyClassName="p-6">
        {step?.key === 'capability' && <StepCapability caps={caps} onToggle={toggleCap} />}
        {step?.key === 'product' && <StepProduct value={deviceForm.type} onPick={(type) => updateDevice({ type })} />}
        {step?.key === 'device' && <StepDevice form={deviceForm} onChange={updateDevice} />}
        {step?.key === 'log' && (
          <StepLogCollect
            form={logForm}
            onChange={updateLog}
            receivers={receivers}
            strategies={strategies}
          />
        )}
        {step?.key === 'response' && (
          <StepResponse
            form={respForm}
            onChange={updateResp}
            needUserPass={needUserPass}
            needApiKey={needApiKey}
            apiUrl={buildApiUrl()}
          />
        )}
        {step?.key === 'done' && done && (
          <StepDone
            done={done}
            caps={caps}
            deviceForm={deviceForm}
            logForm={logForm}
            strategies={strategies}
          />
        )}
      </Card>

      {/* 底部导航 */}
      <div className="mt-4 flex items-center justify-between">
        <Button variant="ghost" onClick={prev} disabled={stepIdx === 0 || step?.key === 'done'}>
          <ChevronLeft className="mr-1 h-4 w-4" /> 上一步
        </Button>
        <div className="text-xs text-muted-foreground">第 {stepIdx + 1} / {steps.length} 步</div>
        {step?.key === 'done' ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={resetAll}>
              继续接入下一台
            </Button>
            <Button variant="primary" onClick={() => navigate('/devices')}>
              返回设备列表 <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        ) : isLastConfigStep ? (
          <Button variant="primary" onClick={next} disabled={!canNext() || submitting}>
            {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            完成接入 <Check className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <Button variant="primary" onClick={next} disabled={!canNext()}>
            下一步 <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        )}
      </div>
    </PageContainer>
  )
}

// ============ Step 1: 选择能力（多选卡片 + 勾选角标） ============
function StepCapability({ caps, onToggle }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">选择该设备需要开启的接入能力，可同时勾选多种能力：</div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {CAPABILITIES.map((c) => {
          const selected = !!caps[c.key]
          const Icon = c.icon
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onToggle(c.key)}
              className={`relative flex items-start gap-4 rounded-lg border-2 p-5 text-left transition ${
                selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
            >
              {selected && (
                <span className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-bl-lg rounded-tr-md bg-primary text-primary-foreground">
                  <Check className="h-4 w-4" />
                </span>
              )}
              <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
                selected ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
              }`}>
                <Icon className="h-6 w-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground">{c.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{c.desc}</span>
                <span className="mt-3 flex flex-wrap gap-1.5">
                  {c.tags.map((t) => (
                    <span key={t} className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{t}</span>
                  ))}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ============ Step 2: 选择产品（卡片网格单选） ============
function StepProduct({ value, onPick }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">选择设备所属的产品类型，将用于推荐解析模板与资产归类：</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {DEVICE_TYPES.map((t) => {
          const selected = value === t.value
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => onPick(t.value)}
              className={`relative flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition ${
                selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
            >
              {selected && (
                <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3.5 w-3.5" />
                </span>
              )}
              <DeviceTypeIcon
                type={t.value}
                className={`h-8 w-8 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
              />
              <span className={`whitespace-nowrap text-sm ${selected ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                {t.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ============ Step 3: 设备信息（名称/厂商/版本/描述） ============
function StepDevice({ form, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className={labelCls}>设备名称 <span className="text-destructive">*</span></label>
        <input className={inputCls} value={form.name} onChange={(e) => onChange({ name: e.target.value })}
          placeholder="如：核心防火墙-A" />
      </div>
      <div>
        <label className={labelCls}>厂商</label>
        <input className={inputCls} value={form.vendor} onChange={(e) => onChange({ vendor: e.target.value })}
          placeholder="如：深信服 / 绿盟 / Palo Alto" />
      </div>
      <div>
        <label className={labelCls}>版本</label>
        <input className={inputCls} value={form.version} onChange={(e) => onChange({ version: e.target.value })}
          placeholder="如：V6.1R3 / 3.5.2" />
      </div>
      <div>
        <label className={labelCls}>描述</label>
        <input className={inputCls} value={form.description} onChange={(e) => onChange({ description: e.target.value })}
          placeholder="设备用途、责任人等" />
      </div>
    </div>
  )
}

// ============ 配置分区标题 ============
function ConfigSection({ icon: Icon, title, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <div className="space-y-4 pb-2">{children}</div>
    </div>
  )
}

// ============ Step 4a: 日志采集配置 ============
function StepLogCollect({ form, onChange, receivers, strategies }) {
  const [touched, setTouched] = useState({ bind: false, sourceIp: false })
  const bindError = validateListenBind(form.bind, '监听地址')
  const sourceIpError = validateSingleIP(form.sourceIp, '源 IP 地址')
  const enabledStrategies = (strategies || []).filter((s) => s.status === 'enabled')
  const sysReceivers = (receivers || []).filter((r) => r.protocol === 'syslog')
  const selectedReceiver = sysReceivers.find((r) => String(r.id) === String(form.receiverId))
  const isNew = form.receiverMode === 'new'
  // 设备侧日志发送目标（新建=本次配置端点；现有=所选采集器端点）
  const target = isNew
    ? `${form.bind || '0.0.0.0'}:${form.port || '514'}（${form.collectProto.toUpperCase()}）`
    : selectedReceiver
      ? `${selectedReceiver.syslog_bind || '0.0.0.0'}:${selectedReceiver.syslog_port}（${(selectedReceiver.syslog_proto || 'udp').toUpperCase()}）`
      : ''
  return (
    <div className="space-y-6">
      {/* 采集配置 */}
      <ConfigSection icon={ScrollText} title="采集配置">
        {/* 采集器选择：现有列表 + 新建选项 */}
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">日志采集器</div>
          <div className="space-y-2">
            {receivers !== null && sysReceivers.length === 0 && (
              <div className="text-xs text-muted-foreground">暂无现有采集器，将新建采集器接收日志</div>
            )}
            {sysReceivers.map((r) => {
              const picked = !isNew && String(r.id) === String(form.receiverId)
              const disabled = !r.enabled
              return (
                <div
                  key={r.id}
                  title={disabled ? '已停用的采集器不监听端口，请先在「接收器」页面启用' : undefined}
                  onClick={disabled ? undefined : () => onChange({ receiverMode: 'existing', receiverId: String(r.id) })}
                  className={`flex items-center gap-3 rounded-md border p-3 transition ${
                    disabled ? 'cursor-not-allowed border-border opacity-50'
                      : picked ? 'cursor-pointer border-primary bg-primary/5'
                        : 'cursor-pointer border-border hover:border-primary/50'
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                    picked ? 'border-primary' : 'border-muted-foreground'
                  }`}>
                    {picked && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                      {!r.enabled && <Badge variant="neutral">已停用</Badge>}
                    </div>
                    <div className="mt-0.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {r.syslog_bind || '0.0.0.0'}:{r.syslog_port}（{(r.syslog_proto || 'udp').toUpperCase()}）
                    </div>
                  </div>
                </div>
              )
            })}
            {/* 新建采集器选项 */}
            <div
              onClick={() => onChange({ receiverMode: 'new' })}
              className={`flex cursor-pointer items-center gap-3 rounded-md border border-dashed p-3 transition ${
                isNew ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                isNew ? 'border-primary' : 'border-muted-foreground'
              }`}>
                {isNew && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Plus className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-foreground">新建采集器</span>
              </div>
            </div>
          </div>
        </div>

        {/* 现有采集器：沿用既有配置提示 */}
        {!isNew && selectedReceiver && (
          <div className="flex items-start gap-2 rounded-md bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>复用现有采集器时，编码、时间校正与异常通知沿用该采集器的既有配置，如需调整请在「接收器」页面修改。</span>
          </div>
        )}

        {/* 新建采集器：采集参数 */}
        {isNew && (
          <>
            {/* 采集方式（必选） */}
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">日志采集方式 <span className="text-destructive">*</span></div>
              <div className="grid grid-cols-2 gap-3">
                {COLLECT_METHODS.map((m) => {
                  const picked = form.collectProto === m.v
                  return (
                    <div
                      key={m.v}
                      onClick={() => onChange({ collectProto: m.v })}
                      className={`cursor-pointer rounded-md border p-3 transition ${
                        picked ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                          picked ? 'border-primary' : 'border-muted-foreground'
                        }`}>
                          {picked && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span className="text-sm font-medium text-foreground">{m.label}</span>
                      </div>
                      <div className="mt-1.5 pl-6 text-xs text-muted-foreground">{m.desc}</div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>监听端口 <span className="text-destructive">*</span></label>
                <input type="number" className={inputCls} value={form.port}
                  onChange={(e) => onChange({ port: e.target.value })} placeholder="514" />
              </div>
              <div>
                <label className={labelCls}>监听地址</label>
                <input
                  className={`${inputCls}${touched.bind && bindError ? ' border-destructive ring-1 ring-destructive' : ''}`}
                  value={form.bind}
                  onChange={(e) => onChange({ bind: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, bind: true }))}
                  placeholder="0.0.0.0" />
                {touched.bind && bindError && (
                  <div className="mt-1 text-[11px] text-destructive">{bindError}</div>
                )}
              </div>
              <div>
                <label className={labelCls}>编码方式</label>
                <CompactSelect value={form.encoding}
                  onChange={(e) => onChange({ encoding: e.target.value })} size="lg" block>
                  {ENCODING_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </CompactSelect>
                <div className="mt-1 text-[11px] text-muted-foreground">设备日志的字符编码，选错会导致中文乱码</div>
              </div>
              <div>
                <label className={labelCls}>接收器名称</label>
                <input className={inputCls} value={form.receiverName}
                  onChange={(e) => onChange({ receiverName: e.target.value })} placeholder={`留空自动生成：syslog-${form.port || 514}`} />
              </div>
              <div>
                <label className={labelCls}>时间校正配置</label>
                <CompactSelect value={form.timeCorrect}
                  onChange={(e) => onChange({ timeCorrect: e.target.value })} size="lg" block>
                  {TIME_CORRECT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </CompactSelect>
                <div className="mt-1 text-[11px] text-muted-foreground">设备日志时间存在时区偏差时的校正方式</div>
              </div>
              {form.timeCorrect === 'custom' && (
                <div>
                  <label className={labelCls}>时区偏移（小时）</label>
                  <input type="number" className={inputCls} value={form.tzOffset}
                    onChange={(e) => onChange({ tzOffset: e.target.value })} placeholder="8" />
                  <div className="mt-1 text-[11px] text-muted-foreground">范围 -12 ~ 14，如东八区填 8</div>
                </div>
              )}
              <div>
                <label className={labelCls}>上报异常通知间隔（分钟）</label>
                <input type="number" className={inputCls} value={form.notifyInterval}
                  onChange={(e) => onChange({ notifyInterval: e.target.value })} placeholder="0" />
                <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  接收器监听中断或解析异常时经通知中心提醒：0=仅首次通知，&gt;0=异常期间每 N 分钟重复提醒
                </div>
              </div>
            </div>
          </>
        )}
      </ConfigSection>

      {/* 来源与解析 */}
      <ConfigSection icon={Radio} title="来源与解析">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>源 IP 地址 <span className="text-destructive">*</span></label>
            <input
              className={`${inputCls}${touched.sourceIp && sourceIpError ? ' border-destructive ring-1 ring-destructive' : ''}`}
              value={form.sourceIp}
              onChange={(e) => onChange({ sourceIp: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, sourceIp: true }))}
              placeholder="设备发送日志的 IP，如：192.168.1.10" />
            {touched.sourceIp && sourceIpError && (
              <div className="mt-1 text-[11px] text-destructive">{sourceIpError}</div>
            )}
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              日志到达后按来源 IP 自动生成数据源条目，请确保与设备实际发送 IP 一致
            </div>
          </div>
          <div>
            <label className={labelCls}>日志发送目标</label>
            <input readOnly className={`${inputCls} cursor-default font-mono read-only:bg-secondary read-only:text-muted-foreground read-only:hover:border-input read-only:focus:border-input read-only:focus:ring-0`} value={target} placeholder="--" />
            <div className="mt-1 text-[11px] text-muted-foreground">请将设备侧日志发送目标配置为此地址</div>
          </div>
        </div>
        <div className="text-xs font-medium text-muted-foreground">解析模板</div>
        <div className="grid grid-cols-2 gap-3">
          <div
            onClick={() => onChange({ strategyMode: 'auto' })}
            className={`cursor-pointer rounded-md border p-3 transition ${
              form.strategyMode === 'auto' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                form.strategyMode === 'auto' ? 'border-primary' : 'border-muted-foreground'
              }`}>
                {form.strategyMode === 'auto' && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <span className="text-sm font-medium text-foreground">自动匹配</span>
              <Badge variant="info">推荐</Badge>
            </div>
            <div className="mt-1.5 pl-6 text-xs leading-relaxed text-muted-foreground">
              按来源条目 → 接收器 → 设备绑定的优先级链自动匹配解析模板
            </div>
          </div>
          <div
            onClick={() => onChange({ strategyMode: 'specify' })}
            className={`cursor-pointer rounded-md border p-3 transition ${
              form.strategyMode === 'specify' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                form.strategyMode === 'specify' ? 'border-primary' : 'border-muted-foreground'
              }`}>
                {form.strategyMode === 'specify' && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <span className="text-sm font-medium text-foreground">指定模板</span>
            </div>
            <div className="mt-1.5 pl-6 text-xs text-muted-foreground">从已启用的解析模板中手动选择</div>
          </div>
        </div>
        {form.strategyMode === 'specify' && (
          <div>
            {strategies === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 模板列表加载中…
              </div>
            ) : enabledStrategies.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                <Info className="h-3.5 w-3.5 shrink-0" /> 暂无已启用的解析模板，可切换为「自动匹配」或先在「解析模板」页面创建
              </div>
            ) : (
              <CompactSelect value={form.strategyId}
                onChange={(e) => onChange({ strategyId: e.target.value })} size="lg" block>
                <option value="">请选择解析模板</option>
                {enabledStrategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.strategy_name}{s.device_type ? `（${s.device_type}）` : ''}
                  </option>
                ))}
              </CompactSelect>
            )}
          </div>
        )}
      </ConfigSection>
    </div>
  )
}

// ============ Step 4b: 联动处置配置 ============
function StepResponse({ form, onChange, needUserPass, needApiKey, apiUrl }) {
  const [ipTouched, setIpTouched] = useState(false)
  const deviceIpError = validateSingleIP(form.deviceIp, '设备 IP')
  return (
    <div className="space-y-6">
      {/* 连接配置 */}
      <ConfigSection icon={Globe} title="连接配置">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>设备 IP <span className="text-destructive">*</span></label>
            <input
              className={`${inputCls}${ipTouched && deviceIpError ? ' border-destructive ring-1 ring-destructive' : ''}`}
              value={form.deviceIp}
              onChange={(e) => onChange({ deviceIp: e.target.value })}
              onBlur={() => setIpTouched(true)}
              placeholder="如：192.168.1.10" />
            {ipTouched && deviceIpError && (
              <div className="mt-1 text-[11px] text-destructive">{deviceIpError}</div>
            )}
          </div>
          <div>
            <label className={labelCls}>端口</label>
            <input type="number" className={inputCls} value={form.port}
              onChange={(e) => onChange({ port: e.target.value })} placeholder="443" />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>API 地址 <span className="text-destructive">*</span></label>
            <div className="flex items-center gap-2">
              <Switch checked={form.useHttps} onChange={(v) => onChange({ useHttps: v })} />
              <span className="whitespace-nowrap text-xs text-muted-foreground">{form.useHttps ? 'HTTPS' : 'HTTP'}</span>
              <input className={inputCls} value={form.apiPath}
                onChange={(e) => onChange({ apiPath: e.target.value })} placeholder="API 路径（如 /api）或完整 URL" />
            </div>
            <div className="mt-1 break-all text-[11px] text-muted-foreground">
              最终 API 基地址：<span className="font-mono text-foreground">{apiUrl || '--'}</span>
            </div>
          </div>
        </div>
      </ConfigSection>

      {/* 认证配置 */}
      <ConfigSection icon={Zap} title="认证配置">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>认证方式</label>
            <CompactSelect value={form.authType}
              onChange={(e) => onChange({ authType: e.target.value })} size="lg" block>
              {DEVICE_AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </CompactSelect>
          </div>
          {needUserPass && (
            <>
              <div>
                <label className={labelCls}>用户名 <span className="text-destructive">*</span></label>
                <input className={inputCls} value={form.username}
                  onChange={(e) => onChange({ username: e.target.value })} placeholder="登录用户名" />
              </div>
              <div>
                <label className={labelCls}>密码 <span className="text-destructive">*</span></label>
                <input type="password" className={inputCls} value={form.password}
                  onChange={(e) => onChange({ password: e.target.value })} placeholder="登录密码" />
              </div>
            </>
          )}
          {needApiKey && (
            <div>
              <label className={labelCls}>
                {form.authType === 'bearer' ? 'Bearer Token' : 'API Key'} <span className="text-destructive">*</span>
              </label>
              <input type="password" className={inputCls} value={form.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })} placeholder="认证凭据" />
            </div>
          )}
        </div>
        {(form.authType === 'oauth2' || form.authType === 'mtls') && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {form.authType === 'oauth2'
              ? 'OAuth2 需在服务端配置客户端凭证、Token URL 等参数。'
              : 'mTLS 双向认证需在服务端配置客户端证书。'}
          </div>
        )}
        {form.authType === 'none' && (
          <div className="text-xs text-muted-foreground">无认证模式，直接访问 API。</div>
        )}
      </ConfigSection>

      {/* 请求参数 */}
      <ConfigSection icon={Server} title="请求参数">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelCls}>超时时间（秒）</label>
            <input type="number" className={inputCls} value={form.timeout}
              onChange={(e) => onChange({ timeout: e.target.value })} placeholder="30" />
          </div>
          <div>
            <label className={labelCls}>最大重试次数</label>
            <input type="number" className={inputCls} value={form.maxRetries}
              onChange={(e) => onChange({ maxRetries: e.target.value })} placeholder="2" />
          </div>
          <label className="flex items-end gap-2 pb-1">
            <Switch checked={!!form.verifyTls} onChange={(v) => onChange({ verifyTls: v })} />
            <span className="whitespace-nowrap text-xs text-muted-foreground">TLS 证书校验</span>
          </label>
        </div>
      </ConfigSection>
    </div>
  )
}

// ============ 最后一步: 完成 ============
function StepDone({ done, caps, deviceForm, logForm, strategies }) {
  const strategy = (strategies || []).find((s) => String(s.id) === String(logForm.strategyId))
  const tzLabel = {
    none: '不校正',
    utc8: '东八区（UTC+8）',
    utc0: 'UTC（UTC+0）',
    custom: `自定义偏移 ${logForm.tzOffset} 小时`,
  }[logForm.timeCorrect]

  const rows = [
    { label: '设备名称', value: `${deviceForm.name}（ID: ${done.deviceId}）` },
    { label: '产品类型', value: DEVICE_TYPE_LABELS[deviceForm.type] || deviceForm.type },
    { label: '厂商 / 版本', value: `${deviceForm.vendor || '--'} / ${deviceForm.version || '--'}` },
    {
      label: '开启能力',
      value: (
        <span className="flex items-center gap-1.5">
          {caps.log && <Badge variant="info">日志采集</Badge>}
          {caps.response && <Badge variant="success">联动处置</Badge>}
        </span>
      ),
    },
  ]
  if (caps.log) {
    rows.push({
      label: '日志接收',
      value: done.receiverInfo
        ? `${done.receiverInfo.mode === 'existing' ? '使用已有采集器' : '新建采集器'}「${done.receiverInfo.name}」监听 ${done.receiverInfo.ep}（${done.receiverInfo.proto.toUpperCase()}）`
        : '--',
    })
    rows.push({ label: '解析模板', value: logForm.strategyMode === 'specify' ? `指定「${strategy?.strategy_name || logForm.strategyId}」` : '自动匹配' })
    rows.push({
      label: '采集参数',
      value: done.receiverInfo?.mode === 'existing'
        ? '编码 / 时间校正 / 异常通知沿用所选采集器既有配置'
        : `编码 ${logForm.encoding.toUpperCase()} · 时间校正：${tzLabel} · 异常通知：${Number(logForm.notifyInterval) > 0 ? `每 ${logForm.notifyInterval} 分钟` : '仅首次'}`,
    })
  }
  if (caps.response) {
    rows.push({ label: 'API 基地址', value: done.apiUrl || '--' })
    rows.push({ label: '后续操作', value: '请在设备列表中展开设备卡片，配置 API 动作定义，即可在剧本中调用' })
  }

  return (
    <div className="space-y-6">
      {/* 成功横幅 */}
      <div className="flex flex-col items-center py-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="h-8 w-8" />
        </span>
        <div className="mt-3 text-base font-medium text-foreground">设备接入完成</div>
        <div className="mt-1 text-xs text-muted-foreground">设备已创建，可在设备列表中查看与管理</div>
      </div>

      {/* 接入摘要 */}
      <div className="rounded-md border border-border">
        {rows.map((r, i) => (
          <div key={r.label} className={`flex items-start gap-4 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}>
            <span className="w-24 shrink-0 whitespace-nowrap text-xs text-muted-foreground">{r.label}</span>
            <span className="min-w-0 flex-1 break-all text-sm text-foreground">{r.value}</span>
          </div>
        ))}
      </div>

      {/* 后续操作提示 */}
      {caps.log && done.receiverInfo && (
        <div className="flex items-start gap-2 rounded-md bg-primary/10 p-3 text-xs leading-relaxed text-primary">
          <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            请将设备侧的日志发送目标配置为
            <span className="mx-1 font-mono font-medium">{done.receiverInfo.ep}</span>（{done.receiverInfo.proto.toUpperCase()}），
            日志到达后可在「数据源条目」页面查看并调整解析策略。
          </span>
        </div>
      )}
      {caps.log && logForm.strategyMode === 'specify' && (
        <div className="flex items-start gap-2 rounded-md bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">
          <FileJson className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>建议在「解析模板」页面使用实时测试验证样例日志可正常解析。</span>
        </div>
      )}
    </div>
  )
}
