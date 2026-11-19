import {
  Section,
  NumberInput,
  SelectInput,
  CheckRow,
} from './property/FormControls'

// ============================================================================
// 中间件与安全配置组件 —— 编辑 Agent.tool_configs 的三段：
// 1. guardrails：工具循环守卫（warn/block/halt 阈值）
// 2. verification：写操作证据验证（block_ip/device_action 等执行前校验）
// 3. middlewares：中间件链（audit/redact/rate_limit/timing）
//
// 数据契约（与后端 backend/app/agent/hermes/{guardrails,verification,middleware}.py 对齐）：
//   tool_configs = {
//     guardrails: {
//       warnings_enabled: bool,             // 默认 true
//       hard_stop_enabled: bool,             // 默认 false
//       warn_after: { exact_failure: 2, same_tool_failure: 3, idempotent_no_progress: 2 },
//       hard_stop_after: { exact_failure: 5, same_tool_failure: 8, idempotent_no_progress: 5 },
//     },
//     verification: {
//       verify_block_ip: bool,               // 默认 true
//       require_threat_intel: bool,           // 默认 false
//       verify_device_action: bool,           // 默认 true
//       verify_send_notification: bool,       // 默认 true
//       verify_trigger_workflow: bool,        // 默认 true
//     },
//     middlewares: [
//       { name: 'audit', config: {} },
//       { name: 'redact' },
//       { name: 'rate_limit', config: { max_calls_per_minute: 30 } },
//       { name: 'timing' },
//     ],
//   }
//
// 受控组件：value=tool_configs 对象，onChange=新 tool_configs 回调。
// 未设置的子段会以默认值展示（不写入对象，直到用户实际修改）。
// ============================================================================

// ── 默认值（与后端 dataclass 默认一致）─────────────────────────────────────
const GUARDRAILS_DEFAULTS = {
  warnings_enabled: true,
  hard_stop_enabled: false,
  warn_after: { exact_failure: 2, same_tool_failure: 3, idempotent_no_progress: 2 },
  hard_stop_after: { exact_failure: 5, same_tool_failure: 8, idempotent_no_progress: 5 },
}

const VERIFICATION_DEFAULTS = {
  verify_block_ip: true,
  require_threat_intel: false,
  verify_device_action: true,
  verify_send_notification: true,
  verify_trigger_workflow: true,
}

// 内置中间件元数据（与 middleware.py BUILTIN_FACTORIES 对齐）
const BUILTIN_MIDDLEWARES = [
  {
    name: 'audit',
    label: '审计日志 (audit)',
    desc: '记录所有工具调用与 LLM 调用到日志，满足等保可审计要求',
    priority: 10,
    hasConfig: false,
  },
  {
    name: 'redact',
    label: '日志脱敏 (redact)',
    desc: '调用 redact 模块对日志/参数中的 API Key/Bearer/连接串强制脱敏',
    priority: 20,
    hasConfig: false,
  },
  {
    name: 'rate_limit',
    label: 'LLM 限流 (rate_limit)',
    desc: '令牌桶限流，每分钟最多 N 次 LLM 调用，超限短路返回错误',
    priority: 30,
    hasConfig: true,
    configKey: 'max_calls_per_minute',
    configDefault: 60,
    configLabel: '每分钟最大调用数',
    configMin: 1,
    configMax: 600,
  },
  {
    name: 'timing',
    label: '耗时统计 (timing)',
    desc: '记录工具与 LLM 调用耗时（duration_ms），便于性能分析',
    priority: 40,
    hasConfig: false,
  },
]

// ============================================================================
// 工具函数：安全读取嵌套字段（带默认值回退）
// ============================================================================
function getGuardrails(value) {
  return { ...GUARDRAILS_DEFAULTS, ...(value?.guardrails || {}) }
}
function getWarnAfter(value) {
  const g = getGuardrails(value)
  return { ...GUARDRAILS_DEFAULTS.warn_after, ...(g.warn_after || {}) }
}
function getHardStopAfter(value) {
  const g = getGuardrails(value)
  return { ...GUARDRAILS_DEFAULTS.hard_stop_after, ...(g.hard_stop_after || {}) }
}
function getVerification(value) {
  return { ...VERIFICATION_DEFAULTS, ...(value?.verification || {}) }
}
function getMiddlewares(value) {
  return Array.isArray(value?.middlewares) ? value.middlewares : []
}
function getEnabledMiddlewareNames(value) {
  return new Set(getMiddlewares(value).map((m) => m?.name).filter(Boolean))
}
function getMiddlewareConfig(value, name) {
  const m = getMiddlewares(value).find((m) => m?.name === name)
  return m?.config || {}
}

