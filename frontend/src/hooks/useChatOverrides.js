/**
 * 会话级参数覆盖状态管理（对标 new-api Playground 参数面板）
 *
 * 按 agentId 隔离持久化到 localStorage，切换智能体时参数独立互不干扰。
 * 借鉴 new-api 的"按需启用"模式：每个参数有独立开关，只有启用的才写入请求体，
 * 避免覆盖模型默认值。
 *
 * 存储结构（每个 agent 一份）：
 * {
 *   model_config_id: null,          // null = 用智能体默认
 *   system_prompt: '',              // '' = 未覆盖，非空 = 覆盖
 *   params: {
 *     temperature: { enabled: false, value: 0.7 },
 *     top_p: { enabled: false, value: 1 },
 *     max_tokens: { enabled: false, value: 1024 },
 *     frequency_penalty: { enabled: false, value: 0 },
 *     presence_penalty: { enabled: false, value: 0 },
 *     seed: { enabled: false, value: null },
 *   }
 * }
 */

// localStorage 键前缀（与 ChatPage 现有 LS_HISTORY_PREFIX / LS_SESSION_PREFIX 同款模式）
const LS_OVERRIDES_PREFIX = 'soar_chat_overrides_'

// 参数定义：键 → { label, desc, min, max, step, defaultValue }
// 范围预设对标 new-api Playground
export const PARAM_DEFS = {
  temperature: { label: 'Temperature', desc: '采样温度，越高越随机创造性', min: 0, max: 2, step: 0.1, defaultValue: 0.7 },
  top_p: { label: 'Top P', desc: '核采样概率，限制候选 token 累计概率', min: 0, max: 1, step: 0.05, defaultValue: 1 },
  max_tokens: { label: 'Max Tokens', desc: '最大生成 token 数（推理模型的思考也计入，建议 16K 以上）', min: 1, max: 65536, step: 1, defaultValue: 1024 },
  frequency_penalty: { label: 'Frequency Penalty', desc: '频率惩罚，降低已出现 token 的概率', min: -2, max: 2, step: 0.1, defaultValue: 0 },
  presence_penalty: { label: 'Presence Penalty', desc: '存在惩罚，鼓励引入新话题', min: -2, max: 2, step: 0.1, defaultValue: 0 },
  seed: { label: 'Seed', desc: '随机种子，固定种子可复现结果', min: 0, max: 999999, step: 1, defaultValue: null },
}

// 生成默认的 override 配置（新智能体首次进入时用）
export function defaultOverride() {
  const params = {}
  Object.entries(PARAM_DEFS).forEach(([key, def]) => {
    params[key] = { enabled: false, value: def.defaultValue }
  })
  return {
    model_config_id: null,
    system_prompt: '',
    params,
  }
}

// 从 localStorage 读取某智能体的 overrides
export function loadOverrides(agentId) {
  try {
    const raw = localStorage.getItem(`${LS_OVERRIDES_PREFIX}${agentId}`)
    if (!raw) return null
    const saved = JSON.parse(raw)
    // 合并默认值：旧数据可能缺字段（如新增 seed），用 defaultOverride 补齐
    const base = defaultOverride()
    return {
      model_config_id: saved.model_config_id ?? null,
      system_prompt: saved.system_prompt ?? '',
      params: { ...base.params, ...(saved.params || {}) },
    }
  } catch {
    return null
  }
}

// 保存某智能体的 overrides 到 localStorage
export function saveOverrides(agentId, overrides) {
  try {
    localStorage.setItem(`${LS_OVERRIDES_PREFIX}${agentId}`, JSON.stringify(overrides))
  } catch {
    // localStorage 满了静默失败
  }
}

/**
 * 构造请求体的 override 对象（过滤启用的字段）
 *
 * @param {object} overrideConfig - 完整的 override 配置（含 model_config_id/system_prompt/params）
 * @returns {object} 仅含启用字段的 override 对象，空对象表示无覆盖
 *
 * 例：{ temperature: 0.7, max_tokens: 2048 }  ← 只含启用的参数
 */
export function buildOverride(overrideConfig) {
  if (!overrideConfig) return {}
  const result = {}

  // 模型覆盖：非 null 才写入
  if (overrideConfig.model_config_id) {
    result.model_config_id = Number(overrideConfig.model_config_id)
  }

  // System Prompt 覆盖：非空字符串才写入
  if (overrideConfig.system_prompt && overrideConfig.system_prompt.trim()) {
    result.system_prompt = overrideConfig.system_prompt
  }

  // 参数覆盖：仅启用的才写入
  Object.entries(overrideConfig.params || {}).forEach(([key, cfg]) => {
    if (cfg && cfg.enabled && cfg.value !== null && cfg.value !== undefined) {
      result[key] = cfg.value
    }
  })

  return result
}

/**
 * 计算已启用的参数数量（用于工具栏 Badge 显示）
 */
export function countEnabledParams(overrideConfig) {
  if (!overrideConfig?.params) return 0
  return Object.values(overrideConfig.params).filter((c) => c?.enabled).length
}

/**
 * 判断 System Prompt 是否已被修改（用于工具栏指示点）
 */
export function isSystemPromptModified(overrideConfig) {
  return !!(overrideConfig?.system_prompt && overrideConfig.system_prompt.trim())
}

/**
 * 判断模型是否被覆盖（用于工具栏指示点）
 */
export function isModelOverridden(overrideConfig) {
  return !!overrideConfig?.model_config_id
}
