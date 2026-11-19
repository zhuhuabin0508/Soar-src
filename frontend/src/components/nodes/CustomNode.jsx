import { memo, useState } from 'react'
import { Handle, Position, NodeToolbar } from 'reactflow'
import {
  Wrench, Pencil, Copy, Loader2, Play, X,
  Webhook, Shuffle, Globe, Bot, MessageSquare, Ban, Shield, Megaphone,
  User, Code2, Repeat, RefreshCw, CircleStop,
  Clock, Radio, Hand, Hourglass, GitMerge, Box, ScanSearch, Braces,
  Variable, StickyNote, SquareStack, FileText, AlertTriangle,
} from 'lucide-react'
import { getNodeDefinition } from '../../constants/nodeCatalog'
import { useWorkflowStore } from '../../store/workflowStore'
import { workflows as workflowsApi } from '../../api/client'
import { Modal } from '../Dialog'

// 节点图标名 → lucide 组件映射（nodeCatalog.icon 存的是组件名字符串）
const ICON_MAP = {
  Webhook, Shuffle, Globe, Bot, MessageSquare, Ban, Shield, Megaphone,
  Wrench, User, Code2, Repeat, RefreshCw, CircleStop,
  Clock, Radio, Hand, Hourglass, GitMerge, Box, ScanSearch, Braces,
  Variable, StickyNote, SquareStack, FileText,
}

// 根据 icon 字段渲染 lucide 图标，未命中时回退到 Wrench
function renderNodeIcon(iconName, className = 'h-4 w-4') {
  const Icon = ICON_MAP[iconName] || Wrench
  return <Icon className={className} />
}

// 根据节点类型与 data 生成简要摘要
function getSummary(type, data) {
  switch (type) {
    case 'webhook_trigger':
      return `${data?.method || 'POST'} · ${data?.content_type || 'application/json'}`
    case 'schedule_trigger':
      return `${data?.cron || '未配置 Cron'} · ${data?.timezone || 'Asia/Shanghai'}`
    case 'event_trigger':
      return `${data?.event_source || 'alert'} · ${data?.event_type || '*'}`
    case 'manual_trigger':
      return `${data?.entry_form?.length || 0} 个表单字段`
    case 'condition_branch': {
      if (data?.mode === 'switch') {
        return `SWITCH · ${data?.cases?.length || 0} 个分支`
      }
      const n = data?.conditions?.length || 0
      return `IF · ${n} 个条件 (${data?.logic || 'AND'})`
    }
    case 'loop':
      return data?.loop_mode === 'while'
        ? `WHILE · ${data?.loop_condition || '未配置条件'}`
        : `COUNT · ${data?.count || 1} 次`
    case 'iteration':
      return `遍历 · ${data?.data_source || 'input'} 源`
    case 'wait':
      return data?.wait_mode === 'until'
        ? `等待至 ${data?.until_time || '未配置'}`
        : `等待 ${data?.duration || 60} 秒`
    case 'parallel':
      return `${data?.branches || 2} 个分支${data?.wait_all ? '（等待全部）' : '（任一完成）'}`
    case 'sub_workflow':
      return `子流程 #${data?.sub_workflow_id || '未选择'}`
    case 'http_request':
      return `${data?.method || 'GET'}  ${data?.url ? data.url : '未配置 URL'}`
    case 'ai_agent':
      return `${data?.agent_id ? '智能体 #' + data.agent_id : '未配置智能体'} · 工具 ${data?.enabled_tools?.length || 0}`
    case 'llm':
      return `${data?.model || '未配置模型'} · temp ${data?.temperature ?? 0.7}`
    case 'intent_recognition':
      return `${data?.intents?.length || 0} 个意图 · 兜底 ${data?.fallback_intent || 'unknown'}`
    case 'json_parse':
      return `解析 · ${data?.extract_fields?.length || 0} 个字段`
    case 'variable_assign':
      return `${data?.assignments?.length || 0} 个赋值`
    case 'block_ip':
      return `${data?.action === 'unblock' ? '解封' : '封禁'} ${data?.target_ip || '{{src_ip}}'} · ${data?.duration_value || 24}${data?.duration_unit || '小时'}`
    case 'device_action':
      return `设备 #${data?.device_id || '?'} · 动作 #${data?.action_id || '?'}`
    case 'send_notification':
      return `${data?.channel || 'email'} · ${data?.severity || 'warning'}`
    case 'tool':
      return `工具: ${data?.tool_name || '未选择'}`
    case 'human_review':
      return `${data?.title || '人工审批工单'}`
    case 'ticket_create':
      return `${data?.priority || 'normal'} · ${data?.title || '未命名工单'}`
    case 'code_execute':
      return `${data?.language || 'python'} · ${data?.code ? data.code.split('\n')[0].slice(0, 40) : '未配置代码'}`
    case 'annotation':
      return ''
    case 'group':
      return ''
    case 'end':
      return `结束 · ${data?.end_type || 'success'}`
    default:
      return ''
  }
}