// ============================================================================
// 更新函数：返回新的 tool_configs 对象（不可变更新）
// ============================================================================
function updateGuardrails(value, patch) {
  const g = getGuardrails(value)
  return { ...(value || {}), guardrails: { ...g, ...patch } }
}
function updateWarnAfter(value, patch) {
  const g = getGuardrails(value)
  const wa = { ...(g.warn_after || GUARDRAILS_DEFAULTS.warn_after), ...patch }
  return { ...(value || {}), guardrails: { ...g, warn_after: wa } }
}
function updateHardStopAfter(value, patch) {
  const g = getGuardrails(value)
  const hsa = { ...(g.hard_stop_after || GUARDRAILS_DEFAULTS.hard_stop_after), ...patch }
  return { ...(value || {}), guardrails: { ...g, hard_stop_after: hsa } }
}
function updateVerification(value, patch) {
  const v = getVerification(value)
  return { ...(value || {}), verification: { ...v, ...patch } }
}
function toggleMiddleware(value, name, enabled) {
  const list = getMiddlewares(value)
  const exists = list.some((m) => m?.name === name)
  let next
  if (enabled && !exists) {
    // 添加：按 priority 升序插入（与后端 register 行为一致）
    const meta = BUILTIN_MIDDLEWARES.find((m) => m.name === name)
    const newEntry = meta?.hasConfig
      ? { name, config: { [meta.configKey]: meta.configDefault } }
      : { name }
    next = [...list, newEntry]
  } else if (!enabled && exists) {
    next = list.filter((m) => m?.name !== name)
  } else {
    return value
  }
  return { ...(value || {}), middlewares: next }
}
function updateMiddlewareConfig(value, name, configPatch) {
  const list = getMiddlewares(value)
  const next = list.map((m) =>
    m?.name === name ? { ...m, config: { ...(m.config || {}), ...configPatch } } : m
  )
  return { ...(value || {}), middlewares: next }
}

