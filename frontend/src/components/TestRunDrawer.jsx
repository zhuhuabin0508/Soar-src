// 试运行抽屉：点击「试运行」后从右侧滑入
// 功能：输入测试 payload、一键运行 / 逐步执行、节点级执行卡片、中止运行
// 与 workflowStore 联动：runStatus / nodeRunStatus / runLogs / runTraces
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Play, StepForward, Square, ChevronRight, Loader2,
  CheckCircle2, XCircle, Circle, AlertTriangle,
} from 'lucide-react'
import { Drawer } from './Dialog'
import { textareaCls } from './property/FormControls'
import { useWorkflowStore } from '../store/workflowStore'
import { workflows as workflowsApi } from '../api/client'
import { toast } from '../store/toastStore'
import { AutoGrowTextarea } from './ui'

// 计算单节点轨迹耗时（秒）
function traceDuration(tr) {
  if (!tr || !tr.started_at || !tr.finished_at) return 0
  const s = new Date(tr.started_at).getTime()
  const e = new Date(tr.finished_at).getTime()
  if (Number.isNaN(s) || Number.isNaN(e)) return 0
  return Math.max(0, (e - s) / 1000)
}

// 节点状态徽章
function NodeStatusBadge({ status }) {
  const st = (status || 'idle').toLowerCase()
  const map = {
    running: { cls: 'bg-primary/20 text-primary', icon: Loader2, spin: true, text: '运行中' },
    success: { cls: 'bg-success/20 text-success', icon: CheckCircle2, spin: false, text: '成功' },
    failed: { cls: 'bg-destructive/20 text-destructive', icon: XCircle, spin: false, text: '失败' },
    error: { cls: 'bg-destructive/20 text-destructive', icon: XCircle, spin: false, text: '失败' },
    skipped: { cls: 'bg-secondary text-muted-foreground', icon: Circle, spin: false, text: '已跳过' },
    idle: { cls: 'bg-secondary text-muted-foreground', icon: Circle, spin: false, text: '待执行' },
  }
  const cfg = map[st] || map.idle
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.cls}`}>
      <Icon className={`h-3 w-3 ${cfg.spin ? 'animate-spin' : ''}`} />
      {cfg.text}
    </span>
  )
}

// 可折叠 JSON 区块
function CollapsibleJson({ label, data, accent = 'text-muted-foreground' }) {
  const [open, setOpen] = useState(false)
  const text = (() => {
    if (data == null) return ''
    if (typeof data === 'string') return data
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  })()
  return (
    <div className="rounded border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={accent}>{label}</span>
      </button>
      {open && (
        <pre className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {text || '—'}
        </pre>
      )}
    </div>
  )
}

// 节点执行卡片
function NodeCard({ card }) {
  const isFailed = ['failed', 'error'].includes((card.status || '').toLowerCase())
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={`rounded-md border bg-card p-2.5 transition ${
        isFailed ? 'border-danger-700/60' : 'border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <NodeStatusBadge status={card.status} />
          <span className="truncate text-xs font-medium text-foreground">
            {card.label}
          </span>
          {card.type && (
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {card.type}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {card.duration != null && (
            <span className="text-[10px] text-muted-foreground">
              {card.duration.toFixed(2)}s
            </span>
          )}
          {isFailed && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-destructive hover:underline"
            >
              {expanded ? '收起' : '详情'}
            </button>
          )}
        </div>
      </div>

      {/* 输入 / 输出（折叠） */}
      {(card.input != null || card.output != null) && (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {card.input != null && <CollapsibleJson label="输入" data={card.input} />}
          {card.output != null && <CollapsibleJson label="输出" data={card.output} />}
        </div>
      )}

      {/* 失败节点错误堆栈（展开） */}
      {isFailed && expanded && (
        <div className="mt-2 rounded border border-danger-700/40 bg-danger-900/20 p-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            错误详情
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-destructive">
            {card.error || card.output || '无错误信息'}
          </pre>
        </div>
      )}
    </div>
  )
}

