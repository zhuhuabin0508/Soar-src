// 工单价值评分前端计算与展示工具
//
// 与后端 app/core/ticket_score.py 保持同一口径，用于评分表单实时预览：
//   价值分 = ROUND(Σ(维度得分 × 维度权重) × scale × 修正系数, 0)，0-100 截断
//   修正系数多类连乘，总系数受 factor_cap 限制；强制置顶按 set / min 抬升下限

export function roundHalfUp(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.floor(n + 0.5)
}

export function clampScore(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, roundHalfUp(value)))
}

/**
 * 按规则计算价值分（用于前端实时预览）。
 * 未选择全部维度时缺失维度按 1 分估算，返回 complete=false 供界面提示。
 */
export function computeScore(rule, dimensionScores = {}, factorKeys = [], overrideKeys = []) {
  const dimensions = rule?.dimensions || []
  const dims = []
  let weighted = 0
  let missing = 0
  for (const dim of dimensions) {
    const raw = dimensionScores[dim.key]
    const n = Number(raw)
    const valid = Number.isInteger(n) && n >= 1 && n <= 5
    if (!valid) missing += 1
    const score = valid ? n : 1
    const level = (dim.levels || []).find((x) => Number(x.score) === score)
    const points = (score * Number(dim.weight || 0)) / 100
    weighted += points
    dims.push({
      key: dim.key,
      name: dim.name,
      weight: Number(dim.weight || 0),
      score,
      level_label: level?.label || '',
      criteria: level?.criteria || '',
      points: Math.round(points * 10000) / 10000,
    })
  }

  const scale = Number(rule?.scale || 20)
  const base = weighted * scale
  const baseScore = clampScore(base)

  const selectedFactors = new Set((factorKeys || []).filter(Boolean))
  const appliedFactors = []
  let multiplier = 1
  for (const factor of rule?.factors || []) {
    if (!selectedFactors.has(factor.key) || factor.enabled === false) continue
    multiplier *= Number(factor.multiplier || 1)
    appliedFactors.push({
      key: factor.key,
      name: factor.name,
      multiplier: Number(factor.multiplier || 1),
      description: factor.description || '',
    })
  }
  const cap = Number(rule?.factor_cap || 1.3)
  const cappedMultiplier = Math.min(multiplier, cap)
  const adjusted = base * cappedMultiplier
  let final = clampScore(adjusted)

  const selectedOverrides = new Set((overrideKeys || []).filter(Boolean))
  const appliedOverrides = []
  for (const item of rule?.override_rules || []) {
    if (!selectedOverrides.has(item.key) || item.enabled === false) continue
    const value = Number(item.value || 0)
    const before = final
    final = item.mode === 'set' ? value : Math.max(final, value)
    final = clampScore(final)
    appliedOverrides.push({
      key: item.key,
      name: item.name,
      mode: item.mode || 'min',
      value,
      description: item.description || '',
      before,
      after: final,
    })
  }

  // 分级按最低分从高到低匹配（配置编辑过程中顺序可能暂未调整，这里先排序再匹配）
  const grades = [...(rule?.grades || [])].sort((a, b) => Number(b.min || 0) - Number(a.min || 0))
  const grade = grades.find((g) => final >= Number(g.min || 0)) || grades[grades.length - 1] || {
    key: '', label: '', min: 0, color: 'slate',
  }

  return {
    complete: missing === 0,
    missing,
    dimension_scores: Object.fromEntries(dims.map((d) => [d.key, d.score])),
    dimensions: dims,
    weighted: Math.round(weighted * 10000) / 10000,
    scale,
    base_score: baseScore,
    factors: appliedFactors,
    factor_multiplier: Math.round(multiplier * 10000) / 10000,
    factor_capped_multiplier: Math.round(cappedMultiplier * 10000) / 10000,
    factor_capped: multiplier > cap,
    adjusted_score: Math.round(adjusted * 100) / 100,
    override_rules: appliedOverrides,
    final_score: final,
    grade: {
      key: grade.key || '',
      label: grade.label || grade.key || '',
      min: Number(grade.min || 0),
      color: grade.color || 'slate',
      description: grade.description || '',
    },
  }
}

// 分级颜色 → 徽标样式（与全局语义色一致）
export const GRADE_BADGE_CLS = {
  red: 'bg-red-500/10 text-red-500 ring-red-500/30',
  orange: 'bg-orange-500/10 text-orange-500 ring-orange-500/30',
  amber: 'bg-amber-500/10 text-amber-600 ring-amber-500/30 dark:text-amber-400',
  blue: 'bg-blue-500/10 text-blue-500 ring-blue-500/30',
  emerald: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/30',
  slate: 'bg-muted text-muted-foreground ring-border',
}

export function gradeBadgeCls(color) {
  return GRADE_BADGE_CLS[color] || GRADE_BADGE_CLS.slate
}

// 分值 → 文字颜色（评分大数字使用）
export const SCORE_TEXT_CLS = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  amber: 'text-amber-600 dark:text-amber-400',
  blue: 'text-blue-500',
  emerald: 'text-emerald-500',
  slate: 'text-foreground',
}

export function scoreTextCls(color) {
  return SCORE_TEXT_CLS[color] || SCORE_TEXT_CLS.slate
}