// ============================================================================
// 主组件
// ============================================================================
export default function MiddlewareConfig({ value, onChange }) {
  const guardrails = getGuardrails(value)
  const warnAfter = getWarnAfter(value)
  const hardStopAfter = getHardStopAfter(value)
  const verification = getVerification(value)
  const enabledMiddlewareNames = getEnabledMiddlewareNames(value)

  return (
    <div className="flex flex-col gap-4">
      {/* ────────────── 1. 工具循环守卫 ────────────── */}
      <Section
        title="工具循环守卫"
        hint="检测 Agent 陷入工具调用死循环（相同失败、无进展等），按阈值 warn/block/halt"
      >
        <div className="flex flex-col gap-1.5">
          <CheckRow
            label="启用警告（warn）"
            checked={guardrails.warnings_enabled}
            onChange={(v) => onChange(updateGuardrails(value, { warnings_enabled: v }))}
            hint="开启后循环触发时追加警告到结果，引导 LLM 改变策略（不阻断执行）"
          />
          <CheckRow
            label="启用硬停止（halt）"
            checked={guardrails.hard_stop_enabled}
            onChange={(v) => onChange(updateGuardrails(value, { hard_stop_enabled: v }))}
            hint="开启后严重循环会终止整个 turn（断路器行为，建议交互场景保持关闭）"
          />
        </div>

        <div className="rounded-md border border-border bg-muted p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            警告阈值（warn_after）
          </div>
          <div className="grid grid-cols-3 gap-2">
            <NumberInput
              label="相同失败"
              value={warnAfter.exact_failure}
              onChange={(v) => onChange(updateWarnAfter(value, { exact_failure: v }))}
              min={1}
              max={20}
              hint="相同工具+参数反复失败"
            />
            <NumberInput
              label="同工具失败"
              value={warnAfter.same_tool_failure}
              onChange={(v) => onChange(updateWarnAfter(value, { same_tool_failure: v }))}
              min={1}
              max={20}
              hint="同工具不同参数失败"
            />
            <NumberInput
              label="无进展"
              value={warnAfter.idempotent_no_progress}
              onChange={(v) => onChange(updateWarnAfter(value, { idempotent_no_progress: v }))}
              min={1}
              max={20}
              hint="幂等工具返回相同结果"
            />
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              硬停止阈值（hard_stop_after）
            </span>
            {!guardrails.hard_stop_enabled && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                需开启「启用硬停止」生效
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <NumberInput
              label="相同失败 block"
              value={hardStopAfter.exact_failure}
              onChange={(v) => onChange(updateHardStopAfter(value, { exact_failure: v }))}
              min={1}
              max={20}
              hint="block 本次调用"
            />
            <NumberInput
              label="同工具失败 halt"
              value={hardStopAfter.same_tool_failure}
              onChange={(v) => onChange(updateHardStopAfter(value, { same_tool_failure: v }))}
              min={1}
              max={20}
              hint="halt 整个 turn"
            />
            <NumberInput
              label="无进展 block"
              value={hardStopAfter.idempotent_no_progress}
              onChange={(v) => onChange(updateHardStopAfter(value, { idempotent_no_progress: v }))}
              min={1}
              max={20}
              hint="block 本次调用"
            />
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground">说明：</span>
          <span className="ml-1">block = 阻断本次调用并返回合成错误（不计入迭代预算）；halt = 终止整个 turn 进入 grace call。</span>
        </div>
      </Section>

      {/* ────────────── 2. 写操作证据验证 ────────────── */}
      <Section
        title="写操作证据验证"
        hint="写工具（block_ip/device_action 等）执行前校验证据链是否完整，防误操作"
      >
        <div className="flex flex-col gap-1.5">
          <CheckRow
            label="校验 block_ip（IP 封禁）"
            checked={verification.verify_block_ip}
            onChange={(v) => onChange(updateVerification(value, { verify_block_ip: v }))}
            hint="要求：IP 合法 + 不在白名单 + asset 已确认（+ 可选 threat_intel）"
          />
          {verification.verify_block_ip && (
            <div className="ml-6">
              <CheckRow
                label="必须先查威胁情报（require_threat_intel）"
                checked={verification.require_threat_intel}
                onChange={(v) => onChange(updateVerification(value, { require_threat_intel: v }))}
                hint="开启后 block_ip 前必须已调用 get_threat_intel；关闭则只要求白名单+资产"
              />
            </div>
          )}
          <CheckRow
            label="校验 device_action（设备动作）"
            checked={verification.verify_device_action}
            onChange={(v) => onChange(updateVerification(value, { verify_device_action: v }))}
            hint="要求：设备 ID 明确 + 动作合法 + 设备在线"
          />
          <CheckRow
            label="校验 send_notification（发送通知）"
            checked={verification.verify_send_notification}
            onChange={(v) => onChange(updateVerification(value, { verify_send_notification: v }))}
            hint="要求：决策已定 + 严重程度已评估 + 通知渠道有效"
          />
          <CheckRow
            label="校验 trigger_workflow_skill（触发工作流）"
            checked={verification.verify_trigger_workflow}
            onChange={(v) => onChange(updateVerification(value, { verify_trigger_workflow: v }))}
            hint="要求：workflow_id 存在 + payload 含必需字段"
          />
        </div>

        <div className="rounded-md border border-border bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground">验证结果：</span>
          <span className="ml-1">approved=放行；needs_clarification=引导 Agent 调 clarify 问用户；blocked=拒绝执行回写错误。</span>
        </div>
      </Section>

      {/* ────────────── 3. 中间件链 ────────────── */}
      <Section
        title="中间件链"
        hint="按 priority 升序执行；勾选后该中间件在工具/LLM 调用前后被自动调用"
      >
        <div className="flex flex-col gap-2">
          {BUILTIN_MIDDLEWARES.map((m) => {
            const enabled = enabledMiddlewareNames.has(m.name)
            return (
              <div
                key={m.name}
                className={`rounded-md border p-3 transition ${
                  enabled
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border bg-muted'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) =>
                      onChange(toggleMiddleware(value, m.name, e.target.checked))
                    }
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{m.label}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        priority={m.priority}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{m.desc}</p>
                  </div>
                </div>

                {/* rate_limit 的可配置参数 */}
                {enabled && m.hasConfig && (
                  <div className="mt-2 ml-6 border-l border-border pl-3">
                    <NumberInput
                      label={m.configLabel}
                      value={getMiddlewareConfig(value, m.name)[m.configKey] ?? m.configDefault}
                      onChange={(v) =>
                        onChange(
                          updateMiddlewareConfig(value, m.name, { [m.configKey]: v })
                        )
                      }
                      min={m.configMin}
                      max={m.configMax}
                      hint="超限将短路 LLM 调用并返回限流错误"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 当前中间件链顺序预览 */}
        {getMiddlewares(value).length > 0 && (
          <div className="rounded-md border border-border bg-card p-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              执行顺序（按 priority 升序）
            </div>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
              {[...getMiddlewares(value)]
                .sort((a, b) => {
                  const pa = BUILTIN_MIDDLEWARES.find((x) => x.name === a?.name)?.priority ?? 100
                  const pb = BUILTIN_MIDDLEWARES.find((x) => x.name === b?.name)?.priority ?? 100
                  return pa - pb
                })
                .map((m, idx) => (
                  <span key={m.name} className="flex items-center gap-1.5">
                    <span className="rounded bg-primary/20 px-1.5 py-0.5 text-primary">
                      {m.name}
                    </span>
                    {idx < getMiddlewares(value).length - 1 && (
                      <span className="text-muted-foreground">→</span>
                    )}
                  </span>
                ))}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground">钩子点：</span>
          <span className="ml-1">
            before_tool_call / after_tool_call / before_llm_call / after_llm_call；
            before_* 返回 ShortCircuitResult 可短路跳过实际调用。
          </span>
        </div>
      </Section>
    </div>
  )
}
