// 报告配置列表：选择模板创建配置，进入配置向导（采集 + 映射 + 预览发布）
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Plus, RefreshCw, Search, Settings2, Trash2 } from 'lucide-react'
import { reportApi } from '../../api/reports'
import {
  Button, Card, CompactSelect, DataTable, PageContainer, PageHeader, Pagination, SearchInput,
} from '../../components/ui'
import { Modal } from '../../components/Dialog'
import { confirm } from '../../components/ConfirmDialog'
import { toast } from '../../store/toastStore'
import { hasPermission } from '../../utils/permissions'
import { CONFIG_STATUS, Field, StatusOf, fmtTime, inputCls } from './shared'

const PAGE_SIZE = 20

export default function ReportConfigs() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  const [templates, setTemplates] = useState([])
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ template_id: '', name: '', description: '' })
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneTarget, setCloneTarget] = useState(null)
  const [cloneName, setCloneName] = useState('')
  const [cloning, setCloning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await reportApi.configs.list({ keyword, status, page, page_size: pageSize })
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message || '配置列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [keyword, status, page, pageSize])

  useEffect(() => { load() }, [load])

  const loadTemplates = async () => {
    try {
      const data = await reportApi.templates.list({ page: 1, page_size: 100 })
      setTemplates(data.items || [])
    } catch (err) {
      toast.error(err.message || '模板列表加载失败')
    }
  }

  const openCreate = async () => {
    setCreateOpen(true)
    if (!templates.length) await loadTemplates()
  }

  const submitCreate = async () => {
    if (!form.template_id) {
      toast.warning('请选择报告模板')
      return
    }
    if (!form.name.trim()) {
      toast.warning('配置名称不能为空')
      return
    }
    setCreating(true)
    try {
      const created = await reportApi.configs.create({
        template_id: Number(form.template_id),
        name: form.name,
        description: form.description,
      })
      toast.success('配置已创建，开始完成采集与映射')
      setCreateOpen(false)
      setForm({ template_id: '', name: '', description: '' })
      navigate(`/reports/configs/${created.id}`)
    } catch (err) {
      toast.error(err.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const openClone = (row) => {
    setCloneTarget(row)
    setCloneName(`${row.name} - 副本`)
    setCloneOpen(true)
  }

  const submitClone = async () => {
    if (!cloneName.trim()) {
      toast.warning('配置名称不能为空')
      return
    }
    setCloning(true)
    try {
      const created = await reportApi.configs.clone(cloneTarget.id, { name: cloneName })
      toast.success('已复制配置')
      setCloneOpen(false)
      setCloneTarget(null)
      navigate(`/reports/configs/${created.id}`)
    } catch (err) {
      toast.error(err.message || '复制失败')
    } finally {
      setCloning(false)
    }
  }

  const disable = async (row) => {
    const ok = await confirm({
      title: '停用报告配置',
      description: `停用后该配置不可再触发运行，确认停用「${row.name}」？`,
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
    try {
      await reportApi.configs.disable(row.id)
      toast.success('已停用')
      load()
    } catch (err) {
      toast.error(err.message || '停用失败')
    }
  }

  const templateName = useMemo(() => {
    const map = new Map(templates.map((t) => [t.id, t.name]))
    return (id) => map.get(id) || `#${id}`
  }, [templates])

  const columns = useMemo(() => [
    {
      key: 'name',
      header: '配置名称',
      width: '22%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{row.name}</div>
          <div className="truncate text-xs text-muted-foreground">{row.description || '—'}</div>
        </div>
      ),
    },
    {
      key: 'template',
      header: '模板',
      width: '20%',
      render: (row) => row.template_name || templateName(row.template_id),
    },
    {
      key: 'status',
      header: '状态',
      width: '10%',
      render: (row) => <StatusOf map={CONFIG_STATUS} value={row.status} />,
    },
    {
      key: 'schedule',
      header: '定时',
      width: '14%',
      render: (row) => (row.schedule_cron
        ? <span className="font-mono text-xs">{row.schedule_cron}</span>
        : '手动'),
    },
    { key: 'updated_at', header: '更新时间', width: '16%', render: (row) => fmtTime(row.updated_at) },
    {
      key: 'actions',
      header: '操作',
      width: '18%',
      render: (row) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/reports/configs/${row.id}`)}>
            <Settings2 className="mr-1 h-3.5 w-3.5" />配置
          </Button>
          {hasPermission('report', 'edit') && (
            <Button size="sm" variant="ghost" onClick={() => openClone(row)}>
              <Copy className="mr-1 h-3.5 w-3.5" />复制
            </Button>
          )}
          {hasPermission('report', 'delete') && row.status !== 'disabled' && (
            <Button size="sm" variant="ghost" onClick={() => disable(row)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ], [navigate, templateName])

  return (
    <PageContainer>
      <PageHeader
        title="报告配置"
        actions={(
          <>
            <Button variant="ghost" onClick={load} loading={loading}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />刷新
            </Button>
            {hasPermission('report', 'edit') && (
              <Button variant="primary" onClick={openCreate}>
                <Plus className="mr-1 h-4 w-4" />新建配置
              </Button>
            )}
          </>
        )}
      />

      <Card bodyClassName="p-3" className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            className="w-[220px]"
            placeholder="搜索配置名称"
            value={keyword}
            onChange={(v) => { setKeyword(v); setPage(1) }}
            onClear={() => { setKeyword(''); setPage(1) }}
          />
          <CompactSelect value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="disabled">已停用</option>
          </CompactSelect>
        </div>
      </Card>

      <Card bodyClassName="p-0">
        <DataTable
          columns={columns}
          data={items}
          loading={loading}
          rowKey="id"
          onRowClick={(row) => navigate(`/reports/configs/${row.id}`)}
          emptyText="暂无报告配置"
          emptyDescription="先准备报告模板，再为模板创建数据采集与映射配置"
          emptyAction={hasPermission('report', 'edit') ? (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />新建配置
            </Button>
          ) : null}
        />
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
        />
      </Card>

      <Modal
        open={createOpen}
        title="新建报告配置"
        onClose={() => setCreateOpen(false)}
        footer={(
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" loading={creating} onClick={submitCreate}>创建并配置</Button>
          </>
        )}
      >
        <Field label="报告模板" required hint="仅显示已发布模板；草稿模板需先在模板库发布">
          <CompactSelect block value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
            <option value="">请选择模板</option>
            {templates.filter((t) => t.status === 'published').map((t) => (
              <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>
            ))}
          </CompactSelect>
        </Field>
        <Field label="配置名称" required hint="建议包含报告周期或业务范围，如「安全运营周报-华东区」">
          <input
            className={inputCls}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="描述">
          <textarea
            className={inputCls}
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={cloneOpen}
        title="复制报告配置"
        onClose={() => setCloneOpen(false)}
        footer={(
          <>
            <Button onClick={() => setCloneOpen(false)}>取消</Button>
            <Button variant="primary" loading={cloning} onClick={submitClone}>复制</Button>
          </>
        )}
      >
        <Field label="新配置名称" required hint={`将复制「${cloneTarget?.name || ''}」的模板、数据源、映射与参数，生成草稿配置`}>
          <input
            className={inputCls}
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
        </Field>
      </Modal>
    </PageContainer>
  )
}
