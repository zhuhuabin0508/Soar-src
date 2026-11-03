// 数据源条目详情页：三个 Tab —— 基本信息 / 解析模板（模板+覆盖配置）/ 日志预览（原始日志与解析结果左右分栏对照）
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, CheckCircle2, FileJson, FlaskConical, Info, RefreshCw, Trash2, X,
} from 'lucide-react'
import { confirm } from '../../components/ConfirmDialog'
import { toast } from '../../store/toastStore'
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges'
import { inputCls } from '../../components/property/FormControls'
import { devices as devicesApi } from '../../api/client'
import { strategyApi } from '../../api/strategy'
import { Section, Switch } from '../devices/Badges'
import {Button, EmptyState, CompactSelect, AutoGrowTextarea } from '../../components/ui'
import {
  SOURCE_TYPE_META, PROTOCOL_TAG_CLS, ENTRY_STATUS_META, DEVICE_TYPE_LABELS,
  PARSE_STATUS_META, parseAdapterConfig,
} from './receiverMeta'

const fmtCount = (n) => (n ?? 0).toLocaleString()
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—')

// ---- 过滤规则操作符（覆盖配置用，与后端 runner filter 对应） ----
const FILTER_OPS = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'regex', label: '正则匹配' },
  { value: 'in', label: '在列表中' },
  { value: 'not_in', label: '不在列表中' },
  { value: 'exists', label: '字段存在' },
  { value: 'empty', label: '字段为空' },
]
const NO_VALUE_OPS = new Set(['exists', 'empty'])

// value 字符串 → 规则值（数字智能转换；in/not_in 逗号分隔转数组）
function ruleValueFromString(op, text) {
  const t = String(text ?? '').trim()
  if (op === 'in' || op === 'not_in') {
    return t ? t.split(',').map((x) => {
      const s = x.trim()
      const n = Number(s)
      return s !== '' && !Number.isNaN(n) ? n : s
    }) : []
  }
  if (t === '') return ''
  const n = Number(t)
  return !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(t) ? n : t
}