// 检查节点是否缺少必填配置：返回 true 表示「未配置」需要显示警告角标
function isRequiredMissing(type, data) {
  const d = data || {}
  switch (type) {
    case 'http_request':
      return !d.url
    case 'ai_agent':
      return !d.agent_id
    case 'llm':
      return !d.model && !d.model_config_id
    case 'tool':
      return !d.tool_name
    case 'device_action':
      return !d.device_id || !d.action_id
    case 'sub_workflow':
      return !d.sub_workflow_id
    case 'webhook_trigger':
      return !d.method
    case 'send_notification':
      return !d.recipients && !d.webhook_url
    case 'code_execute':
      return !d.code
    case 'ticket_create':
      return !d.title
    case 'human_review':
      return !(d.approvers && d.approvers.length)
    case 'intent_recognition':
      return !(d.intents && d.intents.length)
    case 'json_parse':
      return !d.source
    default:
      return false
  }
}

// 条件分支的多出口 handle；end 节点无出口 handle
function BranchHandles({ type, data }) {
  // end 节点不渲染出口，标识流程终止
  if (type === 'end') {
    return null
  }
  if (type !== 'condition_branch') {
    return (
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: '#06b6d4', width: 10, height: 10 }}
      />
    )
  }

  // 收集出口列表：[{ id, label }]
  // id 用稳定索引（br_0, br_1...），避免 label 重复或变更导致 Handle ID 冲突
  let outputs = []
  if (data?.mode === 'switch') {
    outputs = (data?.cases || []).map((c, i) => ({ id: `br_${i}`, label: c.label || `分支${i + 1}` }))
    outputs.push({ id: 'default', label: '默认' })
  } else {
    outputs = [
      { id: 'true', label: data?.true_label || '是' },
      { id: 'false', label: data?.false_label || '否' },
    ]
  }

  // 多个 handle 垂直排列在右侧；自适应间距确保不溢出节点边界
  const n = outputs.length
  const maxGap = n > 4 ? Math.min(22, 80 / (n - 1)) : 26
  const start = 50 - ((n - 1) * maxGap) / 2
  return (
    <>
      {outputs.map((o, i) => (
        <div
          key={o.id}
          className="absolute right-0 flex items-center"
          style={{ top: `${start + i * maxGap}%`, transform: 'translateY(-50%)', zIndex: 20 }}
        >
          <span className="mr-1 rounded bg-card px-1 text-xs text-foreground">
            {o.label}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={o.id}
            style={{ background: '#06b6d4', width: 10, height: 10 }}
          />
        </div>
      ))}
    </>
  )
}

// 节点 hover 工具栏按钮样式
const toolbarBtnCls =
  'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition whitespace-nowrap'

// 未配置警告角标
function ConfigWarningBadge() {
  return (
    <div
      className="absolute -right-1.5 -top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md ring-2 ring-card"
      title="该节点缺少必填配置，请在右侧属性面板补全"
    >
      <AlertTriangle className="h-3 w-3" />
    </div>
  )
}

