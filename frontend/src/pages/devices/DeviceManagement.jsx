// 设备对接主页面（从 DeviceManagement.jsx 拆分，重新汇总子组件）
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Shield, Plus, RefreshCw, Download, Upload, Wifi, WifiOff, Files, Columns, CheckSquare,
  Database, ChevronDown, Activity, Zap, CheckCircle2, FilePlus2, Trash2, Library,
} from 'lucide-react'
import { devices as devicesApi } from '../../api/client'
import { Modal } from '../../components/Dialog'
import { confirm } from '../../components/ConfirmDialog'
import { toast } from '../../store/toastStore'
import { TutorialButton, TutorialDrawer } from '../../components/TutorialDrawer'
import { DEVICE_TUTORIAL } from '../../components/tutorialContent'
import { usePersistedFilters } from '../../hooks/usePersistedFilters'
import FilterBar from '../../components/FilterBar'
import {
  VIEW_MODES,
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
  STATUS_OPTIONS,
  STATUS_META,
  fmtRelative,
  fmtTime,
  fmtNum,
  numCell,
  parseTags,
  truncate,
} from './constants'
import { DeviceTypeIcon, StatusBadge } from './Badges'
import {
  ActionFormModal,
  ActionHistoryModal,
  ActionTestDrawer,
  TemplateCreateModal,
  TemplateModal,
} from './ActionModal'
import { CallLogsTab } from './CallLogsTab'
import { ActionTable, DeviceCard, DeviceRow, DeviceCardSkeleton, DeviceTableSkeleton, NumCell } from './DeviceList'
import { DeviceFormModal } from './DeviceModal'