// Tab 按钮样式
function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-3 text-sm transition ${
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

export default function SourceEntryDetail() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [entry, setEntry] = useState(null)
  const [devices, setDevices] = useState([])
  const [strategies, setStrategies] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('basic')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await devicesApi.logReceivers.entryDetail(id)
      setEntry(res)
    } catch (err) {
      toast.error(err.message || '加载条目详情失败')
      navigate('/source-entries', { replace: true })
    } finally {
      setLoading(false)
    }
  }, [id, navigate])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    devicesApi.list().then((res) => { if (!cancelled) setDevices(Array.isArray(res) ? res : res?.items || []) }).catch(() => {})
    strategyApi.list().then((res) => { if (!cancelled) setStrategies(Array.isArray(res) ? res : res?.items || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (loading && !entry) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">加载条目详情中…</div>
  }
  if (!entry) return null

  const st = ENTRY_STATUS_META[entry.status] || { label: entry.status, cls: 'bg-secondary text-muted-foreground' }
  const deviceTypeLabel = entry.device_type ? (DEVICE_TYPE_LABELS[entry.device_type] || entry.device_type) : ''

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-6 py-6">
      {/* 页头：返回 + 名称/IP + 状态徽标 + 接收器 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button" onClick={() => navigate('/source-entries')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="返回数据源条目列表"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{entry.name !== entry.source_ip ? entry.name : entry.source_ip}</h1>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${st.cls}`} title={st.desc}>{st.label}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{entry.source_ip}</span>
              <span>·</span>
              <span>所属接收器</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${PROTOCOL_TAG_CLS[entry.receiver_protocol] || 'bg-secondary text-muted-foreground'}`}>
                {SOURCE_TYPE_META[entry.receiver_protocol]?.label || entry.receiver_protocol}
              </span>
              <span className="font-medium text-foreground">{entry.receiver_name}</span>
              {deviceTypeLabel && (<><span>·</span><span>设备类型 {deviceTypeLabel}</span></>)}
            </div>
          </div>
        </div>
        <Button variant="secondary" onClick={load}>
          <RefreshCw className="h-4 w-4" /> 刷新
        </Button>
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton active={tab === 'basic'} onClick={() => setTab('basic')}><span className="inline-flex items-center gap-1.5"><Info className="h-3.5 w-3.5" />基本信息</span></TabButton>
        <TabButton active={tab === 'strategy'} onClick={() => setTab('strategy')}><span className="inline-flex items-center gap-1.5"><FlaskConical className="h-3.5 w-3.5" />解析模板</span></TabButton>
        <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}><span className="inline-flex items-center gap-1.5"><FileJson className="h-3.5 w-3.5" />日志预览</span></TabButton>
      </div>

      {tab === 'basic' && <BasicInfoTab entry={entry} devices={devices} onSaved={load} onDeleted={() => navigate('/source-entries')} />}
      {tab === 'strategy' && <StrategyTab entry={entry} strategies={strategies} onSaved={load} />}
      {tab === 'preview' && <PreviewTab entry={entry} />}
    </div>
  )
}

// ============ Tab 1：基本信息 ============
function BasicInfoTab({ entry, devices, onSaved, onDeleted }) {
  const [name, setName] = useState(entry.name)
  const [deviceId, setDeviceId] = useState(entry.device_id ? String(entry.device_id) : '')
  const [enabled, setEnabled] = useState(entry.enabled)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(entry.name)
    setDeviceId(entry.device_id ? String(entry.device_id) : '')
    setEnabled(entry.enabled)
  }, [entry.id, entry.name, entry.device_id, entry.enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = name !== entry.name
    || deviceId !== (entry.device_id ? String(entry.device_id) : '')
    || enabled !== entry.enabled
  // 离开页面拦截 + 关闭浏览器提醒 + Ctrl+S 触发保存
  const bypassGuard = useUnsavedChanges(dirty, { onSave: () => handleSave() })

  const handleSave = async () => {
    setSaving(true)
    try {
      await devicesApi.logReceivers.entryUpdate(entry.id, {
        name: name.trim() || entry.source_ip,
        device_id: deviceId ? Number(deviceId) : 0,
        enabled,
      })
      toast.success('基本信息已保存')
      bypassGuard() // 保存成功放行后续导航
      onSaved()
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    const ok = await confirm({
      title: '删除数据源条目',
      message: `确定删除条目「${entry.source_ip}」？该来源再次发送日志时会按接收器发现开关重新自动创建。`,
      variant: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await devicesApi.logReceivers.entryRemove(entry.id)
      toast.success('条目已删除')
      bypassGuard() // 删除已确认，跳转列表页不再被未保存拦截
      onDeleted()
    } catch (err) {
      toast.error(err.message || '删除失败')
    }
  }

  const infoRows = [
    { label: '来源 IP', value: <span className="font-mono">{entry.source_ip}</span> },
    { label: '绑定设备', value: entry.device_name || <span className="text-muted-foreground">未绑定</span> },
    { label: '设备类型', value: deviceTypeLabelOf(entry) },
    { label: '累计接收', value: <span title="该来源自条目创建以来累计接收的日志条数（每条日志计一次）">{fmtCount(entry.received_count)}</span> },
    {
      label: '今日接收 / 解析成功 / 失败',
      value: (
        <span title="今日统计基于解析终态明细（success/partial/fail/unknown），与累计接收同口径；失败含解析失败与类型识别失败">
          <span className="tabular-nums">{fmtCount(entry.today_received)}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="tabular-nums">{fmtCount(entry.today_parsed)}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className={`tabular-nums ${entry.today_failed ? 'text-destructive' : 'text-muted-foreground'}`}>
            {fmtCount(entry.today_failed)}
          </span>
        </span>
      ),
    },
    { label: '最近活跃', value: fmtTime(entry.last_received_at) },
    { label: '创建时间', value: fmtTime(entry.created_at) },
    { label: '创建方式', value: entry.auto_created ? '自动发现' : '手工管理' },
  ]

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 只读信息 */}
      <div className="card">
        <div className="border-b border-border px-5 py-3 text-sm font-medium">接入概览</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4">
          {infoRows.map((r) => (
            <div key={r.label}>
              <div className="text-xs text-muted-foreground">{r.label}</div>
              <div className="mt-1 text-sm font-medium tabular-nums">{r.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 可编辑信息 */}
      <div className="card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="text-sm font-medium">基础配置</span>
          <span className="text-[11px] text-muted-foreground">条目配置仅覆盖该来源 IP，优先级高于接收器默认</span>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">条目名称</div>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={entry.source_ip} />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">绑定设备</div>
            <CompactSelect value={deviceId} onChange={(e) => setDeviceId(e.target.value)} size="lg" block>
              <option value="">不绑定（走条目/接收器自身归属）</option>
              {devices.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
            </CompactSelect>
            <div className="mt-1 text-[10px] text-muted-foreground">告警与接收日志计入该设备；未绑定时走接收器默认归属</div>
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onChange={setEnabled} />
            <span className="text-sm text-muted-foreground">
              启用该来源
              <span className="ml-1 text-[10px] text-muted-foreground">停用后该来源日志将被丢弃（不解析、不入库）</span>
            </span>
          </label>
          <div className="mt-1 flex items-center justify-between">
            <button
              type="button" onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" /> 删除条目
            </button>
            <div className="flex items-center gap-3">
              {dirty && <span className="text-xs text-warning" title="基础配置有未保存的修改（Ctrl+S 保存）">未保存</span>}
              <button type="button" onClick={handleSave} disabled={!dirty || saving} className="btn-primary btn-sm disabled:opacity-50">
                {saving ? '保存中…' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function deviceTypeLabelOf(entry) {
  if (!entry.device_type) {
    // 未识别：灰字 + 「去配置」链接，引导完成设备接入绑定
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">未识别</span>
        <Link to="/device-onboard" className="text-xs text-primary transition hover:underline" title="打开设备接入指引，完成设备接入与解析模板配置">去配置</Link>
      </span>
    )
  }
  return DEVICE_TYPE_LABELS[entry.device_type] || entry.device_type
}

// ============ Tab 2：解析模板（模板选择 + 覆盖配置） ============
function StrategyTab({ entry, strategies, onSaved }) {
  const [strategyId, setStrategyId] = useState(entry.strategy_id ? String(entry.strategy_id) : '')
  const [filterOn, setFilterOn] = useState(false)
  const [filterMatch, setFilterMatch] = useState('all')
  const [rules, setRules] = useState([])
  const [enrichers, setEnrichers] = useState([])
  const [translatorJson, setTranslatorJson] = useState('')
  const [translatorErr, setTranslatorErr] = useState('')
  const [saving, setSaving] = useState(false)
  // 未保存修改检测：最近一次保存/加载的覆盖配置快照，与当前表单对比
  const [savedSnapshot, setSavedSnapshot] = useState('')

  useEffect(() => {
    const pipe = (parseAdapterConfig(entry.entry_config).pipeline) || {}
    setStrategyId(entry.strategy_id ? String(entry.strategy_id) : '')
    const flt = pipe.filter || {}
    setFilterOn(!!flt.enabled)
    setFilterMatch(flt.match || 'all')
    const initRules = (flt.rules || []).map((r) => ({ field: r.field || '', op: r.op || 'eq', value: r.value == null ? '' : String(Array.isArray(r.value) ? r.value.join(',') : r.value) }))
    setRules(initRules)
    const initEnrichers = [...((pipe.enricher || {}).enrichers || [])]
    setEnrichers(initEnrichers)
    const initTranslator = pipe.translator && Object.keys(pipe.translator).length ? pipe.translator : {}
    setTranslatorJson(pipe.translator && Object.keys(pipe.translator).length ? JSON.stringify(pipe.translator, null, 2) : '')
    setTranslatorErr('')
    setSavedSnapshot(JSON.stringify({
      strategyId: entry.strategy_id ? String(entry.strategy_id) : '',
      filterOn: !!flt.enabled, filterMatch: flt.match || 'all',
      rules: initRules, enrichers: initEnrichers, translator: initTranslator,
    }))
  }, [entry.id, entry.strategy_id, entry.entry_config]) // eslint-disable-line react-hooks/exhaustive-deps

  // 与快照对比；translator JSON 改坏时同样视为有未保存修改
  const dirty = useMemo(() => {
    if (!savedSnapshot) return false
    let translator = {}
    try {
      translator = translatorJson.trim() ? JSON.parse(translatorJson) : {}
    } catch {
      return true
    }
    const cur = JSON.stringify({
      strategyId, filterOn, filterMatch, rules, enrichers,
      translator: translator || {},
    })
    return cur !== savedSnapshot
  }, [savedSnapshot, strategyId, filterOn, filterMatch, rules, enrichers, translatorJson])
  // 离开页面拦截 + 关闭浏览器提醒 + Ctrl+S 触发保存
  const bypassGuard = useUnsavedChanges(dirty, { onSave: () => handleSave() })

  const setRule = (i, k, v) => setRules((p) => p.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const addRule = () => setRules((p) => [...p, { field: '', op: 'eq', value: '' }])
  const removeRule = (i) => setRules((p) => p.filter((_, idx) => idx !== i))
  const toggleEnricher = (n, on) => setEnrichers((p) => (on ? [...new Set([...p, n])] : p.filter((x) => x !== n)))

  const handleSave = async () => {
    if (filterOn) {
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i]
        if (!r.field.trim()) { toast.warning(`第 ${i + 1} 条过滤规则需填写字段名`); return }
        if (!NO_VALUE_OPS.has(r.op) && String(r.value).trim() === '') { toast.warning(`第 ${i + 1} 条过滤规则需填写判定值`); return }
      }
    }
    let translator = {}
    if (translatorJson.trim()) {
      try {
        translator = JSON.parse(translatorJson)
        setTranslatorErr('')
      } catch (err) {
        setTranslatorErr(`词表翻译 JSON 解析失败：${err.message}`)
        return
      }
    }
    const entry_config = {
      pipeline: {
        filter: { enabled: filterOn, match: filterMatch, rules: rules.map((r) => ({ field: r.field.trim(), op: r.op, value: ruleValueFromString(r.op, r.value) })) },
        enricher: { enrichers },
        translator,
      },
    }
    setSaving(true)
    try {
      await devicesApi.logReceivers.entryUpdate(entry.id, {
        strategy_id: strategyId ? Number(strategyId) : 0,
        entry_config,
      })
      toast.success('解析模板配置已保存')
      bypassGuard() // 保存成功放行后续导航
      onSaved()
    } catch (err) {
      toast.error(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="card px-5 py-4">
        <div className="mb-1 text-sm font-medium">解析模板</div>
        <div className="mb-3 text-[11px] text-muted-foreground">
          优先级链：条目固定模板 → 接收器默认模板（{entry.receiver_strategy_id ? '已固定' : '自动匹配'}）→ 系统自动匹配
        </div>
        <CompactSelect value={strategyId} onChange={(e) => setStrategyId(e.target.value)} size="lg" block className="max-w-md">
          <option value="">跟随接收器（{entry.receiver_strategy_id ? `固定 #${entry.receiver_strategy_id}` : '自动匹配'}）</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>{s.strategy_name}{s.device_type ? `（${s.device_type}）` : ''}</option>
          ))}
        </CompactSelect>
        <div className="mt-1 text-xs text-muted-foreground">
          {strategyId
            ? '选择模板后固定使用该模板解析，失败即记为失败，不会自动切换其他模板。'
            : '不选择则跟随接收器默认；接收器也未固定时由系统按元数据/特征自动匹配。'}
        </div>
      </div>

      <Section title="过滤覆盖" hint="命中规则即丢弃该来源的事件（仅覆盖本条目）">
        <label className="flex items-center gap-2">
          <Switch checked={filterOn} onChange={setFilterOn} />
          <span className="text-sm text-muted-foreground">启用过滤规则</span>
        </label>
        {filterOn && (
          <div className="mt-2 flex flex-col gap-2">
            {rules.length === 0 && (
              <div className="text-xs text-muted-foreground">暂无规则；添加后按条件丢弃事件，如丢弃健康检查类告警</div>
            )}
            {rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className={`${inputCls} flex-1 font-mono`} placeholder="字段名，如 alert_name" value={r.field} onChange={(e) => setRule(i, 'field', e.target.value)} />
                <CompactSelect value={r.op} onChange={(e) => setRule(i, 'op', e.target.value)} size="md" className="w-[120px]">
                  {FILTER_OPS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </CompactSelect>
                <input
                  className={`${inputCls} flex-1 font-mono`} placeholder={NO_VALUE_OPS.has(r.op) ? '（无需值）' : '判定值（in 类逗号分隔）'}
                  value={r.value} disabled={NO_VALUE_OPS.has(r.op)} onChange={(e) => setRule(i, 'value', e.target.value)}
                />
                <button type="button" onClick={() => removeRule(i)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="删除规则">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button type="button" onClick={addRule} className="btn-secondary btn-sm">+ 添加规则</button>
              <CompactSelect value={filterMatch} onChange={(e) => setFilterMatch(e.target.value)} size="md">
                <option value="all">全部条件满足才丢弃</option>
                <option value="any">任一条件满足即丢弃</option>
              </CompactSelect>
            </div>
          </div>
        )}
      </Section>

      <Section title="富化覆盖" hint="解析后按事件字段补充信息（仅覆盖本条目）">
        <label className="flex items-center gap-2">
          <input
            type="checkbox" className="h-4 w-4 accent-primary"
            checked={enrichers.includes('asset')}
            onChange={(e) => toggleEnricher('asset', e.target.checked)}
          />
          <span className="text-sm">资产关联富化</span>
          <span className="text-[10px] text-muted-foreground">按 src_ip / host_ip 匹配设备表，补 asset_id 与设备名</span>
        </label>
      </Section>

      <Section title="词表翻译覆盖（高级）" hint='translator 覆盖 JSON，如 {"maps": {"risk_level_name": {"0": "严重"}}, "sources": {"risk_level_name": "risk_level"}}'>
        <AutoGrowTextarea
          className={`${inputCls} resize-y font-mono text-xs`} rows={5} spellCheck={false}
          placeholder='留空则跟随接收器；填写则覆盖该来源的词表翻译'
          value={translatorJson} onChange={(e) => { setTranslatorJson(e.target.value); setTranslatorErr('') }}
        />
        {translatorErr && <p className="mt-1 text-xs text-destructive">{translatorErr}</p>}
      </Section>

      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-xs text-warning" title="覆盖配置有未保存的修改（Ctrl+S 保存）">未保存</span>}
        <button type="button" onClick={handleSave} disabled={saving} className="btn-primary btn-sm">
          {saving ? '保存中…' : '保存解析模板配置'}
        </button>
      </div>
    </div>
  )
}

// ============ Tab 3：日志预览（原始日志 ↔ 解析结果，左右分栏对照） ============
function PreviewTab({ entry }) {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [parseStatus, setParseStatus] = useState('')
  const [selected, setSelected] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await devicesApi.logReceivers.receiveLogs({
        receiver_id: entry.receiver_id,
        source_ip: entry.source_ip,
        parse_status: parseStatus || undefined,
        page: 1,
        page_size: 50,
      })
      setLogs(res?.items || [])
      setTotal(res?.total || 0)
      setSelected((prev) => (prev && (res?.items || []).some((l) => l.id === prev.id) ? prev : (res?.items || [])[0] || null))
    } catch (err) {
      toast.error(err.message || '加载接收日志失败')
    } finally {
      setLoading(false)
    }
  }, [entry.receiver_id, entry.source_ip, parseStatus])

  useEffect(() => { load() }, [load])

  // 原始日志美化（JSON 则格式化，否则原样）
  const prettyRaw = (raw) => {
    if (!raw) return ''
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 筛选栏 */}
      <div className="flex items-center gap-2">
        <CompactSelect value={parseStatus} onChange={(e) => setParseStatus(e.target.value)} size="lg">
          <option value="">全部解析状态</option>
          {Object.entries(PARSE_STATUS_META).map(([v, m]) => (<option key={v} value={v}>{m.label}</option>))}
        </CompactSelect>
        <Button variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          该来源最近 {logs.length} 条（共 {fmtCount(total)} 条）
        </span>
      </div>

      {/* 左右分栏：左原始日志列表，右解析结果 */}
      <div className="grid gap-3 lg:grid-cols-2">
        {/* 左：原始日志 */}
        <div className="card flex min-h-[420px] flex-col overflow-hidden">
          <div className="border-b border-border px-5 py-2.5 text-sm font-medium">原始日志</div>
          <div className="flex-1 overflow-y-auto p-2" style={{ maxHeight: '560px' }}>
            {loading && logs.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
            ) : logs.length === 0 ? (
              <EmptyState
                icon={FileJson}
                title="暂无接收日志"
                description="该来源尚未有日志到达，或已被过滤规则丢弃"
                className="py-10"
              />
            ) : (
              logs.map((l) => {
                const pm = PARSE_STATUS_META[l.parse_status] || { label: l.parse_status, cls: 'bg-secondary text-muted-foreground' }
                const active = selected?.id === l.id
                return (
                  <button
                    key={l.id} type="button"
                    onClick={() => setSelected(l)}
                    className={`mb-1 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition ${
                      active ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-accent'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">{fmtTime(l.received_at)}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${pm.cls}`}>{pm.label}</span>
                    </div>
                    <div className="w-full truncate font-mono text-xs text-foreground" title={l.raw_data}>
                      {l.raw_data || '（空）'}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* 右：解析结果 */}
        <div className="card flex min-h-[420px] flex-col overflow-hidden">
          <div className="border-b border-border px-5 py-2.5 text-sm font-medium">解析结果</div>
          {!selected ? (
            <EmptyState
              icon={CheckCircle2}
              title="未选择日志"
              description="点击左侧任意一条原始日志，查看其解析结果对照"
              className="flex-1 py-10"
            />
          ) : (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" style={{ maxHeight: '560px' }}>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
                <div>
                  <div className="text-muted-foreground">接收时间</div>
                  <div className="mt-0.5 font-medium tabular-nums">{fmtTime(selected.received_at)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">解析状态</div>
                  <div className="mt-0.5">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${(PARSE_STATUS_META[selected.parse_status] || {}).cls || 'bg-secondary text-muted-foreground'}`}>
                      {(PARSE_STATUS_META[selected.parse_status] || {}).label || selected.parse_status}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">关联告警</div>
                  <div className="mt-0.5 font-medium">
                    {selected.alert_id ? `告警 #${selected.alert_id}` : <span className="text-muted-foreground">未生成告警</span>}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">接收器</div>
                  <div className="mt-0.5 font-medium">{entry.receiver_name}</div>
                </div>
              </div>

              {/* 命中的解析模板与规则（存量日志无记录时隐藏该块） */}
              {(selected.strategy_name || selected.rule_id || selected.log_type || selected.strategy_id) && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">命中解析模板</div>
                    <div className="mt-0.5 font-medium">
                      {selected.strategy_name ? (
                        <span>{selected.strategy_name}{selected.strategy_id ? <span className="text-muted-foreground">（#{selected.strategy_id}）</span> : null}</span>
                      ) : <span className="text-muted-foreground">未记录</span>}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">命中规则</div>
                    <div className="mt-0.5 font-medium">
                      {selected.rule_id ? (
                        <span className="font-mono">{selected.rule_id}{selected.log_type ? <span className="font-sans text-muted-foreground">（{selected.log_type}）</span> : null}</span>
                      ) : <span className="text-muted-foreground">未记录</span>}
                    </div>
                  </div>
                </div>
              )}

              {/* 解析后内容（标准模型字段，与原文对照） */}
              {selected.parsed_fields && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">解析后内容（标准模型字段）</div>
                  <pre className="max-h-[280px] overflow-auto rounded-md border border-primary/20 bg-primary/5 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                    {prettyRaw(selected.parsed_fields) || '（空）'}
                  </pre>
                </div>
              )}

              {selected.parse_error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <div className="mb-1 text-xs font-medium text-destructive">解析错误</div>
                  <div className="break-all font-mono text-[11px] leading-relaxed text-destructive/90">{selected.parse_error}</div>
                </div>
              )}

              {selected.parse_status === 'fail' && !selected.parse_error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  解析失败：请检查该条目绑定的解析模板是否与日志格式匹配，可在「解析模板」页用此样本测试。
                </div>
              )}

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">原始内容（格式化）</div>
                <pre className="max-h-[280px] overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {prettyRaw(selected.raw_data) || '（空）'}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
