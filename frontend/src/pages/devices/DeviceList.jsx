// 设备卡片、动作表格、设备列表行、骨架屏、数值单元格
import { ChevronDown, ChevronRight, History, Plus, RefreshCw, TestTube, Wifi } from 'lucide-react'
import {
  DEVICE_TYPE_LABELS,
  fmtRelative,
  fmtTime,
  numCell,
  parseTags,
  successRate,
  truncate,
} from './constants'
import {
  CategoryBadge,
  DeviceTypeIcon,
  MethodBadge,
  RiskBadge,
  StatusBadge,
  Switch,
} from './Badges'

// ============ 数值单元格（表格数值列统一规范） ============
// 等宽 + tabular-nums + 千位分隔符；null → '--'（带 tooltip），0 → 灰色
export function NumCell({ value, title, className = '' }) {
  const c = numCell(value)
  return (
    <span
      className={`font-mono tabular-nums ${c.muted ? 'text-muted-foreground' : 'text-foreground'} ${className}`}
      title={c.text === '--' ? title || '未统计' : undefined}
    >
      {c.text}
    </span>
  )
}

// ============ 骨架屏：卡片 ============
export function DeviceCardSkeleton() {
  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-card px-6 py-5">
      <div className="flex items-center gap-4">
        <div className="h-11 w-11 shrink-0 rounded-lg skeleton-shimmer" />
        <div className="flex-1 space-y-2.5">
          <div className="h-4 w-1/4 rounded skeleton-shimmer" />
          <div className="h-3 w-2/5 rounded skeleton-shimmer" />
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <div className="h-7 w-16 rounded-md skeleton-shimmer" />
          <div className="h-7 w-16 rounded-md skeleton-shimmer" />
          <div className="h-7 w-7 rounded-md skeleton-shimmer" />
        </div>
      </div>
    </div>
  )
}

