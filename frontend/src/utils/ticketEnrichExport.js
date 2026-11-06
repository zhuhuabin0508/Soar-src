// 工单安全上下文（多 IP）导出工具：前端组装 xlsx 下载，零后端改动。
//
// 数据源：工单 enrichment v2 entries（资产/情报/智能体研判）+ 黑名单
// 实时查询结果（会话内 Map，key=ip）。列对齐安全上下文展示口径：
// 角色 / IP / 黑名单状态 / 情报结论 / 置信度 / 严重程度 / 威胁标签 /
// 地理归属 / 资产名 / 资产来源 / 部门 / 负责人 / 重要性 / 智能体风险等级。
import * as XLSX from 'xlsx'

const SEVERITY_LABELS = { low: '低', medium: '中', high: '高', critical: '严重' }
const CRITICALITY_LABELS = { low: '低', medium: '中', high: '高', critical: '严重' }
const AGENT_RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险', critical: '严重风险' }

const HEADER = [
  '角色', 'IP', '黑名单状态', '情报结论', '置信度', '严重程度',
  '威胁标签', '地理归属', '资产名', '资产来源', '部门', '负责人',
  '重要性', '智能体风险等级', '研判档位',
]

function _norm(v) {
  return v === undefined || v === null || v === '' ? '--' : String(v)
}

function _agentRisk(agent) {
  if (!agent || typeof agent !== 'object' || agent.pending) return '--'
  const raw = agent.risk_level
  return AGENT_RISK_LABELS[raw] || _norm(raw)
}

function _row(e, banStatusMap, roleLabels) {
  const threat = e.threat && typeof e.threat === 'object' ? e.threat : {}
  const asset = e.asset && typeof e.asset === 'object' ? e.asset : {}
  const ban = banStatusMap.get(e.ip)
  const geo = threat.geo_info || {}
  return [
    (e.roles || []).map((r) => roleLabels[r] || r).join('、') || '--',
    e.ip,
    ban ? (ban.banned ? '封禁中' : '未封禁') : '--',
    threat.is_malicious === true ? '恶意' : threat.is_malicious === false ? '非恶意' : '--',
    threat.confidence !== undefined && threat.confidence !== null ? `${Math.round(threat.confidence * 100)}%` : '--',
    SEVERITY_LABELS[threat.severity] || _norm(threat.severity),
    _norm((threat.tags || []).join('、')),
    _norm([geo.country, geo.city].filter(Boolean).join(' ')),
    asset.matched ? _norm(asset.asset_name) : '未匹配',
    asset.matched ? _norm(asset.source_label || asset.source) : '--',
    asset.matched ? _norm(asset.inventory?.fields?.department) : '--',
    asset.matched ? _norm(asset.inventory?.fields?.owner) : '--',
    asset.matched ? (CRITICALITY_LABELS[asset.inventory?.fields?.criticality] || _norm(asset.inventory?.fields?.criticality)) : '--',
    _agentRisk(e.agent),
    e.detail === 'full' ? '完整' : e.detail === 'lite' ? '精简' : '--',
  ]
}

/**
 * 导出安全上下文 IP 详情为 xlsx。
 * @param {Array}    entries       v2 entries（[{ip, roles, detail, asset, threat, agent}]）
 * @param {Map}      banStatusMap  黑名单查询结果（key=ip，{banned, entry, raw, note}）；未查询过的 IP 该列输出 --
 * @param {Object}   roleLabels    {src_ip: '源IP地址', dst_ip: '目的IP地址'}
 * @param {Object}   meta          {ticketNo, title}
 */
export function exportEnrichmentXlsx(entries, banStatusMap, roleLabels, meta = {}) {
  const rows = [HEADER, ...(entries || []).map((e) => _row(e, banStatusMap, roleLabels))]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  // 列宽：中文表头可读性
  ws['!cols'] = [
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
    { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 12 }, { wch: 10 },
    { wch: 8 }, { wch: 12 }, { wch: 8 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '安全上下文')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '')
  const name = `安全上下文-工单${meta.ticketNo || ''}-${stamp}`.replace(/\s+/g, '_')
  XLSX.writeFile(wb, `${name}.xlsx`)
}