function TestRunDrawer({ open, onClose }) {
  const workflowId = useWorkflowStore((s) => s.workflowId)
  const nodes = useWorkflowStore((s) => s.nodes)
  const serialize = useWorkflowStore((s) => s.serialize)
  const runStatus = useWorkflowStore((s) => s.runStatus)
  const setRunStatus = useWorkflowStore((s) => s.setRunStatus)
  const setRunLogs = useWorkflowStore((s) => s.setRunLogs)
  const setRunTraces = useWorkflowStore((s) => s.setRunTraces)
  const clearRunLogs = useWorkflowStore((s) => s.clearRunLogs)
  const setNodeRunStatus = useWorkflowStore((s) => s.setNodeRunStatus)
  const setAllNodeRunStatus = useWorkflowStore((s) => s.setAllNodeRunStatus)
  const clearNodeRunStatus = useWorkflowStore((s) => s.clearNodeRunStatus)
  const runLogs = useWorkflowStore((s) => s.runLogs)

  // 测试输入数据（模拟触发器入参 payload）
  const [payload, setPayload] = useState('{}')
  // 运行模式：'step' 逐步 | 'all' 一键 | null 空闲
  const [mode, setMode] = useState(null)
  // 节点执行卡片状态
  const [cards, setCards] = useState([])
  const [error, setError] = useState('')
  // 中止标志 + 逐步动画定时器
  const abortRef = useRef({ aborted: false })
  const stepTimerRef = useRef(null)

  const running = mode !== null

  // 打开时重置本地状态
  useEffect(() => {
    if (open) {
      setMode(null)
      setCards([])
      setError('')
      abortRef.current = { aborted: false }
    }
  }, [open])

  // 卸载/关闭时清理定时器
  useEffect(() => {
    return () => {
      if (stepTimerRef.current) clearTimeout(stepTimerRef.current)
    }
  }, [])

  // 校验工作流图配置
  const validate = useCallback(async () => {
    const res = await workflowsApi.validate(serialize())
    return {
      valid: !!res?.valid,
      errors: Array.isArray(res?.errors) ? res.errors : [],
      warnings: Array.isArray(res?.warnings) ? res.warnings : [],
    }
  }, [serialize])

  // 解析 payload 文本为对象
  const buildPayload = useCallback(() => {
    const text = payload.trim()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(`输入数据 JSON 解析失败：${err.message}`)
    }
  }, [payload])

  // 初始化节点卡片（全部待执行）
  const initCards = useCallback(() => {
    return nodes.map((n) => ({
      nodeId: n.id,
      label: n.data?.label || n.type || n.id,
      type: n.type,
      status: 'idle',
      input: null,
      output: null,
      duration: null,
      error: null,
    }))
  }, [nodes])

  // 将后端返回的 traces 应用到卡片状态 + 画布高亮
  const applyTraces = useCallback(
    (traces) => {
      const statusMap = {}
      traces.forEach((tr) => {
        const st = (tr.status || 'idle').toLowerCase()
        statusMap[tr.node_id] = st === 'error' ? 'failed' : st
      })
      setAllNodeRunStatus(statusMap)
      setCards((prev) =>
        prev.map((card) => {
          const tr = traces.find((t) => t.node_id === card.nodeId)
          if (!tr) return card
          const st = (tr.status || 'idle').toLowerCase()
          return {
            ...card,
            status: st === 'error' ? 'failed' : st,
            input: tr.input,
            output: tr.output,
            duration: traceDuration(tr),
            error: tr.error || (tr.output && typeof tr.output === 'object' ? tr.output.error : ''),
          }
        })
      )
    },
    [setAllNodeRunStatus]
  )

  // 一键运行：校验 → 调 testRun → 一次性应用全部结果
  const handleRunAll = useCallback(async () => {
    if (!workflowId) {
      toast.warning('请先保存工作流后再试运行')
      return
    }
    let inputData
    try {
      inputData = buildPayload()
    } catch (e) {
      toast.error(e.message)
      return
    }
    try {
      const v = await validate()
      if (v.errors.length > 0) {
        toast.error('工作流校验未通过：\n\n' + v.errors.join('\n'))
        return
      }
    } catch (e) {
      toast.error(`校验请求失败：${e.message || e}`)
      return
    }

    abortRef.current = { aborted: false }
    setMode('all')
    setRunStatus('running')
    clearNodeRunStatus()
    clearRunLogs()
    setRunTraces([])
    setError('')
    setCards(initCards())

    try {
      const res = await workflowsApi.testRun(workflowId, inputData)
      if (abortRef.current.aborted) return
      applyTraces(res?.traces || [])
      setRunLogs(res?.logs || [])
      setRunTraces(res?.traces || [])
      const finalStatus = res?.status === 'failed' ? 'failed' : 'success'
      setRunStatus(finalStatus)
      if (finalStatus === 'failed') {
        setError('执行失败，请查看失败节点详情')
        toast.error('试运行失败')
      } else {
        toast.success('试运行完成')
      }
    } catch (err) {
      if (abortRef.current.aborted) return
      setRunStatus('failed')
      setError(err.message || '试运行失败')
      setRunLogs([
        {
          level: 'error',
          node_id: '-',
          message: `试运行请求失败：${err.message || err}`,
          timestamp: new Date().toISOString(),
        },
      ])
      toast.error(`试运行失败：${err.message || err}`)
    } finally {
      if (!abortRef.current.aborted) setMode(null)
    }
  }, [workflowId, buildPayload, validate, setRunStatus, clearNodeRunStatus, clearRunLogs, setRunTraces, setRunLogs, initCards, applyTraces])

  // 逐步执行：先调 testRun 取全部 traces，再按顺序逐个高亮节点
  const handleStepRun = useCallback(async () => {
    if (!workflowId) {
      toast.warning('请先保存工作流后再试运行')
      return
    }
    let inputData
    try {
      inputData = buildPayload()
    } catch (e) {
      toast.error(e.message)
      return
    }
    try {
      const v = await validate()
      if (v.errors.length > 0) {
        toast.error('工作流校验未通过：\n\n' + v.errors.join('\n'))
        return
      }
    } catch (e) {
      toast.error(`校验请求失败：${e.message || e}`)
      return
    }

    abortRef.current = { aborted: false }
    setMode('step')
    setRunStatus('running')
    clearNodeRunStatus()
    clearRunLogs()
    setRunTraces([])
    setError('')
    setCards(initCards())

    let traces = []
    let logs = []
    let finalStatus = 'success'
    try {
      const res = await workflowsApi.testRun(workflowId, inputData)
      if (abortRef.current.aborted) return
      traces = Array.isArray(res?.traces) ? res.traces : []
      logs = Array.isArray(res?.logs) ? res.logs : []
      finalStatus = res?.status === 'failed' ? 'failed' : 'success'
    } catch (err) {
      if (abortRef.current.aborted) return
      setRunStatus('failed')
      setError(err.message || '试运行失败')
      setRunLogs([
        {
          level: 'error',
          node_id: '-',
          message: `试运行请求失败：${err.message || err}`,
          timestamp: new Date().toISOString(),
        },
      ])
      setMode(null)
      toast.error(`试运行失败：${err.message || err}`)
      return
    }

    // 逐步动画：按 traces 顺序逐个高亮
    let i = 0
    const stepDelay = 600
    const stepOnce = () => {
      if (abortRef.current.aborted) return
      if (i >= traces.length) {
        // 全部完成，写入最终结果
        setRunLogs(logs)
        setRunTraces(traces)
        setRunStatus(finalStatus)
        if (finalStatus === 'failed') {
          setError('执行失败，请查看失败节点详情')
          toast.error('试运行失败')
        } else {
          toast.success('试运行完成')
        }
        setMode(null)
        return
      }
      const tr = traces[i]
      // 先标记为运行中
      setNodeRunStatus(tr.node_id, 'running')
      setCards((prev) =>
        prev.map((c) => (c.nodeId === tr.node_id ? { ...c, status: 'running' } : c))
      )
      // 实时追加该节点日志
      const nodeLogs = logs.filter((l) => l.node_id === tr.node_id)
      if (nodeLogs.length) {
        useWorkflowStore.getState().appendRunLogs(nodeLogs)
      }
      stepTimerRef.current = setTimeout(() => {
        if (abortRef.current.aborted) return
        const st = (tr.status || 'idle').toLowerCase()
        const norm = st === 'error' ? 'failed' : st
        setNodeRunStatus(tr.node_id, norm)
        setCards((prev) =>
          prev.map((c) =>
            c.nodeId === tr.node_id
              ? {
                  ...c,
                  status: norm,
                  input: tr.input,
                  output: tr.output,
                  duration: traceDuration(tr),
                  error: tr.error || (tr.output && typeof tr.output === 'object' ? tr.output.error : ''),
                }
              : c
          )
        )
        i += 1
        stepTimerRef.current = setTimeout(stepOnce, stepDelay / 2)
      }, stepDelay)
    }
    stepOnce()
  }, [workflowId, buildPayload, validate, setRunStatus, clearNodeRunStatus, clearRunLogs, setRunTraces, setRunLogs, initCards, setNodeRunStatus])

  // 中止运行：停止逐步动画，标记未完成节点为跳过
  const handleAbort = useCallback(() => {
    abortRef.current.aborted = true
    if (stepTimerRef.current) {
      clearTimeout(stepTimerRef.current)
      stepTimerRef.current = null
    }
    setMode(null)
    setRunStatus('failed')
    setCards((prev) =>
      prev.map((c) =>
        c.status === 'running' || c.status === 'idle'
          ? { ...c, status: 'skipped' }
          : c
      )
    )
    // 画布上运行中节点标记为跳过
    const cur = useWorkflowStore.getState().nodeRunStatus
    const next = {}
    Object.entries(cur).forEach(([id, st]) => {
      next[id] = st === 'running' ? 'skipped' : st
    })
    setAllNodeRunStatus(next)
    toast.info('已中止运行')
  }, [setRunStatus, setAllNodeRunStatus])

  // 实时日志区域：运行中显示追加的日志
  const liveLogs = runLogs

  // 底部操作按钮组
  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      {/* 左侧：状态提示 */}
      <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {mode === 'step' ? '逐步执行中…' : '运行中…'}
          </span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span>共 {cards.length} 个节点</span>
        )}
      </div>
      {/* 右侧：按钮组 */}
      <div className="flex shrink-0 items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={handleAbort}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger-700 bg-danger-900/30 px-3 py-1.5 text-sm text-destructive transition hover:bg-danger-900/60"
          >
            <Square className="h-3.5 w-3.5" />
            中止
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleStepRun}
              disabled={!workflowId}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <StepForward className="h-3.5 w-3.5" />
              逐步执行
            </button>
            <button
              type="button"
              onClick={handleRunAll}
              disabled={!workflowId}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary/30 px-3 py-1.5 text-sm text-primary transition hover:bg-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              一键运行
            </button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <Drawer
      open={open}
      title="试运行"
      onClose={onClose}
      width="w-[520px]"
      footer={footer}
    >
      {/* 输入区：测试数据 textarea */}
      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          测试数据（模拟触发器入参 payload，JSON）
        </label>
        <AutoGrowTextarea
          className={textareaCls}
          rows={5}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
          placeholder="{}"
          disabled={running}
        />
        {!workflowId && (
          <p className="mt-1 text-[11px] text-warning">
            请先保存工作流后再试运行
          </p>
        )}
      </div>

      {/* 实时日志（运行中显示） */}
      {liveLogs.length > 0 && (
        <div className="mb-3 rounded-md border border-border bg-background p-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            实时日志（{liveLogs.length}）
          </div>
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {liveLogs.map((log, idx) => (
              <div key={idx} className="flex items-start gap-1.5 font-mono text-[10px]">
                <span
                  className={`shrink-0 rounded px-1 py-0.5 ${
                    (log.level || '').toLowerCase() === 'error'
                      ? 'bg-destructive/20 text-destructive'
                      : (log.level || '').toLowerCase() === 'warn' || (log.level || '').toLowerCase() === 'warning'
                      ? 'bg-warning/20 text-warning'
                      : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {(log.level || 'info').toUpperCase()}
                </span>
                {log.node_id && log.node_id !== '-' && (
                  <span className="shrink-0 text-primary">[{log.node_id}]</span>
                )}
                <span className="min-w-0 flex-1 break-words text-muted-foreground">
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 执行过程：节点卡片列表 */}
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          执行过程
        </div>
        {cards.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-8 text-center text-[11px] text-muted-foreground">
            点击「一键运行」或「逐步执行」开始试运行
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map((card) => (
              <NodeCard key={card.nodeId} card={card} />
            ))}
          </div>
        )}
      </div>
    </Drawer>
  )
}

export default TestRunDrawer
