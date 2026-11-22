// 工单价值评分面板
//
// 两种形态：
// - 未评分：按当前生效规则渲染维度锚点（1-5 分）、修正系数、强制置顶与说明，
//   右侧实时预估分值（与后端同一计算口径），提交后不可修改；
// - 已评分：展示提交时的完整评分结果（维度加权、修正、置顶、分级），并明确标记
//   「已完成评分」；规则已更新时同时展示按最新规则折算的分值与明细。
//
// 用于工单详情「价值评分」Tab 与工单列表展开行；数据来自 /ticket-scores/tickets/{id}。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Check, ChevronDown, Gauge, Info, Loader2, Lock, RefreshCw,
  Scale, ShieldAlert, Star,
} from 'lucide-react'
import { toast } from '../store/toastStore'
import { confirm } from '../components/ConfirmDialog'
import { Button } from './ui'
import { inputCls, labelCls } from './property/FormControls'
import ticketScoreApi from '../api/ticketScores'
import { computeScore, gradeBadgeCls, scoreTextCls } from '../utils/ticketScore'

const fmtTime = (v) => (
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '--'
)

const pct = (n) => `${Number(n || 0)}%`
const mult = (n) => `×${Number(n || 0).toFixed(2)}`

function GradeBadge({ grade, color, size = 'sm' }) {
  if (!grade) return null
  const cls = gradeBadgeCls(color)
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-semibold ring-1 ${cls} ${size === 'lg' ? 'text-sm' : 'text-xs'}`}>
      {grade}
    </span>
  )
}

function ScoreBreakdown({ breakdown, compact = false }) {
  if (!breakdown) return null
  const dims = breakdown.dimensions || []
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">评分维度</th>
              <th className="px-3 py-2 font-medium">维度得分</th>
              <th className="px-3 py-2 text-right font-medium">权重</th>
              <th className="px-3 py-2 text-right font-medium">加权分</th>
            </tr>
          </thead>
          <tbody>
            {dims.map((d) => (
              <tr key={d.key} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-2 text-foreground">{d.name}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  <span className="font-semibold text-foreground">{d.score}</span>
                  {d.level_label ? ` · ${d.level_label}` : ''}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(d.weight)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{Number(d.points || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span>加权合计</span>
            <span className="font-mono tabular-nums text-foreground">{Number(breakdown.weighted || 0).toFixed(2)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span>× 放大系数 {breakdown.scale}</span>
            <span className="font-mono tabular-nums text-foreground">{breakdown.base_score} 分（未修正）</span>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span>修正系数</span>
            <span className="font-mono tabular-nums text-foreground">
              {mult(breakdown.factor_multiplier)}
              {breakdown.factor_capped ? `（上限 ${mult(breakdown.factor_capped_multiplier)}）` : ''}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span>修正后</span>
            <span className="font-mono tabular-nums text-foreground">{Number(breakdown.adjusted_score || 0).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {(breakdown.factors || []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">命中修正：</span>
          {breakdown.factors.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-blue-500" title={f.description}>
              <Scale className="h-3 w-3" />{f.name}<span className="font-mono">{mult(f.multiplier)}</span>
            </span>
          ))}
        </div>
      )}
      {(breakdown.override_rules || []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">强制置顶：</span>
          {breakdown.override_rules.map((r) => (
            <span key={r.key} className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-red-500" title={r.description}>
              <ShieldAlert className="h-3 w-3" />
              {r.name}
              <span className="font-mono">{r.mode === 'set' ? '=' : '≥'}{r.value}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Gauge className="h-4 w-4 text-primary" />
          最终价值分
          <span className={`text-2xl font-bold tabular-nums ${scoreTextCls(breakdown.grade?.color)}`}>
            {breakdown.final_score}
          </span>
          <GradeBadge grade={breakdown.grade?.label} color={breakdown.grade?.color} size="lg" />
        </div>
        <span className="text-xs text-muted-foreground">
          {compact ? '' : `分级规则：≥${breakdown.grade?.min ?? 0} 分`}
        </span>
      </div>
    </div>
  )
}

function ScoreResultView({ state, compact = false }) {
  const score = state.score || {}
  const breakdown = score.breakdown || {}
  const color = breakdown.grade?.color || 'slate'
  const current = state.current
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4 rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] px-4 py-3">
        <div className="text-center">
          <div className={`text-4xl font-bold tabular-nums ${scoreTextCls(color)}`}>{score.final_score}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">价值分</div>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <GradeBadge grade={score.grade_label || score.grade} color={color} size="lg" />
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />已完成评分
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" />不允许重复提交
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            评分人：{score.scored_by_name || '--'} · 评分时间：{fmtTime(score.scored_at)} · 提交时规则版本：v{score.rule_version}
          </div>
          {score.comment && (
            <div className="rounded-md bg-background/60 px-2.5 py-1.5 text-xs text-foreground">
              评分说明：{score.comment}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] text-muted-foreground">评分规则</div>
          <div className="text-xs font-medium text-foreground">v{score.rule_version}{score.rule_version === 0 ? '（内置默认）' : ''}</div>
        </div>
      </div>

      {state.rule_changed && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                评分规则已更新至 v{state.rule?.version}，该工单已按最新规则自动折算
              </div>
              <div className="mt-1 text-foreground">
                折算结果：<span className="font-semibold">{current?.final_score ?? '--'} 分</span>
                {current?.grade?.label ? `（${current.grade.label}）` : ''}
                <span className="ml-2 text-muted-foreground">原始评分 {score.final_score} 分不做修改，历史结果已保留</span>
              </div>
              {current && (
                <details className="mt-2">
                  <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronDown className="h-3 w-3" />查看按最新规则折算明细
                  </summary>
                  <div className="mt-2">
                    <ScoreBreakdown breakdown={current} compact />
                  </div>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">评分明细</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">规则 v{score.rule_version}</span>
        </div>
        <ScoreBreakdown breakdown={breakdown} compact={compact} />
      </div>

      {score.rule_snapshot && (
        <details className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <Info className="h-3 w-3" />查看提交时采用的规则快照（v{score.rule_version}）
          </summary>
          <div className="mt-2 space-y-1.5 text-muted-foreground">
            <div>公式：{score.rule_snapshot.formula_note || '--'}</div>
            <div>
              维度权重：{(score.rule_snapshot.dimensions || []).map((d) => `${d.name} ${d.weight}%`).join(' · ')}
            </div>
            <div>
              修正系数：
              {(score.rule_snapshot.factors || []).length
                ? (score.rule_snapshot.factors || []).map((f) => `${f.name} ×${f.multiplier}`).join('；')
                : '--'}
              （总上限 ×{score.rule_snapshot.factor_cap}）
            </div>
            <div>
              强制置顶：
              {(score.rule_snapshot.override_rules || []).length
                ? (score.rule_snapshot.override_rules || []).map((r) => `${r.name}（${r.mode === 'set' ? '=' : '≥'}${r.value}）`).join('；')
                : '--'}
            </div>
          </div>
        </details>
      )}
    </div>
  )
}

function DimensionSelector({ dimension, value, onChange, compact = false }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{dimension.name}</span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              权重 {dimension.weight}%
            </span>
            {value ? (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                已选 {value} 分
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">待选择</span>
            )}
          </div>
          {(dimension.question || dimension.basis) && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {dimension.question && <span>{dimension.question}</span>}
              {dimension.basis && <span>取值依据：{dimension.basis}</span>}
            </div>
          )}
        </div>
      </div>
      <div className={`mt-2.5 grid gap-2 ${compact ? 'sm:grid-cols-2 xl:grid-cols-5' : 'sm:grid-cols-2 lg:grid-cols-5'}`}>
        {(dimension.levels || []).map((level) => {
          const active = Number(value) === Number(level.score)
          return (
            <button
              key={level.score}
              type="button"
              onClick={() => onChange(Number(level.score))}
              className={`flex h-full flex-col rounded-md border p-2 text-left transition ${
                active
                  ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40'
                  : 'border-border bg-background hover:border-primary/40 hover:bg-muted/40'
              }`}
              title={level.criteria}
            >
              <div className="flex items-center gap-1.5">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  active ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'
                }`}>
                  {level.score}
                </span>
                <span className={`truncate text-xs font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
                  {level.label}
                </span>
              </div>
              <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                {level.criteria}
              </div>
              {level.criteria_attack && (
                <div className="mt-1 border-t border-dashed border-border/70 pt-1 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground/70">攻击类：</span>{level.criteria_attack}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ScoreForm({ state, onScored, compact = false }) {
  const rule = state.rule || {}
  const [scores, setScores] = useState({})
  const [factorKeys, setFactorKeys] = useState([])
  const [overrideKeys, setOverrideKeys] = useState([])
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const preview = useMemo(
    () => computeScore(rule, scores, factorKeys, overrideKeys),
    [rule, scores, factorKeys, overrideKeys],
  )

  const toggleKey = (list, setList, key) => {
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key])
  }

  const handleSubmit = async () => {
    if (preview.missing > 0) {
      toast.warning(`还有 ${preview.missing} 个维度未选择分值`)
      return
    }
    const ok = await confirm({
      title: '提交工单评分',
      message: (
        <div className="space-y-2">
          <p>工单 <span className="font-mono font-medium text-foreground">{state.ticket_no}</span> 将评为：</p>
          <p className="text-lg font-semibold text-foreground">
            {preview.final_score} 分 · {preview.grade?.label}
          </p>
          <p className="text-xs text-muted-foreground">
            评分依据当前规则 v{rule.version}。提交后不可修改，且不可重复评分。
          </p>
        </div>
      ),
      confirmText: '确认提交',
      variant: 'warning',
    })
    if (!ok) return
    setSubmitting(true)
    setError('')
    try {
      const res = await ticketScoreApi.submitScore(state.ticket_id, {
        dimension_scores: scores,
        factor_keys: factorKeys,
        override_keys: overrideKeys,
        comment: comment.trim() || undefined,
      })
      toast.success(`评分提交成功：${res.score?.final_score} 分（${res.score?.grade_label || res.score?.grade}）`)
      onScored?.(res)
    } catch (e) {
      setError(e.message || '评分提交失败')
      toast.error(e.message || '评分提交失败')
      // 409：已被其他人评分，刷新状态展示已提交结果
      if (e.status === 409) onScored?.()
    } finally {
      setSubmitting(false)
    }
  }

  if (!state.can_score) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-4 py-4 text-sm">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium text-foreground">暂不可评分</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {state.blocked_reason || '当前工单不满足评分条件'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`grid gap-4 ${compact ? '' : 'xl:grid-cols-[minmax(0,1fr)_300px]'}`}>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5 text-primary" />
          <span>按维度选择 1-5 分；权重合计 {rule.dimensions?.reduce((s, d) => s + Number(d.weight || 0), 0)}%</span>
          <span className="text-border">|</span>
          <span>规则 v{rule.version}{rule.builtin ? '（内置默认）' : ''}</span>
          <span className="ml-auto inline-flex items-center gap-1">
            已选 {Object.values(scores).filter((v) => v >= 1).length}/{rule.dimensions?.length || 0} 个维度
          </span>
        </div>

        {(rule.dimensions || []).map((dim) => (
          <DimensionSelector
            key={dim.key}
            dimension={dim}
            value={scores[dim.key]}
            compact={compact}
            onChange={(v) => setScores((s) => ({ ...s, [dim.key]: v }))}
          />
        ))}

        {(rule.factors || []).filter((f) => f.enabled !== false).length > 0 && (
          <div className="rounded-md border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Scale className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-semibold text-foreground">修正系数</span>
              <span className="text-xs text-muted-foreground">
                命中后连乘，总系数上限 ×{rule.factor_cap}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(rule.factors || []).filter((f) => f.enabled !== false).map((f) => {
                const checked = factorKeys.includes(f.key)
                return (
                  <label
                    key={f.key}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                      checked ? 'border-blue-500/50 bg-blue-500/[0.05]' : 'border-border hover:border-blue-500/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={checked}
                      onChange={() => toggleKey(factorKeys, setFactorKeys, f.key)}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground">{f.name}</span>
                        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-xs text-blue-500">
                          {mult(f.multiplier)}
                        </span>
                      </span>
                      {f.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{f.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {(rule.override_rules || []).filter((r) => r.enabled !== false).length > 0 && (
          <div className="rounded-md border border-red-500/25 bg-red-500/[0.03] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-500" />
              <span className="text-sm font-semibold text-foreground">强制置顶</span>
              <span className="text-xs text-muted-foreground">命中后不依赖加权结果，直接抬升到指定分值</span>
            </div>
            <div className="mt-2 space-y-2">
              {(rule.override_rules || []).filter((r) => r.enabled !== false).map((r) => {
                const checked = overrideKeys.includes(r.key)
                return (
                  <label
                    key={r.key}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition ${
                      checked ? 'border-red-500/50 bg-red-500/[0.06]' : 'border-border hover:border-red-500/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={checked}
                      onChange={() => toggleKey(overrideKeys, setOverrideKeys, r.key)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground">{r.name}</span>
                        <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-xs text-red-500">
                          {r.mode === 'set' ? '=' : '≥'}{r.value}
                        </span>
                      </span>
                      {r.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{r.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border bg-card p-3">
          <label className={labelCls} htmlFor={`score-comment-${state.ticket_id}`}>评分说明（可选）</label>
          <textarea
            id={`score-comment-${state.ticket_id}`}
            className={`${inputCls} mt-1 min-h-[64px] w-full resize-y`}
            maxLength={2000}
            placeholder="补充评分依据、资产确认情况等"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className={`${compact ? '' : 'xl:sticky xl:top-4'} h-fit space-y-2 rounded-md border border-primary/30 bg-primary/[0.03] p-3`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">实时预估</span>
          <span className="text-[11px] text-muted-foreground">规则 v{rule.version}</span>
        </div>
        <div className="flex items-end gap-2">
          <span className={`text-4xl font-bold tabular-nums ${scoreTextCls(preview.grade?.color)}`}>
            {preview.final_score}
          </span>
          <span className="pb-1 text-xs text-muted-foreground">分</span>
          <span className="pb-1">
            <GradeBadge grade={preview.grade?.label} color={preview.grade?.color} size="lg" />
          </span>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>加权合计</span>
            <span className="font-mono tabular-nums">{preview.weighted.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>× 放大系数 {preview.scale}</span>
            <span className="font-mono tabular-nums">{preview.base_score}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>修正系数{preview.factor_capped ? '（受上限限制）' : ''}</span>
            <span className="font-mono tabular-nums">{mult(preview.factor_capped_multiplier)}</span>
          </div>
          {preview.override_rules.length > 0 && (
            <div className="flex items-center justify-between text-red-500">
              <span>强制置顶</span>
              <span className="font-mono tabular-nums">
                {preview.override_rules.map((r) => `${r.mode === 'set' ? '=' : '≥'}${r.value}`).join(' / ')}
              </span>
            </div>
          )}
        </div>
        {preview.missing > 0 && (
          <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            还有 {preview.missing} 个维度未选择，当前按 1 分预估
          </div>
        )}
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          loading={submitting}
          disabled={submitting || preview.missing > 0}
          onClick={handleSubmit}
        >
          <Check className="mr-1 h-3.5 w-3.5" />提交评分
        </Button>
        <p className="text-[11px] leading-snug text-muted-foreground">
          提交后不可修改或重复评分；评分结果将写入操作日志。
        </p>
      </div>
    </div>
  )
}

export default function TicketScorePanel({
  ticketId,
  initialState = null,
  onScored,
  compact = false,
  className = '',
}) {
  const [state, setState] = useState(initialState)
  const [loading, setLoading] = useState(!initialState)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(() => {
    let alive = true
    setLoading(true)
    setError('')
    ticketScoreApi.getTicketScore(ticketId)
      .then((res) => { if (alive) setState(res) })
      .catch((e) => { if (alive) setError(e.message || '加载评分信息失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [ticketId, reloadKey])

  useEffect(() => {
    // 详情页已下发评分状态时直接复用，避免重复请求；重新加载/评分失败时再拉取
    if (initialState && reloadKey === 0) {
      setState(initialState)
      setLoading(false)
      return undefined
    }
    return load()
  }, [load, initialState, reloadKey])

  useEffect(() => {
    if (initialState) setState(initialState)
  }, [initialState])

  const handleScored = (res) => {
    if (res) setState(res)
    else setReloadKey((n) => n + 1)
    onScored?.(res)
  }

  if (loading && !state) {
    return (
      <div className={`flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground ${className}`}>
        <Loader2 className="h-4 w-4 animate-spin" />加载评分信息...
      </div>
    )
  }
  if (error && !state) {
    return (
      <div className={`flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground ${className}`}>
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <span>{error}</span>
        <Button variant="secondary" size="sm" onClick={() => setReloadKey((n) => n + 1)}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />重试
        </Button>
      </div>
    )
  }
  if (!state) return null

  return (
    <div className={className}>
      {state.score ? (
        <ScoreResultView state={state} compact={compact} />
      ) : (
        <ScoreForm state={state} onScored={handleScored} compact={compact} />
      )}
    </div>
  )
}