// ============ 骨架屏：表格 ============
export function DeviceTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full min-w-[1000px] table-fixed border-collapse text-sm">
        <thead className="bg-card text-muted-foreground">
          <tr>
            {['ID', '设备名称', '类型', '厂商', 'API 地址', '状态', '动作数', '今日调用', '最后心跳', '操作'].map(
              (h, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <th key={i} className="px-4 py-3 text-left font-medium">
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3, 4].map((i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i} className="border-t border-border">
              <td colSpan={10} className="px-4 py-3">
                <div className="h-4 w-full rounded skeleton-shimmer" style={{ opacity: 1 - i * 0.15 }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============ 设备卡片组件 ============
export function DeviceCard({
  device,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onTest,
  testing,
  actions,
  loadingActions,
  onEditAction,
  onDeleteAction,
  onTestAction,
  onToggleAction,
  onNewAction,
  onActionHistory,
  togglingActionId,
  checked,
  onToggleCheck,
}) {
  const api_url = device.api_url || ''
  const tags = parseTags(device.tags)

  return (
    <div
      className={`card-hover w-full overflow-hidden rounded-lg border backdrop-blur-sm transition-colors ${
        expanded
          ? 'border-primary/60 bg-primary/5 shadow-[0_0_0_1px_color-mix(in_oklch,var(--ring)_15%,transparent),0_8px_24px_-12px_rgba(0,0,0,0.4)]'
          : 'border-border bg-card hover:border-primary/40'
      }`}
    >
      {/* 设备行 */}
      <div
        className="flex cursor-pointer items-center gap-4 px-6 py-5"
        onClick={() => onToggleExpand(device)}
      >
        {typeof checked === 'boolean' && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggleCheck?.(device, e.shiftKey)}
            title="勾选以选择（Shift 可连续多选）"
          />
        )}
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/15 text-primary">
          <DeviceTypeIcon type={device.type} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{device.name}</span>
            <span className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              #{device.id}
            </span>
            <span className="whitespace-nowrap rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {DEVICE_TYPE_LABELS[device.type] || device.type}
            </span>
            {device.vendor && (
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {device.vendor}
              </span>
            )}
            <StatusBadge status={device.status || (device.enabled ? 'unconfigured' : 'disabled')} />
            {tags.map((t) => (
              <span
                key={t}
                className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {device.ip_address && (
              <>
                <span className="truncate font-mono" title={`IP: ${device.ip_address}`}>
                  {device.ip_address}
                </span>
                <span className="text-muted-foreground">·</span>
              </>
            )}
            <span
              className="truncate font-mono"
              title={api_url || '未配置 API 地址'}
              style={{ maxWidth: 360 }}
            >
              {api_url ? (
                truncate(api_url, 30)
              ) : (
                <span className="text-destructive">未配置</span>
              )}
            </span>
            <span className="text-muted-foreground">·</span>
            <span title="动作总数">
              动作 <NumCell value={device.action_count} className="!text-[11px]" title="未统计动作数" />
            </span>
            <span className="text-muted-foreground">·</span>
            <span title="今日 API 调用次数">
              今日 <NumCell value={device.today_call_count} className="!text-[11px]" title="今日暂无调用" /> 次
            </span>
            {device.last_heartbeat && (
              <>
                <span className="text-muted-foreground">·</span>
                <span title={fmtTime(device.last_heartbeat)}>
                  心跳 {fmtRelative(device.last_heartbeat)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onTest(device)}
            disabled={testing}
            className="btn-secondary btn-sm"
            title="测试连接"
          >
            {testing ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Wifi className="h-3 w-3" />
            )}
            测试
          </button>
          <button type="button" onClick={() => onEdit(device)} className="btn-secondary btn-sm">
            编辑
          </button>
          <button type="button" onClick={() => onDelete(device)} className="btn-danger btn-sm">
            删除
          </button>
          <button
            type="button"
            onClick={() => onToggleExpand(device)}
            className="btn-secondary btn-sm"
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* 动作列表（展开时显示） */}
      {expanded && (
        <div className="expand-in border-t border-border bg-background px-6 py-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              设备动作（{loadingActions ? '...' : actions.length} 个）
            </h3>
            <button type="button" onClick={() => onNewAction()} className="btn-primary btn-sm">
              <Plus className="mr-1 h-3 w-3" /> 新建动作
            </button>
          </div>
          <ActionTable
            actions={actions}
            loading={loadingActions}
            onEdit={onEditAction}
            onDelete={onDeleteAction}
            onTest={onTestAction}
            onToggle={onToggleAction}
            onHistory={onActionHistory}
            togglingActionId={togglingActionId}
          />
        </div>
      )}
    </div>
  )
}

// ============ 动作表格 ============
export function ActionTable({
  actions,
  loading,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  onHistory,
  togglingActionId,
}) {
  if (loading) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        {[0, 1, 2].map((i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="h-8 w-full rounded skeleton-shimmer" style={{ opacity: 1 - i * 0.2 }} />
        ))}
      </div>
    )
  }
  if (actions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card py-8 text-center">
        <div className="text-xs text-muted-foreground">该设备暂无动作</div>
        <div className="mt-1 text-[11px] text-muted-foreground">点击右上角「新建动作」添加自动化操作</div>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="table-stagger w-full min-w-[1100px] table-fixed border-collapse text-sm">
        <thead className="bg-card text-muted-foreground">
          <tr>
            <th className="w-16 px-3 py-2.5 text-left font-medium">ID</th>
            <th className="w-40 px-3 py-2.5 text-left font-medium">动作名称</th>
            <th className="w-20 px-3 py-2.5 text-left font-medium">分类</th>
            <th className="w-16 px-3 py-2.5 text-left font-medium">方法</th>
            <th className="px-3 py-2.5 text-left font-medium">API 路径</th>
            <th className="w-16 px-3 py-2.5 text-left font-medium">版本</th>
            <th className="w-28 px-3 py-2.5 text-left font-medium">最后调用</th>
            <th className="w-16 px-3 py-2.5 text-right font-medium">24h调用</th>
            <th className="w-16 px-3 py-2.5 text-right font-medium">成功率</th>
            <th className="w-16 px-3 py-2.5 text-right font-medium">平均响应</th>
            <th className="w-16 px-3 py-2.5 text-center font-medium">风险</th>
            <th className="w-16 px-3 py-2.5 text-center font-medium">启用</th>
            <th className="w-56 px-3 py-2.5 text-left font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a, idx) => {
            const rate = successRate(a)
            return (
              <tr
                key={a.id}
                className={`table-row-hover border-t border-border hover:bg-accent ${idx % 2 === 0 ? 'bg-card' : ''}`}
              >
                <td className="px-3 py-2.5 font-mono text-primary">#{a.id}</td>
                <td className="truncate px-3 py-2.5 text-foreground" title={a.name}>
                  {a.name}
                </td>
                <td className="px-3 py-2.5">
                  <CategoryBadge category={a.category} />
                </td>
                <td className="px-3 py-2.5">
                  <MethodBadge method={a.http_method} />
                </td>
                <td className="truncate px-3 py-2.5 font-mono text-muted-foreground" title={a.api_path}>
                  {a.api_path || '-'}
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                  v{a.version || 1}
                </td>
                <td className="px-3 py-2.5 text-[11px] text-muted-foreground" title={fmtTime(a.last_call_at)}>
                  {fmtRelative(a.last_call_at)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <NumCell value={a.call_count_24h} className="!text-[11px]" title="24h 内暂无调用" />
                </td>
                <td className="px-3 py-2.5 text-right">
                  {rate == null ? (
                    <span className="text-[11px] text-muted-foreground" title="24h 内暂无调用，未统计成功率">
                      --
                    </span>
                  ) : (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${
                        rate >= 0.9
                          ? 'bg-success/20 text-success'
                          : rate >= 0.5
                          ? 'bg-warning/20 text-warning'
                          : 'bg-destructive/20 text-destructive'
                      }`}
                    >
                      {(rate * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {a.avg_latency_ms != null ? (
                    <span className={a.avg_latency_ms === 0 ? 'text-muted-foreground' : ''}>
                      {a.avg_latency_ms}ms
                    </span>
                  ) : (
                    <span className="text-muted-foreground" title="未统计">
                      --
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <RiskBadge level={a.risk_level} />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <Switch
                    checked={!!a.enabled}
                    onChange={() => onToggle(a)}
                    disabled={togglingActionId === a.id}
                    size="sm"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onTest(a)}
                      className="btn-secondary btn-sm shrink-0"
                      title="测试动作"
                    >
                      <TestTube className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onHistory(a)}
                      className="btn-secondary btn-sm shrink-0"
                      title="执行历史"
                    >
                      <History className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(a)}
                      className="btn-secondary btn-sm shrink-0"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      className="btn-danger btn-sm shrink-0"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ============ 设备列表行（用于分栏视图） ============
export function DeviceRow({
  device,
  selected,
  onClick,
  onTest,
  testing,
  checked,
  onToggleCheck,
}) {
  return (
    <div
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-3 border-b border-border px-3 py-3 transition-colors ${
        selected
          ? 'border-l-2 border-l-primary bg-primary/10'
          : 'border-l-2 border-l-transparent hover:bg-accent'
      }`}
    >
      {typeof checked === 'boolean' && (
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleCheck?.(device, e.shiftKey)}
          title="勾选以选择（Shift 可连续多选）"
        />
      )}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <DeviceTypeIcon type={device.type} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-sm ${selected ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>
            {device.name}
          </span>
          <StatusBadge status={device.status || (device.enabled ? 'unconfigured' : 'disabled')} />
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {device.api_url ? truncate(device.api_url, 30) : '未配置'}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onTest(device)
        }}
        disabled={testing}
        className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-40"
        title="测试连接"
      >
        {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
