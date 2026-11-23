// 工单抄送对象选择与展示（流程模板编辑 / 发起弹窗 / 工单详情共用）
// - CcChips：抄送对象 chips 展示（类型徽标 + 名称，可选来源徽标与移除）
// - CcSelectModal：人员 + 工单分组混合勾选弹窗（数据源 /users + /ticket-config/groups）
import { useEffect, useMemo, useState } from 'react'
import { Search, UserRound, UsersRound, X, ChevronUp } from 'lucide-react'
import { Modal } from './Dialog'
import { Button } from './ui'
import { inputBaseCls } from './property/FormControls'
import { toast } from '../store/toastStore'
import ticketApi from '../api/tickets'

// 抄送对象类型元信息（user=人员 / group=工单分组）
export const CC_TYPE_META = {
  user: { label: '人员', cls: 'bg-blue-500/10 text-blue-500' },
  group: { label: '分组', cls: 'bg-violet-500/10 text-violet-500' },
}

export const ccKey = (t) => `${t.type}:${t.id}`

// chips 展示：{type,id,name}[]；onRemove 提供时显示移除按钮；source 提供时显示来源徽标
// max（>0）时超出部分折叠为「+N」计数 pill：悬停 tooltip 列出全部隐藏名单，点击展开/收起，
// 防止大量对象把页面刷成一片人名
export function CcChips({ targets, onRemove, showSource, emptyText, max = 0 }) {
  const [expanded, setExpanded] = useState(false)
  const list = targets || []
  if (!list.length) {
    return <span className="text-xs text-muted-foreground">{emptyText || '暂无抄送对象'}</span>
  }
  const collapsed = max > 0 && list.length > max && !expanded
  const shown = collapsed ? list.slice(0, max) : list
  const hidden = collapsed ? list.slice(max) : []
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((t) => (
        <span
          key={ccKey(t)}
          className={`inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium ${CC_TYPE_META[t.type]?.cls || 'text-muted-foreground'}`}
          title={showSource && t.source === 'template' ? '模板固定抄送' : undefined}
        >
          {t.type === 'group' ? <UsersRound className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
          {t.name || `${CC_TYPE_META[t.type]?.label || t.type}${t.id}`}
          {showSource && t.source === 'template' && (
            <span className="rounded bg-muted px-1 text-xs leading-none text-muted-foreground">模板</span>
          )}
          {onRemove && (
            <button
              type="button"
              className="rounded-full p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              title={`移除抄送：${t.name}`}
              onClick={(e) => { e.stopPropagation(); onRemove(t) }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {max > 0 && list.length > max && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium transition ${collapsed ? 'bg-muted text-muted-foreground hover:border-primary/50 hover:text-primary' : 'text-muted-foreground hover:border-destructive/40 hover:text-destructive'}`}
          title={collapsed ? `共 ${list.length} 项，还有：${hidden.map((t) => t.name).join('、')}` : '收起展开的名单'}
        >
          {collapsed ? `+${hidden.length}` : (<><ChevronUp className="h-3 w-3" />收起</>)}
        </button>
      )}
    </div>
  )
}

// 人员 + 分组混合勾选弹窗；确认回调 targets: [{type, id, name}]
// groupsOnly=true 时仅展示工单分组（隐藏人员区），供「发起分组」等纯分组场景复用
export function CcSelectModal({ open, onClose, onConfirm, excludeKeys = [], title = '选择抄送对象', groupsOnly = false }) {
  const [users, setUsers] = useState([])
  const [groups, setGroups] = useState([])
  const [selected, setSelected] = useState([])
  const [kw, setKw] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelected([])
    setKw('')
    setLoading(true)
    // 统一走 /tickets/cc-options（ticket:view 即可），普通工单用户也能选择抄送对象
    ticketApi.ccOptions()
      .then((res) => {
        setUsers((res.users || []).filter((x) => x.is_active !== false))
        setGroups((res.groups || []).filter((x) => x.enabled !== false))
      })
      .catch((e) => toast.error(e.message || '加载人员与分组失败'))
      .finally(() => setLoading(false))
  }, [open])

  const exclude = useMemo(() => new Set(excludeKeys), [excludeKeys])
  const kwLower = kw.trim().toLowerCase()
  const filtUsers = users.filter((u) => {
    if (exclude.has(`user:${u.id}`)) return false
    if (!kwLower) return true
    const name = u.display_name || u.username || ''
    return name.toLowerCase().includes(kwLower) || (u.username || '').toLowerCase().includes(kwLower)
  })
  const filtGroups = groups.filter((g) => {
    if (exclude.has(`group:${g.id}`)) return false
    if (!kwLower) return true
    return (g.name || '').toLowerCase().includes(kwLower)
  })

  const toggle = (t) => {
    setSelected((s) => s.some((x) => ccKey(x) === ccKey(t))
      ? s.filter((x) => ccKey(x) !== ccKey(t))
      : [...s, t])
  }

  const handleConfirm = () => {
    onConfirm(selected)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${inputBaseCls} h-9 pl-9`}
              placeholder={groupsOnly ? '搜索分组名称' : '搜索人员或分组名称'}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">已选 {selected.length} 项</span>
        </div>

        <div className="max-h-72 space-y-4 overflow-y-auto rounded-md border border-border p-3">
          {loading && <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>}
          {!loading && (
            <>
              <div>
                <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <UsersRound className="h-3.5 w-3.5" />{groupsOnly ? '工单分组' : '工单分组（组内全员均收到抄送）'}
                </div>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {filtGroups.map((g) => {
                    const on = selected.some((x) => x.type === 'group' && x.id === g.id)
                    return (
                      <label key={g.id} className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition ${on ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-primary"
                            checked={on}
                            onChange={() => toggle({ type: 'group', id: g.id, name: g.name })}
                          />
                          <span className="truncate" title={g.name}>{g.name}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{g.member_count ?? '--'} 人</span>
                      </label>
                    )
                  })}
                  {!filtGroups.length && <div className="col-span-2 py-2 text-center text-xs text-muted-foreground">暂无可选分组</div>}
                </div>
              </div>
              {!groupsOnly && (
              <div>
                <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <UserRound className="h-3.5 w-3.5" />人员
                </div>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {filtUsers.map((u) => {
                    const on = selected.some((x) => x.type === 'user' && x.id === u.id)
                    const name = u.display_name || u.username
                    return (
                      <label key={u.id} className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition ${on ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-primary"
                            checked={on}
                            onChange={() => toggle({ type: 'user', id: u.id, name })}
                          />
                          <span className="truncate" title={`${name}（${u.username}）`}>{name}</span>
                        </span>
                        <span className="shrink-0 truncate text-xs text-muted-foreground">{u.role_name || u.role || ''}</span>
                      </label>
                    )
                  })}
                  {!filtUsers.length && <div className="col-span-2 py-2 text-center text-xs text-muted-foreground">暂无可选人员</div>}
                </div>
              </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!selected.length} onClick={handleConfirm}>
            {groupsOnly ? '确认' : '确认抄送'}（{selected.length}）
          </Button>
        </div>
      </div>
    </Modal>
  )
}