function CustomNode({ id, type, data, selected }) {
  const def = getNodeDefinition(type)
  // 从 store 获取节点操作 actions（函数引用稳定，不会导致额外重渲染）
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode)
  const removeNode = useWorkflowStore((s) => s.removeNode)
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode)
  // 节点级运行状态：idle / running / success / failed / skipped
  const runStatus = useWorkflowStore((s) => s.nodeRunStatus[id]) || 'idle'

  // 单节点运行状态
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [resultOpen, setResultOpen] = useState(false)

  if (!def) return null

  const accent = def.color
  const missingRequired = isRequiredMissing(type, data)

  // 根据运行状态计算边框颜色：运行中(青色脉冲) / 成功(绿色) / 失败(红色)，优先级高于选中态
  let borderColor
  let boxShadow
  if (runStatus === 'running') {
    borderColor = 'oklch(var(--info))'
    boxShadow = `0 0 0 2px oklch(var(--info) / 0.4)`
  } else if (runStatus === 'success') {
    borderColor = 'oklch(var(--success))'
    boxShadow = `0 0 0 2px oklch(var(--success) / 0.35)`
  } else if (runStatus === 'failed') {
    borderColor = 'oklch(var(--destructive))'
    boxShadow = `0 0 0 2px oklch(var(--destructive) / 0.35)`
  } else if (selected) {
    borderColor = accent
    boxShadow = `0 0 0 2px ${accent}40`
  } else {
    borderColor = '#374151'
    boxShadow = '0 4px 12px rgba(0,0,0,0.4)'
  }

  // 运行此步骤：调用后端 POST /test-node
  const handleRunNode = async () => {
    setRunning(true)
    setRunResult(null)
    try {
      const res = await workflowsApi.testNode(
        { id, type, data },
        data?.test_input || {}
      )
      setRunResult(res)
      setResultOpen(true)
    } catch (err) {
      setRunResult({
        output: { error: err.message || String(err) },
        logs: [{ node_id: id, level: 'error', message: err.message || String(err) }],
      })
      setResultOpen(true)
    } finally {
      setRunning(false)
    }
  }

  // ============ 注释便签：黄色便签风格，无连接点 ============
  if (type === 'annotation') {
    const noteColor = data?.color || accent
    return (
      <div
        className="relative rounded-md shadow-lg"
        style={{
          minWidth: 180,
          maxWidth: 280,
          background: noteColor,
          borderColor: selected ? 'oklch(var(--ring))' : 'transparent',
          borderWidth: 2,
          borderStyle: 'solid',
          color: '#1f2937',
        }}
      >
        {missingRequired && <ConfigWarningBadge />}
        <div className="px-3 py-2.5">
          {data?.label && (
            <div className="mb-1 text-sm font-semibold leading-tight">
              {data.label}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
            {data?.content || '在此输入注释内容…'}
          </div>
        </div>
      </div>
    )
  }

  // ============ 分组容器：半透明背景，可承载其它节点 ============
  if (type === 'group') {
    const groupColor = data?.group_color || accent
    return (
      <div
        className="relative rounded-lg"
        style={{
          minWidth: 320,
          minHeight: 200,
          width: 360,
          height: 240,
          background: `${groupColor}18`,
          border: `2px dashed ${selected ? 'oklch(var(--ring))' : groupColor}`,
          boxShadow: selected ? `0 0 0 2px ${groupColor}40` : 'none',
        }}
      >
        {missingRequired && <ConfigWarningBadge />}
        {/* 分组标题栏 */}
        <div
          className="flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-semibold"
          style={{ background: `${groupColor}33`, color: 'oklch(var(--foreground))' }}
        >
          {renderNodeIcon(def.icon, 'h-3.5 w-3.5')}
          <span className="truncate">{data?.group_title || '阶段分组'}</span>
        </div>
      </div>
    )
  }

  const summary = getSummary(type, data)

  return (
    <>
      {/* hover 工具栏：鼠标移入节点时显示 */}
      <NodeToolbar position={Position.Top} offset={8}>
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-1 shadow-xl backdrop-blur">
          <button
            type="button"
            onClick={handleRunNode}
            disabled={running}
            title="运行此步骤（单节点测试）"
            className={`${toolbarBtnCls} text-success-300 hover:bg-success-900/40 disabled:opacity-50`}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} 运行
          </button>
          <button
            type="button"
            onClick={() => setSelectedNode(id)}
            title="更改节点（打开属性面板）"
            className={`${toolbarBtnCls} text-primary hover:bg-primary/40`}
          >
            <Pencil className="h-3 w-3" /> 更改
          </button>
          <button
            type="button"
            onClick={() => duplicateNode(id)}
            title="复制节点"
            className={`${toolbarBtnCls} text-primary hover:bg-primary/40`}
          >
            <Copy className="h-3 w-3" /> 复制
          </button>
          <button
            type="button"
            onClick={() => removeNode(id)}
            title="删除节点"
            className={`${toolbarBtnCls} text-destructive hover:bg-danger-900/40`}
          >
            <X className="h-3 w-3" /> 删除
          </button>
        </div>
      </NodeToolbar>

      <div
        className="relative rounded-lg bg-secondary text-foreground shadow-lg w-full"
        style={{
          minWidth: 220,
          maxWidth: 280,
          borderWidth: 2,
          borderStyle: 'solid',
          borderColor,
          boxShadow,
        }}
      >
        {/* 未配置警告角标 */}
        {missingRequired && <ConfigWarningBadge />}

        {/* 左侧入口连接点 */}
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: accent, width: 10, height: 10 }}
        />

        {/* 顶部彩条（类型标识色） */}
        <div
          className="h-1 w-full rounded-t-lg"
          style={{ background: accent }}
        />

        <div className="px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            {/* 图标徽章 */}
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
              style={{ background: `${accent}22`, color: accent }}
            >
              {renderNodeIcon(def.icon)}
            </div>
            {/* 节点名称：优先显示用户自定义 label，回退到类型默认 label */}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight">
                {data?.label || def.label}
              </div>
              <div className="truncate text-xs text-muted-foreground leading-tight">
                {type}
                <span className="ml-1 text-muted-foreground">· 双击改名</span>
              </div>
            </div>
          </div>

          {/* 用户自定义描述（若有） */}
          {data?.description && (
            <div
              className="mt-1.5 truncate text-xs italic text-muted-foreground"
              title={data.description}
            >
              {data.description}
            </div>
          )}

          {/* 关键字段摘要 */}
          {summary && (
            <div
              className="mt-2 truncate rounded bg-card px-2 py-1 text-xs text-foreground"
              title={summary}
            >
              {summary}
            </div>
          )}
        </div>

        {/* 右侧出口连接点（条件分支为多出口） */}
        <BranchHandles type={type} data={data} />
      </div>

      {/* 单节点运行结果弹窗 */}
      <Modal
        open={resultOpen}
        title={`节点运行结果：${data?.label || def.label}`}
        onClose={() => setResultOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <button
            type="button"
            onClick={() => setResultOpen(false)}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-foreground hover:bg-primary"
          >
            关闭
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {/* 输出 */}
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">输出（output）</div>
            <pre className="max-h-60 overflow-auto rounded-md bg-background p-3 text-xs text-success-300 ring-1 ring-gray-800">
              {runResult?.output
                ? JSON.stringify(runResult.output, null, 2)
                : '(空)'}
            </pre>
          </div>
          {/* 日志 */}
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              日志（{(runResult?.logs || []).length} 条）
            </div>
            <div className="max-h-48 overflow-auto rounded-md bg-background p-2 ring-1 ring-gray-800">
              {(runResult?.logs || []).length === 0 ? (
                <div className="text-xs text-muted-foreground">暂无日志</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {runResult.logs.map((l, i) => (
                    <div key={i} className="text-xs">
                      <span
                        className={`mr-2 font-mono ${
                          l.level === 'error'
                            ? 'text-destructive'
                            : l.level === 'warn'
                            ? 'text-warning-400'
                            : 'text-muted-foreground'
                        }`}
                      >
                        [{l.level}]
                      </span>
                      <span className="text-foreground">{l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </>
  )
}

export default memo(CustomNode)