function DeviceManagement() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('devices') // devices | logs
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 视图模式：card / table / split
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem('soar_device_view') || 'card'
    } catch {
      return 'card'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('soar_device_view', viewMode)
    } catch {
      // ignore
    }
  }, [viewMode])

  // 筛选
  const [filters, setFilters] = usePersistedFilters('device_mgmt', {
    search: '',
    type: '',
    vendor: '',
    status: '',
    tag: '',
  })

  // 展开状态（记忆展开）
  const [expandedIds, setExpandedIds] = useState(() => {
    try {
      const raw = localStorage.getItem('soar_device_expanded')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('soar_device_expanded', JSON.stringify(expandedIds))
    } catch {
      // ignore
    }
  }, [expandedIds])

  // 选中设备（分栏视图用）
  const [selectedId, setSelectedId] = useState(null)
  // 每台设备的动作列表（key=deviceId），避免多设备展开/切换时动作互相串
  const [actionsMap, setActionsMap] = useState({})
  const [loadingActions, setLoadingActions] = useState(false)
  // 勾选用于导出 / 批量删除的设备 ID 集合
  const [checkIds, setCheckIds] = useState([])
  // 批量删除请求进行中
  const [batchDeleting, setBatchDeleting] = useState(false)
  // 最近一次勾选位置，用于 Shift 连续区间多选
  const lastCheckIndexRef = useRef(null)

  // 切换某台设备的勾选状态（Shift 点击支持连续多选）
  const toggleCheck = (device, shiftKey = false) => {
    const idx = filteredDevices.findIndex((d) => d.id === device.id)
    const lastIdx = lastCheckIndexRef.current
    setCheckIds((prev) => {
      if (shiftKey && lastIdx != null && idx !== -1) {
        const [start, end] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx]
        const rangeIds = filteredDevices.slice(start, end + 1).map((d) => d.id)
        if (prev.includes(device.id)) {
          return prev.filter((id) => !rangeIds.includes(id))
        }
        return Array.from(new Set([...prev, ...rangeIds]))
      }
      return prev.includes(device.id)
        ? prev.filter((x) => x !== device.id)
        : [...prev, device.id]
    })
    lastCheckIndexRef.current = idx
  }

  // 弹窗状态
  const [devFormOpen, setDevFormOpen] = useState(false)
  const [devEditing, setDevEditing] = useState(null)
  const [devSaving, setDevSaving] = useState(false)

  const [actFormOpen, setActFormOpen] = useState(false)
  const [actEditing, setActEditing] = useState(null)
  const [actSaving, setActSaving] = useState(false)
  const [actDeviceId, setActDeviceId] = useState(null)

  // 测试连接
  const [testingDeviceId, setTestingDeviceId] = useState(null)
  const [testConnResult, setTestConnResult] = useState(null)
  const [testConnOpen, setTestConnOpen] = useState(false)

  // 动作测试抽屉
  const [testDrawerOpen, setTestDrawerOpen] = useState(false)
  const [testAction, setTestAction] = useState(null)
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState(null)

  // 动作启用切换
  const [togglingActionId, setTogglingActionId] = useState(null)

  // 动作历史
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyAction, setHistoryAction] = useState(null)
  const [historyDeviceId, setHistoryDeviceId] = useState(null)

  // 模板
  const [templates, setTemplates] = useState([])
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateCreateOpen, setTemplateCreateOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [templateSaving, setTemplateSaving] = useState(false)

  // 健康检查
  const [healthChecking, setHealthChecking] = useState(false)

  const [tutorialOpen, setTutorialOpen] = useState(false)

  // 导入文件 input ref
  const importInputRef = useRef(null)
  // 头部「数据」下拉菜单（ref + document 监听实现点击外部关闭，不用全屏遮罩避免拦截交互）
  const [dataMenuOpen, setDataMenuOpen] = useState(false)
  const dataMenuRef = useRef(null)
  useEffect(() => {
    if (!dataMenuOpen) return
    const onDocMouseDown = (e) => {
      if (dataMenuRef.current && !dataMenuRef.current.contains(e.target)) {
        setDataMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [dataMenuOpen])

  // 加载设备
  const loadDevices = useCallback(async () => {
    setLoading(true)
    try {
      const data = await devicesApi.list()
      const list = Array.isArray(data) ? data : []
      setDevices(list)
      setError('')
      // 失败告警：状态由 online 变为 offline 时提示
      // 通过对比前后状态实现
    } catch (err) {
      setError(err.message || '加载设备失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 用 ref 记录上次状态用于失败告警
  const prevStatusRef = useRef({})
  useEffect(() => {
    if (!devices.length) return
    const prev = prevStatusRef.current
    const next = {}
    devices.forEach((d) => {
      next[d.id] = d.status
      if (prev[d.id] === 'online' && d.status === 'offline') {
        toast.error(`设备「${d.name}」已离线`)
      }
    })
    prevStatusRef.current = next
  }, [devices])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  const loadActions = useCallback(async (deviceId) => {
    if (!deviceId) return
    setLoadingActions(true)
    try {
      const data = await devicesApi.listActions(deviceId)
      const arr = Array.isArray(data) ? data : []
      setActionsMap((m) => ({ ...m, [deviceId]: arr }))
    } catch (err) {
      toast.error(`加载动作失败：${err.message || err}`)
      setActionsMap((m) => ({ ...m, [deviceId]: [] }))
    } finally {
      setLoadingActions(false)
    }
  }, [])

  const handleToggleExpand = (device) => {
    setExpandedIds((prev) => {
      if (prev.includes(device.id)) {
        return prev.filter((id) => id !== device.id)
      }
      loadActions(device.id)
      return [...prev, device.id]
    })
  }

  // 组件挂载后：刷新页面会从 localStorage 恢复 expandedIds，但动作需重新拉取，
  // 否则已展开设备在刷新后动作列表为空（表现为“动作消失”）。
  useEffect(() => {
    expandedIds.forEach((id) => loadActions(id))
    // 仅挂载时执行一次（此时 expandedIds 已从 localStorage 恢复）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换分栏视图选中
  const handleSelectDevice = (device) => {
    setSelectedId(device.id)
    loadActions(device.id)
  }

  // 设备保存
  const handleDeviceSubmit = async (form) => {
    setDevSaving(true)
    try {
      if (devEditing) {
        await devicesApi.update(devEditing.id, form)
      } else {
        await devicesApi.create(form)
      }
      setDevFormOpen(false)
      setDevEditing(null)
      await loadDevices()
      toast.success(devEditing ? '设备已更新' : '设备已创建')
      return true
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
      return false
    } finally {
      setDevSaving(false)
    }
  }

  const handleDeviceDelete = async (device) => {
    const ok = await confirm({
      message: `确定删除设备「${device.name}」吗？将同时删除其下所有动作。`,
      variant: 'danger',
      confirmText: '确定删除',
    })
    if (!ok) return
    try {
      await devicesApi.remove(device.id)
      if (selectedId === device.id) {
        setSelectedId(null)
        setActionsMap((m) => {
          const c = { ...m }
          delete c[device.id]
          return c
        })
      }
      setExpandedIds((prev) => prev.filter((id) => id !== device.id))
      setCheckIds((prev) => prev.filter((id) => id !== device.id))
      await loadDevices()
      toast.success('设备已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  const handleBatchDelete = async () => {
    if (!checkIds.length) return
    const ids = [...checkIds]
    const count = ids.length
    const ok = await confirm({
      title: '批量删除设备',
      message: (
        <div className="space-y-2">
          <p>
            确定删除选中的{' '}
            <span className="font-semibold text-destructive">{count}</span> 台设备吗？
          </p>
          <p className="text-xs">
            删除后数据不可恢复，设备下的所有动作、接收渠道及调用日志将一并清除。
          </p>
        </div>
      ),
      variant: 'danger',
      confirmText: `删除 ${count} 台设备`,
    })
    if (!ok) return

    setBatchDeleting(true)
    try {
      const res = await devicesApi.batchRemove(ids)
      const deletedIds = Array.isArray(res?.deleted_ids) ? res.deleted_ids : ids
      const failed = Array.isArray(res?.failed) ? res.failed : []

      // 清理被删除设备的展开、分栏选中与动作缓存
      setExpandedIds((prev) => prev.filter((id) => !deletedIds.includes(id)))
      setActionsMap((m) => {
        const next = { ...m }
        deletedIds.forEach((id) => {
          delete next[id]
        })
        return next
      })
      setSelectedId((prev) => (deletedIds.includes(prev) ? null : prev))
      setCheckIds([])
      lastCheckIndexRef.current = null
      await loadDevices()

      if (failed.length) {
        toast.error(
          `成功删除 ${res?.deleted ?? 0} 台，${failed.length} 台失败：${failed
            .map((f) => `#${f.id} ${f.reason}`)
            .join('；')}`
        )
      } else {
        toast.success(`已删除 ${res?.deleted ?? count} 台设备`)
      }
    } catch (err) {
      toast.error(`批量删除失败：${err.message || err}`)
    } finally {
      setBatchDeleting(false)
    }
  }

  // 测试设备连接
  const handleTestDevice = async (device) => {
    setTestingDeviceId(device.id)
    try {
      const res = await devicesApi.test(device.id)
      setTestConnResult({ ...res, deviceName: device.name })
      setTestConnOpen(true)
      await loadDevices()
    } catch (err) {
      setTestConnResult({
        success: false,
        error: err.message || String(err),
        deviceName: device.name,
      })
      setTestConnOpen(true)
      await loadDevices()
    } finally {
      setTestingDeviceId(null)
    }
  }

  // 弹窗内测试设备连接（先保存或直接传表单测试）
  const handleTestInDialog = async (form) => {
    // 如果是编辑模式，直接测试；否则提示先保存
    if (devEditing) {
      const res = await devicesApi.test(devEditing.id)
      return res
    }
    throw new Error('请先保存设备后再测试')
  }

  // 健康检查
  const handleHealthCheck = async () => {
    setHealthChecking(true)
    try {
      const res = await devicesApi.healthCheck()
      toast.success(
        `健康检查完成：${res.healthy ?? res.online ?? 0} 在线 / ${res.abnormal ?? 0} 异常 / 共 ${res.checked ?? res.total ?? 0} 个`
      )
      await loadDevices()
    } catch (err) {
      toast.error(`健康检查失败：${err.message || err}`)
    } finally {
      setHealthChecking(false)
    }
  }

  // 动作保存
  const handleActionSubmit = async (form) => {
    if (!actDeviceId) return false
    setActSaving(true)
    try {
      if (actEditing) {
        await devicesApi.updateAction(actDeviceId, actEditing.id, form)
      } else {
        await devicesApi.createAction(actDeviceId, form)
      }
      setActFormOpen(false)
      setActEditing(null)
      await loadActions(actDeviceId)
      await loadDevices()
      toast.success(actEditing ? '动作已更新' : '动作已创建')
      return true
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
      return false
    } finally {
      setActSaving(false)
    }
  }

  const handleActionDelete = async (action, deviceId) => {
    const ok = await confirm({
      message: `确定删除动作「${action.name}」吗？`,
      variant: 'danger',
      confirmText: '确定删除',
    })
    if (!ok) return
    const did = deviceId || actDeviceId
    if (!did) {
      toast.error('未找到动作所属设备，请刷新页面后重试')
      return
    }
    try {
      await devicesApi.removeAction(did, action.id)
      await loadActions(did)
      await loadDevices()
      toast.success('动作已删除')
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 切换动作启用：deviceId 由调用方显式传入（分栏/卡片视图的动作列表不经过
  // actDeviceId，否则未打开过动作弹窗时 actDeviceId 为 null，会拼出
  // /devices/null/actions/{id}/toggle 导致「device_id：必须是整数」）
  const handleToggleAction = async (action, deviceId) => {
    const did = deviceId || actDeviceId
    if (!did) {
      toast.error('未找到动作所属设备，请刷新页面后重试')
      return
    }
    setTogglingActionId(action.id)
    try {
      await devicesApi.toggleAction(did, action.id)
      await loadActions(did)
      toast.success(`动作「${action.name}」已${action.enabled ? '禁用' : '启用'}`)
    } catch (err) {
      toast.error(`切换失败：${err.message || err}`)
    } finally {
      setTogglingActionId(null)
    }
  }

  // 动作测试
  const handleActionTest = async (params) => {
    if (!actDeviceId || !testAction) return
    setTestRunning(true)
    setTestResult(null)
    try {
      const res = await devicesApi.testAction(actDeviceId, testAction.id, params)
      setTestResult(res)
    } catch (err) {
      setTestResult({
        success: false,
        status_code: null,
        response_body: null,
        error: err.message || String(err),
      })
    } finally {
      setTestRunning(false)
    }
  }

  // 打开动作测试抽屉
  const openActionTestDrawer = (action, deviceId) => {
    // 必须同时记录所属设备，否则 handleActionTest 因 actDeviceId 为空而静默无响应
    setActDeviceId(deviceId || actDeviceId)
    setTestAction(action)
    setTestResult(null)
    setTestDrawerOpen(true)
  }

  // 动作历史：deviceId 由调用方显式传入（同 handleToggleAction，不依赖 actDeviceId）
  const openActionHistory = (action, deviceId) => {
    setHistoryAction(action)
    setHistoryDeviceId(deviceId || actDeviceId)
    setHistoryOpen(true)
  }

  // 新建动作
  const handleNewAction = (deviceId) => {
    const did = deviceId || selectedId || expandedIds[0]
    if (!did) {
      toast.warning('请先选择或展开一个设备')
      return
    }
    setActDeviceId(did)
    setActEditing(null)
    setActFormOpen(true)
  }

  // 编辑动作
  const handleEditAction = (action, deviceId) => {
    setActDeviceId(deviceId || actDeviceId || selectedId)
    setActEditing(action)
    setActFormOpen(true)
  }

  // ============ 模板相关 ============
  const loadTemplates = useCallback(async () => {
    try {
      const res = await devicesApi.templates()
      setTemplates(Array.isArray(res) ? res : res?.templates || [])
    } catch (err) {
      toast.error(`加载模板失败：${err.message || err}`)
    }
  }, [])

  const handleOpenTemplate = async () => {
    await loadTemplates()
    setTemplateOpen(true)
  }

  const handleSelectTemplate = (tpl) => {
    setSelectedTemplate(tpl)
    setTemplateOpen(false)
    setTemplateCreateOpen(true)
  }

  const handleTemplateCreate = async (form) => {
    setTemplateSaving(true)
    try {
      await devicesApi.fromTemplate({
        template_id: selectedTemplate.id,
        name: form.name,
        ip_address: form.ip_address,
        api_url: form.api_url,
        api_key: form.api_key,
        vendor: form.vendor,
      })
      setTemplateCreateOpen(false)
      setSelectedTemplate(null)
      await loadDevices()
      toast.success('设备已从模板创建')
    } catch (err) {
      toast.error(`创建失败：${err.message || err}`)
    } finally {
      setTemplateSaving(false)
    }
  }

  // ============ 导入导出 ============
  const handleExport = async (ids) => {
    try {
      const data = await devicesApi.export(ids)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `devices-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(`导出成功，共 ${data.total || data.devices?.length || 0} 台设备`)
      if (ids?.length) setCheckIds([]) // 导出所选后清空勾选
    } catch (err) {
      toast.error(`导出失败：${err.message || err}`)
    }
  }

  // 导出所选设备（未勾选时提示）
  const handleExportSelected = () => {
    if (!checkIds.length) {
      toast.warning('请先勾选要导出的设备（列表项前的复选框）')
      return
    }
    handleExport(checkIds)
  }

  // 全选 / 取消全选当前过滤列表
  const toggleCheckAll = () => {
    const allIds = filteredDevices.map((d) => d.id)
    const allChecked = allIds.length > 0 && allIds.every((id) => checkIds.includes(id))
    lastCheckIndexRef.current = null
    setCheckIds((prev) =>
      allChecked
        ? prev.filter((id) => !allIds.includes(id))
        : Array.from(new Set([...prev, ...allIds]))
    )
  }

  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // 清空以便重复导入同名文件
    try {
      const text = await file.text()
      const body = JSON.parse(text)
      await devicesApi.import(body)
      await loadDevices()
      toast.success('导入成功')
    } catch (err) {
      toast.error(`导入失败：${err.message || err}`)
    }
  }

  // ============ 筛选后的设备列表 ============
  const filteredDevices = useMemo(() => {
    let r = devices
    if (filters.search) {
      const q = filters.search.toLowerCase()
      r = r.filter((d) =>
        [d.name, d.vendor, d.type, d.description]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(q))
      )
    }
    if (filters.type) r = r.filter((d) => d.type === filters.type)
    if (filters.vendor) r = r.filter((d) => (d.vendor || '').toLowerCase() === filters.vendor.toLowerCase())
    if (filters.status) {
      r = r.filter((d) => (d.status || (d.enabled ? 'unconfigured' : 'disabled')) === filters.status)
    }
    if (filters.tag) {
      r = r.filter((d) => {
        const tags = parseTags(d.tags)
        return tags.includes(filters.tag)
      })
    }
    return r
  }, [devices, filters.search, filters.type, filters.vendor, filters.status, filters.tag])

  // 当前过滤列表是否全部选中（全选复选框联动 + 半选态）
  const allChecked =
    filteredDevices.length > 0 && filteredDevices.every((d) => checkIds.includes(d.id))
  const selectAllRef = useRef(null)
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = checkIds.length > 0 && !allChecked
    }
  }, [checkIds.length, allChecked])

  // 厂商选项
  const vendorOptions = useMemo(() => {
    const set = new Set()
    devices.forEach((d) => d.vendor && set.add(d.vendor))
    return [{ value: '', label: '全部厂商' }, ...Array.from(set).map((v) => ({ value: v, label: v }))]
  }, [devices])

  // 状态指标统计（指标条用：状态分布 + 动作/调用量汇总）
  const statusStats = useMemo(() => {
    const s = { online: 0, offline: 0, abnormal: 0, unconfigured: 0, disabled: 0 }
    let totalActions = 0
    let todayCalls = 0
    devices.forEach((d) => {
      const st = d.status || (d.enabled ? 'unconfigured' : 'disabled')
      if (s[st] != null) s[st] += 1
      totalActions += d.action_count || 0
      todayCalls += d.today_call_count || 0
    })
    return { ...s, total: devices.length, totalActions, todayCalls }
  }, [devices])

  // 指标条状态 chips 配置（dot/text 色与 STATUS_META 对齐）
  const statChips = useMemo(
    () => [
      { key: 'online', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
      { key: 'offline', dot: 'bg-destructive', active: 'bg-destructive/15 text-destructive ring-destructive/40' },
      { key: 'abnormal', dot: 'bg-warning', active: 'bg-warning/15 text-warning ring-warning/40' },
      { key: 'unconfigured', dot: 'bg-muted-foreground', active: 'bg-secondary text-foreground ring-border' },
      { key: 'disabled', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40' },
    ],
    []
  )

  // 标签选项
  const tagOptions = useMemo(() => {
    const set = new Set()
    devices.forEach((d) => parseTags(d.tags).forEach((t) => set.add(t)))
    return [{ value: '', label: '全部标签' }, ...Array.from(set).map((t) => ({ value: t, label: t }))]
  }, [devices])

  // 选中的设备（分栏视图）
  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === selectedId),
    [devices, selectedId]
  )

  // 视图模式切换按钮组
  const viewModeButtons = (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-secondary p-0.5">
      {VIEW_MODES.map((m) => {
        const Icon = m.icon
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => setViewMode(m.value)}
            className={`rounded p-1.5 transition ${
              viewMode === m.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title={m.label}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">设备对接</h1>
          {activeTab === 'devices' && !loading && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{filteredDevices.length}</span> 台设备
            </span>
          )}
        </div>
        {activeTab === 'devices' && (
          <div className="flex shrink-0 items-center gap-2">
            <TutorialButton onClick={() => setTutorialOpen(true)} />
            <button
              type="button"
              onClick={handleHealthCheck}
              disabled={healthChecking}
              className="btn-secondary btn-sm"
              title="对所有启用的设备执行健康检查"
            >
              <Activity className="mr-1 h-3.5 w-3.5" /> {healthChecking ? '检查中…' : '健康检查'}
            </button>
            <button type="button" onClick={loadDevices} className="btn-secondary btn-sm" title="刷新设备列表">
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </button>
            <button
              type="button"
              onClick={() => navigate('/devices/builtin-templates')}
              className="btn-secondary btn-sm"
              title="从内置设备库复用模板创建设备"
            >
              <Library className="mr-1 h-3.5 w-3.5" /> 内置设备库
            </button>
            <button
              type="button"
              onClick={handleOpenTemplate}
              className="btn-secondary btn-sm"
              title="从模板创建设备"
            >
              <Files className="mr-1 h-3.5 w-3.5" /> 从模板
            </button>
            {/* 数据操作下拉：全选 / 导入 / 导出（点击外部自动关闭） */}
            <div className="relative" ref={dataMenuRef}>
              <button
                type="button"
                onClick={() => setDataMenuOpen((v) => !v)}
                className={`btn-secondary btn-sm ${dataMenuOpen ? 'ring-1 ring-ring' : ''}`}
                title="数据导入 / 导出"
              >
                <Database className="mr-1 h-3.5 w-3.5" /> 数据
                <ChevronDown className={`ml-1 h-3 w-3 transition-transform ${dataMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {dataMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1.5 w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl shadow-black/20">
                    <button
                      type="button"
                      onClick={() => {
                        toggleCheckAll()
                        setDataMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      {checkIds.length ? `取消全选（已选 ${checkIds.length}）` : '全选当前列表'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleExportSelected()
                        setDataMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      导出所选{checkIds.length ? `（${checkIds.length} 台）` : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleExport()
                        setDataMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      导出全部设备
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      type="button"
                      onClick={() => {
                        importInputRef.current?.click()
                        setDataMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-accent"
                    >
                      <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                      导入 JSON
                    </button>
                  </div>
              )}
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => navigate('/device-onboard')}
              className="btn-primary btn-sm"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> 新建设备
            </button>
          </div>
        )}
      </header>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-6">
        <button
          type="button"
          onClick={() => setActiveTab('devices')}
          className={`-mb-px border-b-2 px-4 py-3 text-sm transition ${
            activeTab === 'devices'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          设备管理
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('logs')}
          className={`-mb-px border-b-2 px-4 py-3 text-sm transition ${
            activeTab === 'logs'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          调用日志
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'logs' ? (
          <div className="h-full overflow-y-auto p-6">
            <CallLogsTab />
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
            {/* 工具栏：筛选器 + 视图切换 */}
            <div className="border-b border-border bg-card px-6 py-3">
              <FilterBar
                search={{
                  value: filters.search,
                  onChange: (v) => setFilters({ search: v }),
                  placeholder: '搜索设备名称 / 厂商 / 类型...',
                }}
                filters={[
                  {
                    key: 'type',
                    label: '类型',
                    value: filters.type,
                    onChange: (v) => setFilters({ type: v }),
                    options: [
                      { value: '', label: '全部类型' },
                      ...DEVICE_TYPES.map((t) => ({ value: t.value, label: t.label })),
                    ],
                  },
                  {
                    key: 'vendor',
                    label: '厂商',
                    value: filters.vendor,
                    onChange: (v) => setFilters({ vendor: v }),
                    options: vendorOptions,
                  },
                  {
                    key: 'status',
                    label: '状态',
                    value: filters.status,
                    onChange: (v) => setFilters({ status: v }),
                    options: STATUS_OPTIONS,
                  },
                  {
                    key: 'tag',
                    label: '标签',
                    value: filters.tag,
                    onChange: (v) => setFilters({ tag: v }),
                    options: tagOptions,
                  },
                ]}
                actions={viewModeButtons}
              />
              {/* 状态指标条：状态分布（点击快速筛选）+ 汇总指标 */}
              {!loading && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {statChips.map((chip) => {
                    const active = filters.status === chip.key
                    const count = statusStats[chip.key] || 0
                    return (
                      <button
                        key={chip.key}
                        type="button"
                        onClick={() => setFilters({ status: active ? '' : chip.key })}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                          active
                            ? `border-transparent ring-1 ${chip.active}`
                            : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                        }`}
                        title={active ? '点击取消该状态筛选' : `点击筛选「${STATUS_META[chip.key].label}」设备`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                            chip.key === 'online' && count > 0 ? 'animate-pulse' : ''
                          }`}
                        />
                        {STATUS_META[chip.key].label}
                        <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                      </button>
                    )
                  })}
                  <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5" title="全部设备的动作总数">
                      <Zap className="h-3.5 w-3.5 text-primary/80" />
                      动作
                      <span
                        className={`font-semibold tabular-nums ${
                          statusStats.totalActions > 0 ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {fmtNum(statusStats.totalActions) ?? '--'}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1.5" title="全部设备今日 API 调用总次数">
                      <Activity className="h-3.5 w-3.5 text-primary/80" />
                      今日调用
                      <span
                        className={`font-semibold tabular-nums ${
                          statusStats.todayCalls > 0 ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {fmtNum(statusStats.todayCalls) ?? '--'}
                      </span>
                    </span>
                  </div>
                </div>
              )}
              {/* 批量选择栏：全选 + 已选数量 + 批量删除 */}
              {!loading && filteredDevices.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-primary"
                      checked={allChecked}
                      onChange={toggleCheckAll}
                      title="全选当前过滤列表"
                    />
                    全选
                  </label>
                  <span className="text-xs text-muted-foreground">
                    已选{' '}
                    <span
                      className={`font-semibold tabular-nums ${
                        checkIds.length ? 'text-primary' : 'text-foreground'
                      }`}
                    >
                      {checkIds.length}
                    </span>{' '}
                    项
                  </span>
                  {checkIds.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleBatchDelete}
                        disabled={batchDeleting}
                        className="btn-danger btn-sm"
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {batchDeleting ? '删除中…' : '批量删除'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCheckIds([])
                          lastCheckIndexRef.current = null
                        }}
                        disabled={batchDeleting}
                        className="btn-secondary btn-sm"
                      >
                        取消选择
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-hidden">
              {error && (
                <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              {loading ? (
                // 骨架屏加载（按当前视图模式匹配）
                viewMode === 'table' ? (
                  <div className="h-full overflow-y-auto p-6">
                    <DeviceTableSkeleton />
                  </div>
                ) : (
                  <div className="h-full overflow-y-auto p-6">
                    <div className="flex flex-col gap-3">
                      {[0, 1, 2].map((i) => (
                        <DeviceCardSkeleton key={i} />
                      ))}
                    </div>
                  </div>
                )
              ) : filteredDevices.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card">
                    <Shield className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <div className="text-sm">
                    {devices.length === 0 ? '暂无安全设备，接入第一台设备开始自动化编排' : '没有符合筛选条件的设备'}
                  </div>
                  {devices.length === 0 ? (
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigate('/device-onboard')}
                        className="btn-primary btn-sm"
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" /> 新建设备
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenTemplate}
                        className="btn-secondary btn-sm"
                      >
                        <FilePlus2 className="mr-1 h-3.5 w-3.5" /> 从模板创建
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFilters({ search: '', type: '', vendor: '', status: '', tag: '' })}
                      className="btn-secondary btn-sm mt-1"
                    >
                      清除筛选条件
                    </button>
                  )}
                </div>
              ) : viewMode === 'split' ? (
                // 分栏视图：左设备列表 + 右详情
                <div className="flex h-full">
                  <div className="w-80 shrink-0 overflow-y-auto border-r border-border bg-card">
                    {filteredDevices.map((dev) => (
                      <DeviceRow
                        key={dev.id}
                        device={dev}
                        selected={selectedId === dev.id}
                        onClick={() => handleSelectDevice(dev)}
                        onTest={handleTestDevice}
                        testing={testingDeviceId === dev.id}
                        checked={checkIds.includes(dev.id)}
                        onToggleCheck={toggleCheck}
                      />
                    ))}
                  </div>
                  <div className="flex-1 overflow-y-auto p-6">
                    {selectedDevice ? (
                      <div className="flex flex-col gap-4">
                        {/* 设备详情 */}
                        <div className="rounded-lg border border-border bg-card p-4">
                          <div className="mb-3 flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
                              <DeviceTypeIcon type={selectedDevice.type} className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-base font-semibold text-foreground">
                                  {selectedDevice.name}
                                </span>
                                <StatusBadge
                                  status={
                                    selectedDevice.status ||
                                    (selectedDevice.enabled ? 'unconfigured' : 'disabled')
                                  }
                                />
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                #{selectedDevice.id} · {DEVICE_TYPE_LABELS[selectedDevice.type]} ·{' '}
                                {selectedDevice.vendor || '未知厂商'}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleTestDevice(selectedDevice)}
                                disabled={testingDeviceId === selectedDevice.id}
                                className="btn-secondary btn-sm"
                              >
                                {testingDeviceId === selectedDevice.id ? (
                                  <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Wifi className="mr-1 h-3 w-3" />
                                )}
                                测试
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setDevEditing(selectedDevice)
                                  setDevFormOpen(true)
                                }}
                                className="btn-secondary btn-sm"
                              >
                                编辑
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-5">
                            <div>
                              <div className="text-muted-foreground">设备 IP</div>
                              <div
                                className="truncate text-foreground"
                                title={selectedDevice.ip_address}
                              >
                                {selectedDevice.ip_address || (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">API 地址</div>
                              <div
                                className="truncate text-foreground"
                                title={selectedDevice.api_url}
                              >
                                {selectedDevice.api_url || (
                                  <span className="text-destructive">未配置</span>
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">动作数</div>
                              <div className="mt-0.5">
                                <NumCell value={selectedDevice.action_count} title="未统计动作数" />
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">今日调用</div>
                              <div className="mt-0.5">
                                <NumCell value={selectedDevice.today_call_count} title="今日暂无调用" />
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">最后心跳</div>
                              <div
                                className="text-foreground"
                                title={fmtTime(selectedDevice.last_heartbeat)}
                              >
                                {fmtRelative(selectedDevice.last_heartbeat)}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* 动作列表 */}
                        <div className="rounded-lg border border-border bg-card p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              设备动作（{loadingActions ? '...' : (actionsMap[selectedDevice.id] || []).length} 个）
                            </h3>
                            <button
                              type="button"
                              onClick={() => handleNewAction(selectedDevice.id)}
                              className="btn-primary btn-sm"
                            >
                              <Plus className="mr-1 h-3 w-3" /> 新建动作
                            </button>
                          </div>
                          <ActionTable
                            actions={actionsMap[selectedDevice.id] || []}
                            loading={loadingActions}
                            onEdit={(a) => handleEditAction(a, selectedDevice.id)}
                            onDelete={(a) => handleActionDelete(a, selectedDevice.id)}
                            onTest={(a) => openActionTestDrawer(a, selectedDevice.id)}
                            onToggle={(a) => handleToggleAction(a, selectedDevice.id)}
                            onHistory={(a) => openActionHistory(a, selectedDevice.id)}
                            togglingActionId={togglingActionId}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Columns className="h-10 w-10" />
                        <div className="text-sm">请从左侧选择一个设备查看详情</div>
                      </div>
                    )}
                  </div>
                </div>
              ) : viewMode === 'table' ? (
                // 列表视图
                <div className="h-full overflow-y-auto p-6">
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="table-stagger w-full min-w-[1000px] table-fixed border-collapse text-sm">
                      <thead className="bg-card text-muted-foreground">
                        <tr>
                          <th className="w-12 px-4 py-3 text-left font-medium">
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer accent-primary"
                              checked={allChecked}
                              onChange={toggleCheckAll}
                              title="全选当前过滤列表"
                            />
                          </th>
                          <th className="w-16 px-4 py-3 text-left font-medium">ID</th>
                          <th className="w-48 px-4 py-3 text-left font-medium">设备名称</th>
                          <th className="w-24 px-4 py-3 text-left font-medium">类型</th>
                          <th className="w-32 px-4 py-3 text-left font-medium">厂商</th>
                          <th className="px-4 py-3 text-left font-medium">API 地址</th>
                          <th className="w-24 px-4 py-3 text-left font-medium">状态</th>
                          <th className="w-20 px-4 py-3 text-right font-medium">动作数</th>
                          <th className="w-20 px-4 py-3 text-right font-medium">今日调用</th>
                          <th className="w-32 px-4 py-3 text-left font-medium">最后心跳</th>
                          <th className="w-56 px-4 py-3 text-left font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDevices.map((dev, idx) => (
                          <tr
                            key={dev.id}
                            className={`table-row-hover border-t border-border hover:bg-accent ${
                              idx % 2 === 0 ? 'bg-card' : ''
                            }`}
                          >
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                className="h-4 w-4 cursor-pointer accent-primary"
                                checked={checkIds.includes(dev.id)}
                                onChange={(e) => toggleCheck(dev, e.shiftKey)}
                                onClick={(e) => e.stopPropagation()}
                                title="勾选以选择"
                              />
                            </td>
                            <td className="px-4 py-3 font-mono text-primary">#{dev.id}</td>
                            <td className="truncate px-4 py-3 text-foreground">{dev.name}</td>
                            <td className="truncate px-4 py-3 text-muted-foreground">
                              {DEVICE_TYPE_LABELS[dev.type] || dev.type}
                            </td>
                            <td className="truncate px-4 py-3 text-muted-foreground">
                              {dev.vendor || '-'}
                            </td>
                            <td
                              className="truncate px-4 py-3 font-mono text-xs text-muted-foreground"
                              title={dev.api_url}
                            >
                              {dev.api_url ? (
                                truncate(dev.api_url, 30)
                              ) : (
                                <span className="text-destructive">未配置</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <StatusBadge
                                status={dev.status || (dev.enabled ? 'unconfigured' : 'disabled')}
                              />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <NumCell value={dev.action_count} title="未统计动作数" />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <NumCell value={dev.today_call_count} title="今日暂无调用" />
                            </td>
                            <td
                              className="px-4 py-3 text-[11px] text-muted-foreground"
                              title={fmtTime(dev.last_heartbeat)}
                            >
                              {fmtRelative(dev.last_heartbeat)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1 whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleTestDevice(dev)}
                                  disabled={testingDeviceId === dev.id}
                                  className="btn-secondary btn-sm shrink-0"
                                >
                                  {testingDeviceId === dev.id ? '测试中' : '测试'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDevEditing(dev)
                                    setDevFormOpen(true)
                                  }}
                                  className="btn-secondary btn-sm shrink-0"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeviceDelete(dev)}
                                  className="btn-danger btn-sm shrink-0"
                                >
                                  删除
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                // 卡片视图（默认）
                <div className="h-full overflow-y-auto p-6">
                  <div className="card-stagger flex flex-col gap-3">
                    {filteredDevices.map((dev) => (
                      <DeviceCard
                        key={dev.id}
                        device={dev}
                        expanded={expandedIds.includes(dev.id)}
                        onToggleExpand={handleToggleExpand}
                        onEdit={(d) => {
                          setDevEditing(d)
                          setDevFormOpen(true)
                        }}
                        onDelete={handleDeviceDelete}
                        onTest={handleTestDevice}
                        testing={testingDeviceId === dev.id}
                        actions={expandedIds.includes(dev.id) ? actionsMap[dev.id] || [] : []}
                        loadingActions={loadingActions && expandedIds.includes(dev.id)}
                        onEditAction={(a) => {
                          setActDeviceId(dev.id)
                          handleEditAction(a, dev.id)
                        }}
                        onDeleteAction={(a) => handleActionDelete(a, dev.id)}
                        onTestAction={(a) => openActionTestDrawer(a, dev.id)}
                        onToggleAction={(a) => handleToggleAction(a, dev.id)}
                        onNewAction={() => handleNewAction(dev.id)}
                        onActionHistory={(a) => openActionHistory(a, dev.id)}
                        togglingActionId={togglingActionId}
                        checked={checkIds.includes(dev.id)}
                        onToggleCheck={toggleCheck}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 设备表单 */}
      <DeviceFormModal
        open={devFormOpen}
        initial={devEditing}
        onClose={() => {
          setDevFormOpen(false)
          setDevEditing(null)
        }}
        onSubmit={handleDeviceSubmit}
        saving={devSaving}
        onTest={handleTestInDialog}
      />

      {/* 动作表单 */}
      <ActionFormModal
        open={actFormOpen}
        initial={actEditing}
        onClose={() => {
          setActFormOpen(false)
          setActEditing(null)
        }}
        onSubmit={handleActionSubmit}
        saving={actSaving}
      />

      {/* 动作测试抽屉 */}
      <ActionTestDrawer
        open={testDrawerOpen}
        action={testAction}
        onClose={() => {
          setTestDrawerOpen(false)
          setTestAction(null)
          setTestResult(null)
        }}
        onRun={handleActionTest}
        running={testRunning}
        result={testResult}
      />

      {/* 动作历史 */}
      <ActionHistoryModal
        open={historyOpen}
        deviceId={historyDeviceId}
        actionId={historyAction?.id}
        actionName={historyAction?.name}
        onClose={() => {
          setHistoryOpen(false)
          setHistoryAction(null)
        }}
      />

      {/* 设备连接测试结果 */}
      <Modal
        open={testConnOpen}
        title={`连接测试${testConnResult?.deviceName ? `：${testConnResult.deviceName}` : ''}`}
        onClose={() => setTestConnOpen(false)}
        maxWidth="max-w-lg"
        footer={
          <button type="button" onClick={() => setTestConnOpen(false)} className="btn-primary">
            关闭
          </button>
        }
      >
        {testConnResult ? (
          <div className="flex flex-col gap-3">
            <div
              className={`flex items-center gap-2 rounded-md border px-4 py-3 ${
                testConnResult.success
                  ? 'border-success/40 bg-success/10'
                  : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              {testConnResult.success ? (
                <Wifi className="h-4 w-4 text-success" />
              ) : (
                <WifiOff className="h-4 w-4 text-destructive" />
              )}
              <span
                className={`text-sm font-medium ${
                  testConnResult.success ? 'text-success' : 'text-destructive'
                }`}
              >
                {testConnResult.success
                  ? `连接成功 · 延迟 ${testConnResult.latency_ms ?? testConnResult.latency ?? '-'}ms`
                  : '连接失败'}
              </span>
            </div>
            {testConnResult.error && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">错误信息</div>
                <pre className="overflow-auto rounded-md bg-background p-3 font-mono text-xs text-destructive ring-1 ring-border">
                  {testConnResult.error}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">测试中...</div>
        )}
      </Modal>

      {/* 模板选择 */}
      <TemplateModal
        open={templateOpen}
        templates={templates}
        onClose={() => setTemplateOpen(false)}
        onSelect={handleSelectTemplate}
      />

      {/* 从模板创建 */}
      <TemplateCreateModal
        open={templateCreateOpen}
        template={selectedTemplate}
        onClose={() => {
          setTemplateCreateOpen(false)
          setSelectedTemplate(null)
        }}
        onSubmit={handleTemplateCreate}
        saving={templateSaving}
      />

      {/* 使用教程 */}
      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="设备对接使用教程"
        subtitle="了解如何添加设备和配置操作"
        sections={DEVICE_TUTORIAL}
      />
    </div>
  )
}

export default DeviceManagement
