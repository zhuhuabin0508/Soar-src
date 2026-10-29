/**
 * 对话顶部工具栏（对标 new-api Playground 工具栏）
 *
 * 左侧：会话标题（大字号）+ 引擎药丸标签
 * 右侧：[⚙ N] [📝 System Prompt] [🗑 清空历史]（模型切换已迁至底部输入卡片）
 *
 * Props:
 * - agent: 当前选中智能体对象
 * - streaming: 是否正在流式输出
 * - overrides: 当前 override 配置
 * - updateOverrides: (updater) => void
 * - llmConfigs: LLM 配置列表
 * - onClearHistory: () => void  清空该智能体全部历史会话回调（与「新建会话」严格区分）
 * - onToggleSystemPrompt: () => void
 * - showSystemPrompt: SystemPromptEditor 是否展开
 */
import { useEffect, useRef, useState } from 'react'
import { Eraser, FileText, SlidersHorizontal } from 'lucide-react'
import ParamPanel from './ParamPanel'
import {
  countEnabledParams,
  isSystemPromptModified,
  isModelOverridden,
} from '../../hooks/useChatOverrides'

export default function ChatToolbar({
  agent,
  streaming = false,
  overrides,
  updateOverrides,
  llmConfigs = [],
  onClearHistory,
  onToggleSystemPrompt,
  showSystemPrompt = false,
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  // 二次确认超时定时器：组件卸载或重复点击时清理，避免定时器叠加/卸载后 setState
  const confirmTimerRef = useRef(null)

  const clearConfirmTimer = () => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }

  useEffect(() => clearConfirmTimer, [])

  if (!agent) return null

  const name = agent.name || `智能体 ${agent.id}`

  // 当前 override 配置
  const ov = overrides || {}
  const enabledParamCount = countEnabledParams(ov)
  const spModified = isSystemPromptModified(ov)
  const modelOverridden = isModelOverridden(ov)

  // 确定当前 provider
  const currentModelConfigId = ov.model_config_id || agent.model_config_id
  const currentConfig = llmConfigs.find(
    (c) => String(c.id) === String(currentModelConfigId)
  )
  const provider = (currentConfig?.provider || 'openai').toLowerCase()

  const handleParamsChange = (nextParams) => {
    updateOverrides((prev) => ({ ...prev, params: nextParams }))
  }

  // 清空全部历史对话：二次确认（与「新建会话」区分，此操作不可恢复）
  const handleClear = () => {
    if (!confirmClear) {
      clearConfirmTimer()
      setConfirmClear(true)
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null
        setConfirmClear(false)
      }, 3000)
      return
    }
    clearConfirmTimer()
    setConfirmClear(false)
    onClearHistory?.()
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-2.5">
      {/* 左侧：头像 + 会话标题 + 引擎药丸标签 */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-sm">
        {agent.avatar ? (
          <img src={agent.avatar} alt={name} className="h-full w-full object-cover" />
        ) : (
          <span className="font-semibold text-foreground">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-foreground">{name}</span>
          {/* 引擎药丸标签（低饱和描边小标签） */}
          <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Hermes
          </span>
          {/* 模型覆盖指示点 */}
          {modelOverridden && (
            <span
              className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
              title="已覆盖模型"
            />
          )}
          {/* 流式状态 */}
          {streaming && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              生成中
            </span>
          )}
        </div>
      </div>

      {/* 右侧：调试工具按钮组 */}
      <div className="flex shrink-0 items-center gap-3">
        {/* 参数面板 */}
        <ParamPanel
          params={ov.params || {}}
          onChange={handleParamsChange}
          provider={provider}
        />

        {/* System Prompt 切换 */}
        <button
          type="button"
          onClick={onToggleSystemPrompt}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition ${
            showSystemPrompt || spModified
              ? 'border-primary/40 bg-muted text-foreground'
              : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title="System Prompt（仅本次会话生效）"
        >
          <FileText className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">System Prompt</span>
          {spModified && (
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          )}
        </button>

        {/* 清空全部历史对话（二次确认）：灰色次要按钮，不抢视觉 */}
        <button
          type="button"
          onClick={handleClear}
          disabled={streaming}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
            confirmClear
              ? 'border-destructive/50 bg-destructive/10 text-destructive'
              : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-muted-foreground'
          }`}
          title={confirmClear ? '再点一次确认清空全部历史对话' : '清空该智能体的全部历史对话（不可恢复，参数保留）'}
        >
          <Eraser className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{confirmClear ? '确认清空历史' : '清空历史'}</span>
        </button>
      </div>
    </div>
  )
}
