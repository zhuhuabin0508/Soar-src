import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  BookOpen, FileText, Paperclip, Globe, Settings, ClipboardList, RefreshCw, Lightbulb,
  Check, X, Loader2, File, Sheet, Braces, FileCode, AlertTriangle,
  ChevronDown, ChevronRight, ChevronUp,
  Search, ArrowUpDown, Database, ShieldCheck, Activity, Zap, Target, Share2, Download, EyeOff, Plus,
} from 'lucide-react'
import { knowledgeBases as kbApi, llmConfigs as llmApi } from '../api/client'
import { Modal } from '../components/Dialog'
import { confirm } from '../components/ConfirmDialog'
import { toast } from '../store/toastStore'
import { inputCls, textareaCls, inputBaseCls } from '../components/property/FormControls'
import { TutorialButton, TutorialDrawer } from '../components/TutorialDrawer'
import { KNOWLEDGE_BASE_TUTORIAL } from '../components/tutorialContent'
import InfoTip from '../components/InfoTip'
import { hasPermission, canEditResource, canManageShare } from '../utils/permissions'
import ShareDialog from '../components/ShareDialog'
import BatchShareDialog from '../components/BatchShareDialog'
import { useSelection } from '../hooks/useSelection'
import BatchActions from '../components/BatchActions'
import {CompactSelect, DatePicker, AutoGrowTextarea } from '../components/ui'

// 格式化时间
function fmtTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return t
  }
}

// 相对时间（如「2 小时前」）
function relTime(t) {
  if (!t) return '-'
  try {
    const diff = Date.now() - new Date(t).getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`
    return fmtTime(t)
  } catch { return t }
}

// 知识库健康状态指示
function kbHealthStatus(kb) {
  const docCount = kb.doc_count ?? 0
  if (docCount === 0) return { label: '空', color: 'bg-muted-foreground', text: 'text-muted-foreground' }
  // 如果有 failed_docs 字段且 > 0，显示失败
  if (kb.failed_docs > 0) return { label: '部分失败', color: 'bg-destructive', text: 'text-destructive' }
  return { label: '正常', color: 'bg-emerald-500', text: 'text-emerald-500' }
}

// 根据文件扩展名映射徽章图标与标签
function fileBadge(fileType) {
  const ft = (fileType || '').toLowerCase().replace(/^\./, '')
  const map = {
    pdf: { icon: <FileText className="inline h-3 w-3" />, label: 'PDF' },
    txt: { icon: <File className="inline h-3 w-3" />, label: 'TXT' },
    md: { icon: <File className="inline h-3 w-3" />, label: 'MD' },
    csv: { icon: <Sheet className="inline h-3 w-3" />, label: 'CSV' },
    xls: { icon: <Sheet className="inline h-3 w-3" />, label: 'XLS' },
    xlsx: { icon: <Sheet className="inline h-3 w-3" />, label: 'XLSX' },
    doc: { icon: <FileText className="inline h-3 w-3" />, label: 'DOC' },
    docx: { icon: <FileText className="inline h-3 w-3" />, label: 'DOCX' },
    json: { icon: <Braces className="inline h-3 w-3" />, label: 'JSON' },
    html: { icon: <FileCode className="inline h-3 w-3" />, label: 'HTML' },
    htm: { icon: <FileCode className="inline h-3 w-3" />, label: 'HTML' },
  }
  return map[ft] || { icon: <File className="inline h-3 w-3" />, label: (ft || 'FILE').toUpperCase() }
}

// 分段模式选项（5种，对标 Dify）
const CHUNK_MODES = [
  { value: 'auto', label: '自动解析', hint: '按段落/标点切分；Markdown 有标题时按标题切分（接近 Dify / LangChain）' },
  { value: 'heading', label: '按标题切分', hint: '按 Markdown # 标题分块，适合手册、方案、技术文档（FastGPT / RAGFlow 常用）' },
  { value: 'line', label: '按行切分', hint: '每行或每N行一段，适合 IP 列表、日志、CSV 表格等行级数据' },
  { value: 'fixed_length', label: '按固定长度切分', hint: '设置每个块的最大字符数，如 500' },
  { value: 'delimiter', label: '按分隔符切分', hint: '自定义分隔符（如 \\n\\n、---），适合结构化文档' },
  { value: 'qa', label: 'Q&A 模式提取', hint: '自动识别问题和答案分别切块，适合 FAQ 文档' },
]

// 索引模式选项
const INDEX_MODES = [
  { value: 'keyword', label: '关键词检索', hint: '纯 BM25，适合代码、编号、专有名词精确匹配' },
  { value: 'vector', label: '向量检索', hint: '纯 Embedding，适合自然语言语义理解' },
  { value: 'hybrid', label: '混合检索（推荐）', hint: '兼顾语义和关键词，精准度最高' },
]

// Embedding 模型选项（标注特长）—— 仅用于维度参考，知识库实际从模型设置中选择已配置的嵌入模型
const EMBEDDING_MODELS = [
  { value: 'text-embedding-ada-002', label: 'OpenAI ada-002', specialty: '通用', dim: 1536, hint: 'OpenAI 经典模型，英文/多语言通用' },
  { value: 'text-embedding-3-small', label: 'OpenAI 3-small', specialty: '通用·轻量', dim: 1536, hint: '性价比高，支持动态降维' },
  { value: 'text-embedding-3-large', label: 'OpenAI 3-large', specialty: '高精度', dim: 3072, hint: '精度最高，支持动态降维到 256/768/1536' },
  { value: 'bge-large-zh', label: 'BAAI bge-large-zh', specialty: '中文', dim: 1024, hint: '中文语义检索效果最佳' },
  { value: 'bge-m3', label: 'BAAI bge-m3', specialty: '多语言', dim: 1024, hint: '支持 100+ 语言，跨语言检索强' },
  { value: 'm3e-base', label: 'm3e-base', specialty: '中文·开源', dim: 768, hint: '开源中文模型，适合本地部署' },
  { value: 'embedding-2', label: '智谱 embedding-2', specialty: '中文', dim: 1024, hint: '智谱国产模型，中文效果好' },
  { value: 'volcengine-doubao-embedding', label: '火山引擎 Doubao Embedding', specialty: '中文', dim: 2048, hint: '火山引擎国产模型' },
]

// 常见 Embedding 模型默认向量维度映射（选择嵌入配置时自动填充维度，未知模型默认 1024）
const EMBEDDING_DIM_BY_MODEL = EMBEDDING_MODELS.reduce((acc, m) => {
  acc[m.value] = m.dim
  return acc
}, {})

// Rerank 重排序模型选项
const RERANK_MODELS = [
  { value: 'bge-reranker-v2-m3', label: 'BAAI bge-reranker-v2-m3', hint: '多语言，业界主流重排序模型' },
  { value: 'bge-reranker-large', label: 'BAAI bge-reranker-large', hint: '中英双语，精度高' },
  { value: 'cohere-rerank-3', label: 'Cohere Rerank 3', hint: '商用 API，多语言支持' },
  { value: 'jina-reranker-v2', label: 'Jina jina-reranker-v2', hint: '开源，支持 8K 上下文' },
]

// 知识库编辑/新建弹窗（含 Dify 风格配置）
function KBFormModal({ open, initial, onClose, onSubmit, saving }) {
  // 嵌入模型配置列表（从模型设置中 model_type=embedding 的 LLM 配置拉取）
  const [embeddingConfigs, setEmbeddingConfigs] = useState([])
  const [loadingConfigs, setLoadingConfigs] = useState(false)

  const [createFiles, setCreateFiles] = useState([])

  const [form, setForm] = useState(() => ({
    name: '',
    description: '',
    chunk_mode: 'auto',
    chunk_size: 500,
    chunk_overlap: 50,
    chunk_delimiter: '\n\n',
    ocr_enabled: false,
    index_mode: 'hybrid',
    embedding_model: 'text-embedding-ada-002',
    embedding_config_id: null,
    embedding_dimension: 1536,
    retrieval_top_k: 5,
    score_threshold: 55,
    rerank_enabled: true,
    rerank_model: 'bge-reranker-v2-m3',
    hybrid_vector_weight: 70,
    hybrid_keyword_weight: 30,
    ...(initial || {}),
  }))

  // 弹窗打开时拉取嵌入模型配置列表
  useEffect(() => {
    if (!open) return
    setLoadingConfigs(true)
    llmApi.list()
      .then((data) => {
        const list = Array.isArray(data) ? data.filter((c) => (c.model_type || 'chat') === 'embedding') : []
        setEmbeddingConfigs(list)
      })
      .catch(() => setEmbeddingConfigs([]))
      .finally(() => setLoadingConfigs(false))
  }, [open])

  useEffect(() => {
    if (open) {
      setCreateFiles([])
      setForm({
        name: '',
        description: '',
        chunk_mode: 'auto',
        chunk_size: 500,
        chunk_overlap: 50,
        chunk_delimiter: '\n\n',
        ocr_enabled: false,
        index_mode: 'hybrid',
        embedding_model: 'text-embedding-ada-002',
        embedding_config_id: null,
        embedding_dimension: 1536,
        retrieval_top_k: 5,
        score_threshold: 55,
        rerank_enabled: true,
        rerank_model: 'bge-reranker-v2-m3',
        hybrid_vector_weight: 70,
        hybrid_keyword_weight: 30,
        ...(initial || {}),
      })
    }
  }, [open, initial])

  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }))
  const needEmbedding = form.index_mode === 'vector' || form.index_mode === 'hybrid'
  const isHybrid = form.index_mode === 'hybrid'
  // 当前选中的 Embedding 配置（从模型设置中选取）
  const selectedEmbCfg = embeddingConfigs.find((c) => c.id === form.embedding_config_id) || null
  const selectedChunkMode = CHUNK_MODES.find((m) => m.value === form.chunk_mode)
  const selectedIndex = INDEX_MODES.find((m) => m.value === form.index_mode)

  // 选择嵌入模型配置时：自动填充 model_name（兜底用）与维度
  const onEmbConfigChange = (configId) => {
    const cfg = embeddingConfigs.find((c) => c.id === Number(configId))
    setForm((p) => ({
      ...p,
      embedding_config_id: configId ? Number(configId) : null,
      embedding_model: cfg?.model_name || p.embedding_model,
      embedding_dimension: cfg ? (EMBEDDING_DIM_BY_MODEL[cfg.model_name] || 1024) : p.embedding_dimension,
    }))
  }

  // 混合检索权重联动（两者之和 = 100）
  const onVectorWeightChange = (val) => {
    const v = Math.max(0, Math.min(100, val))
    setForm((p) => ({ ...p, hybrid_vector_weight: v, hybrid_keyword_weight: 100 - v }))
  }

  // 资源级 owner 控制：新建允许编辑；已存在资源按 can_edit 标志
  const canEdit = !initial || canEditResource(initial)

  return (
    <Modal
      open={open}
      title={initial ? `编辑知识库：${initial.name || ''}` : '新建知识库'}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit(form, createFiles)}
            disabled={saving || !form.name || !canEdit}
            title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}
            className="btn-primary"
          >
            {saving ? '保存中…' : initial ? '保存' : (createFiles.length ? `创建并上传 ${createFiles.length} 个文件` : '创建')}
          </button>
        </>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        {/* 基本信息 */}
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">基本信息</h3>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">名称 <span className="text-destructive">*</span></div>
              <input className={inputCls} value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="知识库名称" />
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">描述</div>
              <input className={inputCls} value={form.description} onChange={(e) => set('description')(e.target.value)} placeholder="可选" />
            </label>
          </div>
        </div>

        {!initial && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">初始文档（可选）</h3>
            <input
              type="file"
              multiple
              className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-primary"
              onChange={(e) => setCreateFiles(Array.from(e.target.files || []))}
            />
            <div className="text-[11px] text-muted-foreground">
              支持同时选择多个 PDF / Word / Excel / TXT / Markdown / CSV。创建后仍可继续追加。
            </div>
            {createFiles.length > 0 && (
              <ul className="max-h-28 overflow-y-auto text-[11px] text-muted-foreground">
                {createFiles.map((f) => (
                  <li key={`${f.name}-${f.size}-${f.lastModified}`} className="truncate">
                    {f.name}（{(f.size / 1024).toFixed(1)} KB）
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ===== 分段设置 ===== */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">分段设置（解析与切片）</h3>
          {/* 数据类型快速选择：自动推荐分段模式 */}
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">数据类型（快速选择推荐方案）</div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'IP / 资产台账', mode: 'line', reason: '每行一条 IP/资产，按行切分精确匹配' },
                { label: 'FAQ / 问答对', mode: 'qa', reason: '自动识别问答结构，分别提取 Q 和 A' },
                { label: '普通文档', mode: 'auto', reason: '系统自动根据段落、标点切分' },
                { label: 'Markdown 手册', mode: 'heading', reason: '按 # 标题分块，适合方案/制度/技术文档' },
                { label: '日志文件', mode: 'fixed_length', reason: '按固定长度切分，适合结构化日志' },
              ].map((sc) => (
                <button
                  key={sc.mode}
                  type="button"
                  onClick={() => set('chunk_mode')(sc.mode)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    form.chunk_mode === sc.mode
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border bg-secondary text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  }`}
                  title={sc.reason}
                >
                  {sc.label}
                </button>
              ))}
            </div>
          </div>
          {/* 解析模式：卡片式单选 */}
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">解析模式 / 切片规则</div>
            <div className="grid grid-cols-2 gap-2">
              {CHUNK_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => set('chunk_mode')(m.value)}
                  className={`rounded-md border p-2 text-left transition ${
                    form.chunk_mode === m.value
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-muted hover:border-border'
                  }`}
                >
                  <div className="text-xs font-semibold text-foreground">{m.label}</div>
                  <div className="text-[10px] text-muted-foreground">{m.hint}</div>
                </button>
              ))}
            </div>
          </div>
          {selectedChunkMode && (
            <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
              <Lightbulb className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{selectedChunkMode.hint}</span>
            </p>
          )}

          {/* 分块大小 + 重叠度（非 auto 模式显示） */}
          {form.chunk_mode !== 'auto' && (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {form.chunk_mode === 'line' ? '每段行数' : '分块大小（字符）'}
                  <span className="text-muted-foreground">
                    {form.chunk_mode === 'line' ? ' 1=每行一段，建议 1-5' : ' 建议 300-1000'}
                  </span>
                </div>
                <input
                  type="number"
                  className={inputCls}
                  value={form.chunk_size}
                  onChange={(e) => set('chunk_size')(Number(e.target.value))}
                  min={form.chunk_mode === 'line' ? 1 : 100}
                  max={form.chunk_mode === 'line' ? 50 : 10000}
                />
              </label>
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {form.chunk_mode === 'line' ? '重叠行数' : '分块重叠度（字符）'}
                  <span className="text-muted-foreground">
                    {form.chunk_mode === 'line' ? ' 段间重叠的行数' : ' 建议块大小的 10%-20%'}
                  </span>
                </div>
                <input type="number" className={inputCls} value={form.chunk_overlap} onChange={(e) => set('chunk_overlap')(Number(e.target.value))} min={0} max={form.chunk_mode === 'line' ? 20 : 1000} />
              </label>
            </div>
          )}

          {/* 分隔符输入（delimiter 模式显示） */}
          {form.chunk_mode === 'delimiter' && (
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">自定义分隔符</div>
              <input className={inputCls} value={form.chunk_delimiter} onChange={(e) => set('chunk_delimiter')(e.target.value)} placeholder="如 \n\n、---、## 等" />
            </label>
          )}

          {/* OCR 开关 */}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.ocr_enabled} onChange={(e) => set('ocr_enabled')(e.target.checked)} className="h-4 w-4 accent-primary" />
            <span className="text-sm text-muted-foreground">OCR 识别（针对扫描版 PDF / 图片提取文字）</span>
          </label>
        </div>

        {/* ===== 索引设置 ===== */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">索引设置</h3>
          {/* 索引模式：卡片式单选（含场景说明） */}
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">检索策略</div>
            <div className="grid grid-cols-3 gap-2">
              {INDEX_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => set('index_mode')(m.value)}
                  className={`rounded-md border p-2 text-left transition ${
                    form.index_mode === m.value
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-muted hover:border-primary/40'
                  }`}
                >
                  <div className="text-xs font-semibold text-foreground">{m.label}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{m.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Embedding 模型选择（vector/hybrid 模式显示）—— 从模型设置中已配置的嵌入模型选取 */}
          {needEmbedding && (
            <>
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  嵌入模型配置 <span className="text-destructive">*</span>
                  <span className="ml-1 text-muted-foreground">（从「模型设置」中 model_type=embedding 的配置选取）</span>
                </div>
                <CompactSelect
                  size="lg"
                  block
                  value={form.embedding_config_id || ''}
                  onChange={(e) => onEmbConfigChange(e.target.value)}
                  disabled={loadingConfigs}
                >
                  <option value="">{loadingConfigs ? '加载中…' : '请选择嵌入模型配置'}</option>
                  {embeddingConfigs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.provider} · {c.model_name}）
                    </option>
                  ))}
                </CompactSelect>
              </label>
              {embeddingConfigs.length === 0 && !loadingConfigs && (
                <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>未找到已配置的嵌入模型。请先到「模型设置」页面添加 model_type=<span className="font-mono">embedding</span> 的 LLM 配置（如火山引擎 Doubao Embedding、OpenAI text-embedding-3-small 等），并测试通过后再回到此处选择。</span>
                </div>
              )}
              {selectedEmbCfg && (
                <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2">
                  <span className="rounded bg-primary/20 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    {selectedEmbCfg.provider}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    模型名：<span className="font-mono text-muted-foreground">{selectedEmbCfg.model_name || '-'}</span>
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Base URL: {selectedEmbCfg.base_url || '默认'}
                  </span>
                </div>
              )}
              <label>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  向量维度 <span className="text-muted-foreground">（部分模型支持动态降维，降低可减少存储/检索成本）</span>
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" className={inputCls} value={form.embedding_dimension} onChange={(e) => set('embedding_dimension')(Number(e.target.value))} min={256} max={8192} />
                  {selectedEmbCfg && form.embedding_dimension < (EMBEDDING_DIM_BY_MODEL[selectedEmbCfg.model_name] || 1024) && (
                    <span className="shrink-0 rounded bg-warning/20 px-2 py-0.5 text-[10px] text-warning">
                      已降维 {EMBEDDING_DIM_BY_MODEL[selectedEmbCfg.model_name] || 1024} → {form.embedding_dimension}
                    </span>
                  )}
                </div>
              </label>
            </>
          )}
          {!needEmbedding && (
            <p className="text-[11px] text-muted-foreground">关键词检索模式无需 Embedding 模型，使用 PostgreSQL 全文匹配。</p>
          )}

          {/* 混合检索权重（hybrid 模式显示） */}
          {isHybrid && (
            <div className="rounded-md border border-border bg-muted p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">融合权重（RRF）</div>
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-[11px] text-info">向量 {form.hybrid_vector_weight}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={form.hybrid_vector_weight}
                  onChange={(e) => onVectorWeightChange(Number(e.target.value))}
                  className="flex-1 accent-primary"
                />
                <span className="shrink-0 text-[11px] text-warning">关键词 {form.hybrid_keyword_weight}%</span>
              </div>
              <p className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground">
                <Lightbulb className="h-3 w-3 shrink-0 mt-0.5" />
                <span>向量擅长语义匹配，关键词擅长专有名词/编号。推荐 向量 70% | 关键词 30%</span>
              </p>
            </div>
          )}
        </div>

        {/* ===== 检索设置 ===== */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">检索设置（召回参数微调）</h3>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">召回 Top-K 数量 <span className="text-muted-foreground">建议 3-5</span></div>
              <input type="number" className={inputCls} value={form.retrieval_top_k} onChange={(e) => set('retrieval_top_k')(Number(e.target.value))} min={1} max={50} />
              <p className="mt-0.5 text-[10px] text-muted-foreground">过多易导致 LLM 抓错重点</p>
            </label>
            <label>
              <div className="mb-1 text-xs font-medium text-muted-foreground">相似度阈值 <span className="text-muted-foreground">0-100</span></div>
              <input type="number" className={inputCls} value={form.score_threshold} onChange={(e) => set('score_threshold')(Number(e.target.value))} min={0} max={100} />
              <p className="mt-0.5 text-[10px] text-muted-foreground">低于此分数的内容将被丢弃，防止幻觉</p>
            </label>
          </div>

          {/* Rerank 重排序模型 */}
          <div className="rounded-md border border-border bg-muted p-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.rerank_enabled} onChange={(e) => set('rerank_enabled')(e.target.checked)} className="h-4 w-4 accent-primary" />
              <span className="text-sm font-medium text-muted-foreground">Rerank 重排序模型</span>
              <span className="rounded bg-success/20 px-1.5 py-0.5 text-[10px] text-success">强烈推荐</span>
            </label>
            <p className="mt-1 ml-6 flex items-start gap-1 text-[10px] text-muted-foreground">
              <Lightbulb className="h-3 w-3 shrink-0 mt-0.5" />
              <span>向量检索充当"粗排"快速捞出 Top-K，Rerank 模型充当"精排"逐字交叉注意力打分，回答准确率通常提升 15%+</span>
            </p>
            {form.rerank_enabled && (
              <label className="mt-2 block">
                <div className="mb-1 text-xs font-medium text-muted-foreground">选择 Reranker 模型</div>
                <CompactSelect size="lg" block value={form.rerank_model} onChange={(e) => set('rerank_model')(e.target.value)}>
                  {RERANK_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </CompactSelect>
              </label>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// 文档编辑弹窗（含元数据）
function DocEditModal({ open, initial, onClose, onSubmit, saving, canEdit = true }) {
  const [form, setForm] = useState({
    title: '',
    content: '',
    description: '',
    category: '',
    retrieval_weight: 1,
  })

  useEffect(() => {
    if (open) {
      setForm({
        title: initial?.title || '',
        content: initial?.content || '',
        description: initial?.description || '',
        category: initial?.category || '',
        retrieval_weight: initial?.retrieval_weight ?? 1,
      })
    }
  }, [open, initial])

  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }))

  return (
    <Modal
      open={open}
      title={initial ? `编辑文档：${initial.title || ''}` : '编辑文档'}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit(form)}
            disabled={saving || !form.title || !canEdit}
            title={!canEdit ? '无编辑权限（仅 owner 或被授权用户可编辑）' : undefined}
            className="btn-primary"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">文档标题</div>
          <input
            className={inputCls}
            value={form.title}
            onChange={(e) => set('title')(e.target.value)}
          />
        </label>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">文档描述</div>
          <input
            className={inputCls}
            value={form.description}
            onChange={(e) => set('description')(e.target.value)}
            placeholder="可选，有助于语义检索"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">分类</div>
            <input
              className={inputCls}
              value={form.category}
              onChange={(e) => set('category')(e.target.value)}
              placeholder="如：产品手册"
            />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">检索权重（1-10）</div>
            <input
              type="number"
              className={inputCls}
              value={form.retrieval_weight}
              onChange={(e) => set('retrieval_weight')(Number(e.target.value))}
              min={1}
              max={10}
            />
          </label>
        </div>
        <label>
          <div className="mb-1 text-xs font-medium text-muted-foreground">文档内容</div>
          <AutoGrowTextarea
            className={`${textareaCls} resize-y font-mono`}
            rows={12}
            value={form.content}
            onChange={(e) => set('content')(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  )
}

// ===== 新增知识文档弹窗（5维度渐进式表单 + 实时预览） =====
function DocAddModal({ open, kbConfig, onClose, onSubmit, saving }) {
  const [sourceTab, setSourceTab] = useState('upload')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [uploadFiles, setUploadFiles] = useState([])
  const [webUrl, setWebUrl] = useState('')
  // 高级配置展开
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 解析与切片
  const [autoChunk, setAutoChunk] = useState(true)
  const [chunkSize, setChunkSize] = useState(kbConfig?.chunk_size || 500)
  const [chunkOverlap, setChunkOverlap] = useState(kbConfig?.chunk_overlap || 50)
  // 元数据
  const [category, setCategory] = useState('')
  const [tags, setTags] = useState([{ key: '', value: '' }])
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [effectiveTo, setEffectiveTo] = useState('')
  // 检索权重
  const [retrievalWeight, setRetrievalWeight] = useState(1)

  useEffect(() => {
    if (open) {
      setSourceTab('upload')
      setTitle('')
      setDescription('')
      setContent('')
      setUploadFiles([])
      setWebUrl('')
      setShowAdvanced(false)
      setAutoChunk(true)
      setChunkSize(kbConfig?.chunk_size || 500)
      setChunkOverlap(kbConfig?.chunk_overlap || 50)
      setCategory('')
      setTags([{ key: '', value: '' }])
      setEffectiveFrom('')
      setEffectiveTo('')
      setRetrievalWeight(1)
    }
  }, [open, kbConfig])

  // 实时预览切片效果
  const previewChunks = useMemo(() => {
    if (!content || autoChunk) return []
    const chunks = []
    const step = Math.max(1, chunkSize - chunkOverlap)
    for (let i = 0; i < content.length && chunks.length < 3; i += step) {
      chunks.push(content.slice(i, i + chunkSize))
    }
    return chunks
  }, [content, autoChunk, chunkSize, chunkOverlap])

  const totalChunks = useMemo(() => {
    if (!content || autoChunk) return 0
    const step = Math.max(1, chunkSize - chunkOverlap)
    return Math.ceil(content.length / step)
  }, [content, autoChunk, chunkSize, chunkOverlap])

  const canSubmit = () => {
    if (sourceTab === 'upload') return uploadFiles.length > 0
    if (sourceTab === 'web') return !!webUrl.trim()
    return !!content.trim()
  }

  const handleSubmit = () => {
    const tagObj = {}
    tags.forEach((t) => {
      if (t.key.trim()) tagObj[t.key.trim()] = t.value.trim()
    })
    const meta = {
      title: title || (uploadFiles[0]?.name || webUrl || '未命名文档'),
      description,
      category: category || null,
      tags: Object.keys(tagObj).length > 0 ? tagObj : null,
      effective_from: effectiveFrom || null,
      effective_to: effectiveTo || null,
      retrieval_weight: retrievalWeight,
    }
    if (sourceTab === 'text') {
      onSubmit({ ...meta, sourceType: 'text', content })
    } else if (sourceTab === 'upload') {
      onSubmit({ ...meta, sourceType: 'upload', files: uploadFiles })
    } else if (sourceTab === 'web') {
      onSubmit({ ...meta, sourceType: 'web', url: webUrl })
    }
  }

  const sourceTabs = [
    { value: 'upload', label: '本地文件', icon: <Paperclip className="h-4 w-4" /> },
    { value: 'text', label: '文本粘贴', icon: <FileText className="h-4 w-4" /> },
    { value: 'web', label: '网页抓取', icon: <Globe className="h-4 w-4" /> },
  ]

  return (
    <Modal
      open={open}
      title="新增知识文档"
      onClose={onClose}
      maxWidth="max-w-4xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !canSubmit()}
            className="btn-primary"
          >
            {saving ? '处理中…' : sourceTab === 'upload' && uploadFiles.length > 1 ? `添加 ${uploadFiles.length} 个文件` : '添加文档'}
          </button>
        </>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        {/* 维度一：文档来源 */}
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            一、文档来源
          </h3>
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            {sourceTabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setSourceTab(tab.value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  sourceTab === tab.value
                    ? 'bg-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {sourceTab === 'text' && (
            <AutoGrowTextarea
              className={`${textareaCls} resize-y font-mono`}
              rows={8}
              placeholder="直接粘贴文档内容…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          )}
          {sourceTab === 'upload' && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
              <input
                type="file"
                multiple
                className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-primary"
                onChange={(e) => {
                  const list = Array.from(e.target.files || [])
                  setUploadFiles(list)
                  if (list[0] && !title) setTitle(list[0].name.replace(/\.[^.]+$/, ''))
                }}
              />
              <div className="text-[11px] text-muted-foreground">
                可多选，支持 PDF / Word / Excel / TXT / Markdown / CSV，单文件 ≤ 50MB
              </div>
              {uploadFiles.length > 0 && (
                <ul className="max-h-28 overflow-y-auto text-[11px] text-muted-foreground">
                  {uploadFiles.map((f) => (
                    <li key={`${f.name}-${f.size}-${f.lastModified}`} className="truncate">
                      {f.name}（{(f.size / 1024).toFixed(1)} KB）
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {sourceTab === 'web' && (
            <input
              className={inputCls}
              placeholder="https://example.com/article"
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
            />
          )}
        </div>

        {/* 维度一续：基础信息 */}
        <div className="grid grid-cols-2 gap-3">
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">文档名称</div>
            <input
              className={inputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="自动提取或手动填写"
            />
          </label>
          <label>
            <div className="mb-1 text-xs font-medium text-muted-foreground">文档描述</div>
            <input
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，有助于语义检索"
            />
          </label>
        </div>

        {/* 高级配置（折叠） */}
        <div className="rounded-md border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:bg-muted"
          >
            <span className="inline-flex items-center gap-1.5">
              <Settings className="h-4 w-4" />
              高级配置（解析切片 / 元数据 / 检索策略）
            </span>
            <span className="text-muted-foreground">{showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-4 border-t border-border p-3">
              {/* 维度二：解析与切片 */}
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold text-muted-foreground">解析与切片</div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoChunk}
                    onChange={(e) => setAutoChunk(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">自动切分（系统智能分段）</span>
                </label>
                {!autoChunk && (
                  <div className="grid grid-cols-2 gap-3">
                    <label>
                      <div className="mb-1 text-[11px] text-muted-foreground">分块大小（字符）</div>
                      <input
                        type="number"
                        className={inputCls}
                        value={chunkSize}
                        onChange={(e) => setChunkSize(Number(e.target.value))}
                        min={100}
                        max={10000}
                      />
                    </label>
                    <label>
                      <div className="mb-1 text-[11px] text-muted-foreground">分块重叠（字符）</div>
                      <input
                        type="number"
                        className={inputCls}
                        value={chunkOverlap}
                        onChange={(e) => setChunkOverlap(Number(e.target.value))}
                        min={0}
                        max={1000}
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* 维度三：元数据与分类 */}
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold text-muted-foreground">元数据与分类标签</div>
                <label>
                  <div className="mb-1 text-[11px] text-muted-foreground">所属分类</div>
                  <input
                    className={inputCls}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="如：产品手册 / 人事政策"
                  />
                </label>
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">自定义标签</div>
                  {tags.map((tag, idx) => (
                    <div key={idx} className="mb-1 flex items-center gap-1.5">
                      <input
                        className={`${inputCls} flex-1`}
                        placeholder="标签名"
                        value={tag.key}
                        onChange={(e) => {
                          const next = [...tags]
                          next[idx] = { ...next[idx], key: e.target.value }
                          setTags(next)
                        }}
                      />
                      <input
                        className={`${inputCls} flex-1`}
                        placeholder="标签值"
                        value={tag.value}
                        onChange={(e) => {
                          const next = [...tags]
                          next[idx] = { ...next[idx], value: e.target.value }
                          setTags(next)
                        }}
                      />
                      {tags.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setTags(tags.filter((_, i) => i !== idx))}
                          className="flex shrink-0 items-center rounded border border-border px-1.5 py-1 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setTags([...tags, { key: '', value: '' }])}
                    className="text-[11px] text-primary hover:text-primary"
                  >
                    + 添加标签
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label>
                    <div className="mb-1 text-[11px] text-muted-foreground">生效时间</div>
                    <DatePicker
                      type="datetime"
                      block
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                      placeholder="生效时间"
                      title="生效时间"
                    />
                  </label>
                  <label>
                    <div className="mb-1 text-[11px] text-muted-foreground">失效时间</div>
                    <DatePicker
                      type="datetime"
                      block
                      value={effectiveTo}
                      onChange={(e) => setEffectiveTo(e.target.value)}
                      placeholder="失效时间"
                      title="失效时间"
                    />
                  </label>
                </div>
              </div>

              {/* 维度四：检索策略 */}
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold text-muted-foreground">检索策略</div>
                <label>
                  <div className="mb-1 text-[11px] text-muted-foreground">检索权重（1-10，越高越优先）</div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={retrievalWeight}
                    onChange={(e) => setRetrievalWeight(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <div className="text-center text-[11px] text-muted-foreground">{retrievalWeight}</div>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* 实时预览：切片效果 */}
        {sourceTab === 'text' && content && !autoChunk && previewChunks.length > 0 && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                <ClipboardList className="h-4 w-4" />
                切片预览（共 {totalChunks} 块，展示前 {previewChunks.length} 块）
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {previewChunks.map((chunk, idx) => (
                <div
                  key={idx}
                  className="rounded border border-border bg-card p-2 font-mono text-[11px] text-muted-foreground"
                >
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                    块 {idx + 1}（{chunk.length} 字符）
                  </div>
                  <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words">
                    {chunk}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// 文档状态映射（parsing/indexing/available/failed）
const DOC_STATUS_MAP = {
  parsing: { label: '解析中', color: 'bg-warning/20 text-warning', icon: <Loader2 className="inline h-3 w-3 animate-spin" /> },
  indexing: { label: '索引中', color: 'bg-info/20 text-info', icon: <RefreshCw className="inline h-3 w-3" /> },
  available: { label: '就绪', color: 'bg-success/20 text-success', icon: <Check className="inline h-3 w-3" /> },
  failed: { label: '失败', color: 'bg-destructive/20 text-destructive', icon: <X className="inline h-3 w-3" /> },
  disabled: { label: '已停用', color: 'bg-muted text-muted-foreground', icon: <EyeOff className="inline h-3 w-3" /> },
}

// 分段查看弹窗：展示文档解析→分段→向量化的完整过程
function SegmentsModal({ open, data, loading, onClose, onReparse, reparsing }) {
  if (!open) return null
  const cfg = data?.kb_config || {}
  const segments = data?.segments || []
  const chunkModeLabel = CHUNK_MODES.find((m) => m.value === cfg.chunk_mode)?.label || cfg.chunk_mode
  const indexModeLabel = INDEX_MODES.find((m) => m.value === cfg.index_mode)?.label || cfg.index_mode

  return (
    <Modal
      open={open}
      title={`分段详情：${data?.title || ''}`}
      onClose={onClose}
      maxWidth="max-w-4xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary">
            关闭
          </button>
          <button
            type="button"
            onClick={onReparse}
            disabled={reparsing}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            {reparsing ? (
              '重新解析中…'
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                重新解析分段
              </>
            )}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="p-8 text-center text-sm text-muted-foreground">加载分段中…</div>
      ) : !data ? (
        <div className="p-8 text-center text-sm text-muted-foreground">暂无数据</div>
      ) : (
        <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto">
          {/* 解析过程概览 */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              解析与索引过程
            </h3>
            {/* 流程步骤 */}
            <div className="mb-3 flex items-center gap-1">
              <div className="flex flex-1 items-center gap-1.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/20 text-[11px] font-semibold text-success">1</span>
                <span className="text-[11px] text-muted-foreground">文件解析</span>
              </div>
              <span className="text-muted-foreground">→</span>
              <div className="flex flex-1 items-center gap-1.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/20 text-[11px] font-semibold text-success">2</span>
                <span className="text-[11px] text-muted-foreground">文本分段</span>
              </div>
              <span className="text-muted-foreground">→</span>
              <div className="flex flex-1 items-center gap-1.5">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${data.has_embedding ? 'bg-success/20 text-success' : 'bg-secondary text-muted-foreground'}`}>3</span>
                <span className="text-[11px] text-muted-foreground">向量生成</span>
              </div>
              <span className="text-muted-foreground">→</span>
              <div className="flex flex-1 items-center gap-1.5">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${data.status === 'available' ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'}`}>4</span>
                <span className="text-[11px] text-muted-foreground">可检索</span>
              </div>
            </div>
            {/* 统计指标 */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded border border-border bg-muted p-2 text-center">
                <div className="text-[10px] text-muted-foreground">原文长度</div>
                <div className="text-sm font-semibold text-foreground">{(data.content_len || 0).toLocaleString()}</div>
                <div className="text-[9px] text-muted-foreground">字符</div>
              </div>
              <div className="rounded border border-border bg-muted p-2 text-center">
                <div className="text-[10px] text-muted-foreground">分段数</div>
                <div className="text-sm font-semibold text-primary">{data.segment_count || 0}</div>
                <div className="text-[9px] text-muted-foreground">chunks</div>
              </div>
              <div className="rounded border border-border bg-muted p-2 text-center">
                <div className="text-[10px] text-muted-foreground">Token 总数</div>
                <div className="text-sm font-semibold text-foreground">{(data.token_total || 0).toLocaleString()}</div>
                <div className="text-[9px] text-muted-foreground">分词后</div>
              </div>
              <div className="rounded border border-border bg-muted p-2 text-center">
                <div className="text-[10px] text-muted-foreground">向量数</div>
                <div className={`text-sm font-semibold ${data.has_embedding ? 'text-info' : 'text-muted-foreground'}`}>
                  {data.embedding_count || 0}/{data.segment_count || 0}
                </div>
                <div className="text-[9px] text-muted-foreground">{data.has_embedding ? '已向量化' : '纯关键词'}</div>
              </div>
            </div>
            {/* 配置信息 */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">分段：{chunkModeLabel}</span>
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">块大小：{cfg.chunk_size}</span>
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">重叠：{cfg.chunk_overlap}</span>
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">索引：{indexModeLabel}</span>
              {cfg.embedding_model && (
                <span className="rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">模型：{cfg.embedding_model}</span>
              )}
            </div>
          </div>

          {/* 分段列表 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                分段列表（{segments.length}）
              </h3>
              <span className="text-[10px] text-muted-foreground">点击展开查看完整内容</span>
            </div>
            {segments.length === 0 ? (
              <div className="rounded-md border border-border bg-card p-6 text-center text-xs text-muted-foreground">
                暂无分段，请点击"重新解析分段"
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {segments.map((seg) => (
                  <SegmentItem key={seg.id} seg={seg} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

// 单个分段项（可展开）
function SegmentItem({ seg }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted"
      >
        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          #{seg.seq + 1}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {seg.preview}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{seg.char_count} 字符</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{seg.token_count} tokens</span>
        {seg.has_embedding ? (
          <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-info/15 px-1 py-0.5 text-[9px] text-info" title="已生成向量">
            <Check className="inline h-2.5 w-2.5" /> 向量
          </span>
        ) : (
          <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground" title="无向量">
            无向量
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</span>
      </button>
      {expanded && (
        <div className="border-t border-border p-3">
          <pre className="max-h-60 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] text-muted-foreground">
            {seg.content}
          </pre>
        </div>
      )}
    </div>
  )
}

// 文件查询结果展示（表格形式）
function FileQueryResultView({ data }) {
  const columns = data.columns || []
  const rows = data.rows || []
  const isMulti = Array.isArray(data.results)

  if (isMulti) {
    return (
      <div className="flex flex-col gap-2">
        {data.results.map((r, i) => (
          <div key={i} className="rounded border border-border bg-background p-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              {r.title} <span className="text-muted-foreground">({r.matched}/{r.total} 行)</span>
            </div>
            <ResultTable columns={r.columns || []} rows={r.rows || []} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-medium text-muted-foreground">
          {data.title}
          <span className="ml-2 text-muted-foreground">
            共 {data.total} 行，命中 {data.matched} 行{data.truncated ? `（已截断，仅显示前 ${rows.length} 行）` : ''}
          </span>
        </div>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">
          {data.source}
        </span>
      </div>
      <ResultTable columns={columns} rows={rows} />
    </div>
  )
}

// 表格渲染
function ResultTable({ columns, rows }) {
  if (!rows || rows.length === 0) {
    return <div className="py-2 text-center text-[11px] text-muted-foreground">无匹配行</div>
  }
  // 收集所有列（不同行可能有不同 key）
  const allCols = columns.length > 0 ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))]
  return (
    <div className="max-h-80 w-full overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-border">
            <th className="sticky top-0 bg-card px-2 py-1 text-left text-[10px] font-semibold text-muted-foreground">
              #
            </th>
            {allCols.map((col) => (
              <th
                key={col}
                className="sticky top-0 bg-card px-2 py-1 text-left text-[10px] font-semibold text-muted-foreground whitespace-nowrap"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border hover:bg-muted">
              <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
              {allCols.map((col) => (
                <td key={col} className="px-2 py-1 text-muted-foreground whitespace-nowrap">
                  {row[col] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 知识库管理页：左侧知识库列表 + 右侧文档管理 + 搜索
function KnowledgeBase() {
  const canCreate = hasPermission('knowledge_base', 'edit')
  const [kbList, setKbList] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [docs, setDocs] = useState([])
  const [loadingKb, setLoadingKb] = useState(true)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 列表搜索/排序
  const [kbSearch, setKbSearch] = useState('')
  const [kbSort, setKbSort] = useState('updated') // updated | created | docs
  // 统一搜索 Tab
  const [searchTab, setSearchTab] = useState('semantic') // semantic | file
  const [docSearch, setDocSearch] = useState('')
  // 文档状态快捷筛选（'' 全部 | available | processing | failed | disabled）
  const [docStatusFilter, setDocStatusFilter] = useState('')
  const [selectedDocIds, setSelectedDocIds] = useState([])
  const replaceInputRef = useRef(null)
  const [replaceTargetId, setReplaceTargetId] = useState(null)

  // 新建/编辑文档
  const [newDocTitle, setNewDocTitle] = useState('')
  const [newDocContent, setNewDocContent] = useState('')

  // 文件上传
  const [uploadFile, setUploadFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  // 搜索
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])

  // 文件查询（Excel/CSV 精确查询）
  const [fileQuery, setFileQuery] = useState('')
  const [fileQueryDocId, setFileQueryDocId] = useState(null)
  const [fileQueryResults, setFileQueryResults] = useState(null)
  const [fileQuerying, setFileQuerying] = useState(false)
  const [searching, setSearching] = useState(false)

  // KB 弹窗
  const [kbFormOpen, setKbFormOpen] = useState(false)
  const [kbEditing, setKbEditing] = useState(null)
  const [kbSaving, setKbSaving] = useState(false)

  // 资源共享设置弹窗
  const [shareOpen, setShareOpen] = useState(false)
  // 批量授权：选中多个知识库后一次性授权给多位用户
  const [batchShareOpen, setBatchShareOpen] = useState(false)
  const { selectedKeys, toggle: toggleKbSelect, clear: clearKbSelection, count: selectedCount } = useSelection()
  const [shareResource, setShareResource] = useState(null)

  // 文档编辑弹窗
  const [docEditOpen, setDocEditOpen] = useState(false)
  const [docEditing, setDocEditing] = useState(null)
  const [docSaving, setDocSaving] = useState(false)

  // 文档新增弹窗
  const [docAddOpen, setDocAddOpen] = useState(false)
  const [docAdding, setDocAdding] = useState(false)

  // 分段查看弹窗
  const [segOpen, setSegOpen] = useState(false)
  const [segDoc, setSegDoc] = useState(null)
  const [segData, setSegData] = useState(null)
  const [segLoading, setSegLoading] = useState(false)
  const [segReparsing, setSegReparsing] = useState(false)

  // 批量重新解析
  const [reparseAllLoading, setReparseAllLoading] = useState(false)
  const [tutorialOpen, setTutorialOpen] = useState(false)

  const loadKb = useCallback(async () => {
    try {
      const data = await kbApi.list()
      const list = Array.isArray(data) ? data : []
      setKbList(list)
      // 自动选中第一个知识库（如果当前未选中且列表非空）
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id)
      }
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoadingKb(false)
    }
  }, [selectedId])

  useEffect(() => {
    loadKb()
  }, [loadKb])

  const loadDocs = useCallback(async (kbId) => {
    setLoadingDocs(true)
    try {
      const data = await kbApi.documents(kbId)
      setDocs(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || '加载文档失败')
    } finally {
      setLoadingDocs(false)
    }
  }, [])

  // 静默轮询：只更新状态/进度有变化的文档，不触发 loading 状态，避免列表闪烁
  const pollDocs = useCallback(async (kbId) => {
    try {
      const data = await kbApi.documents(kbId)
      if (!Array.isArray(data)) return
      setDocs((prev) => {
        const dataMap = new Map(data.map((d) => [d.id, d]))
        const prevIds = prev.map((d) => d.id).join(',')
        const nextIds = data.map((d) => d.id).join(',')
        if (prevIds !== nextIds) return data
        let changed = false
        const next = prev.map((d) => {
          const updated = dataMap.get(d.id)
          if (!updated) return d
          if (
            updated.status !== d.status ||
            updated.progress !== d.progress ||
            updated.segment_count !== d.segment_count ||
            updated.enabled !== d.enabled ||
            updated.error_message !== d.error_message
          ) {
            changed = true
            return updated
          }
          return d
        })
        return changed ? next : prev
      })
    } catch {
      // 静默失败，不影响用户体验
    }
  }, [])

  useEffect(() => {
    if (selectedId) loadDocs(selectedId)
    else setDocs([])
    setSelectedDocIds([])
    setSearchResults([])
  }, [selectedId, loadDocs])

  // 轮询：有文档处于解析/索引中时，每 2.5s 静默刷新进度
  useEffect(() => {
    const hasProcessing = docs.some(
      (d) => d.status === 'parsing' || d.status === 'indexing'
    )
    if (!hasProcessing || !selectedId) return
    const timer = setInterval(() => pollDocs(selectedId), 2500)
    return () => clearInterval(timer)
  }, [docs, selectedId, pollDocs])

  // 新建/编辑知识库
  const handleKbSubmit = async (form, files = []) => {
    setKbSaving(true)
    try {
      if (kbEditing) {
        await kbApi.update(kbEditing.id, form)
        setKbFormOpen(false)
        setKbEditing(null)
        await loadKb()
      } else {
        const created = await kbApi.create(form)
        setKbFormOpen(false)
        setKbEditing(null)
        if (created?.id) setSelectedId(created.id)
        if (created?.id && files.length > 0) {
          const res = await kbApi.uploadDocuments(created.id, files)
          const failed = res?.errors?.length || 0
          const ok = res?.documents?.length || 0
          if (failed) toast.warning(`知识库已创建：成功 ${ok} 个，失败 ${failed} 个`)
          else toast.success(`知识库已创建，已上传 ${ok} 个文件`)
        }
        await loadKb()
        if (created?.id) await loadDocs(created.id)
      }
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setKbSaving(false)
    }
  }

  const handleDeleteKb = async (kb) => {
    const _ok = await confirm({ message: `确定删除知识库「${kb.name || kb.id}」吗？所有文档将一并删除。`, variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await kbApi.remove(kb.id)
      if (selectedId === kb.id) setSelectedId(null)
      await loadKb()
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 添加文档
  const handleAddDoc = async () => {
    if (!selectedId) return
    if (!newDocTitle.trim()) {
      toast.warning('请填写文档标题')
      return
    }
    setBusy(true)
    try {
      await kbApi.addDocument(selectedId, {
        title: newDocTitle,
        content: newDocContent,
      })
      setNewDocTitle('')
      setNewDocContent('')
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`添加文档失败：${err.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  // 编辑文档
  const handleDocUpdate = async (body) => {
    if (!selectedId || !docEditing) return
    setDocSaving(true)
    try {
      await kbApi.updateDocument(selectedId, docEditing.id, body)
      setDocEditOpen(false)
      setDocEditing(null)
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`保存失败：${err.message || err}`)
    } finally {
      setDocSaving(false)
    }
  }

  const handleDeleteDoc = async (docId) => {
    if (!selectedId) return
    const _ok = await confirm({ message: '确定删除该文档吗？', variant: 'danger', confirmText: '确定删除' })
    if (!_ok) return
    try {
      await kbApi.removeDocument(selectedId, docId)
      setDocs((prev) => prev.filter((d) => d.id !== docId))
    } catch (err) {
      toast.error(`删除失败：${err.message || err}`)
    }
  }

  // 新增文档：根据来源类型调用不同 API
  const handleDocAdd = async (data) => {
    if (!selectedId) return
    setDocAdding(true)
    try {
      if (data.sourceType === 'text') {
        await kbApi.addDocument(selectedId, {
          title: data.title,
          content: data.content,
          description: data.description,
          category: data.category,
          tags: data.tags,
          effective_from: data.effective_from,
          effective_to: data.effective_to,
          retrieval_weight: data.retrieval_weight,
        })
      } else if (data.sourceType === 'upload') {
        const files = data.files || (data.file ? [data.file] : [])
        if (files.length === 1) {
          await kbApi.uploadDocument(selectedId, files[0])
        } else {
          const res = await kbApi.uploadDocuments(selectedId, files)
          const failed = res?.errors?.length || 0
          if (failed) toast.warning(`部分文件失败：${failed} 个`)
        }
      } else if (data.sourceType === 'web') {
        await kbApi.fetchUrlDocument(selectedId, {
          url: data.url,
          title: data.title,
          description: data.description,
          category: data.category,
          tags: data.tags,
          retrieval_weight: data.retrieval_weight,
        })
      }
      setDocAddOpen(false)
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`添加文档失败：${err.message || err}`)
    } finally {
      setDocAdding(false)
    }
  }

  const handleUploadFile = async () => {
    if (!selectedId) return
    if (!uploadFile) {
      toast.warning('请先选择要上传的文件')
      return
    }
    setUploading(true)
    try {
      await kbApi.uploadDocument(selectedId, uploadFile)
      setUploadFile(null)
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`上传失败：${err.message || err}`)
    } finally {
      setUploading(false)
    }
  }

  // 查看文档分段
  const handleViewSegments = async (doc) => {
    if (!selectedId) return
    setSegDoc(doc)
    setSegOpen(true)
    setSegData(null)
    setSegLoading(true)
    try {
      const data = await kbApi.segments(selectedId, doc.id)
      setSegData(data)
    } catch (err) {
      toast.error(`加载分段失败：${err.message || err}`)
      setSegOpen(false)
    } finally {
      setSegLoading(false)
    }
  }

  // 重新解析单个文档
  const handleReparseDoc = async () => {
    if (!selectedId || !segDoc) return
    setSegReparsing(true)
    try {
      await kbApi.reparseDocument(selectedId, segDoc.id)
      // 刷新分段数据
      const data = await kbApi.segments(selectedId, segDoc.id)
      setSegData(data)
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`重新解析失败：${err.message || err}`)
    } finally {
      setSegReparsing(false)
    }
  }

  // 批量重新解析知识库下所有文档
  const handleReparseAll = async () => {
    if (!selectedId) return
    const _ok = await confirm({ message: '确定重新解析该知识库下所有文档吗？将按最新配置重新分段与向量化。', variant: 'warning', confirmText: '确定' })
    if (!_ok) return
    setReparseAllLoading(true)
    try {
      const res = await kbApi.reparseAll(selectedId)
      toast.success(`批量重新解析完成：共 ${res.total} 篇文档`)
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(`批量重新解析失败：${err.message || err}`)
    } finally {
      setReparseAllLoading(false)
    }
  }

  const handleToggleDocEnabled = async (doc) => {
    if (!selectedId) return
    const next = !(doc.enabled !== false)
    try {
      await kbApi.setDocumentEnabled(selectedId, doc.id, next)
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, enabled: next } : d)))
    } catch (err) {
      toast.error(err.message || '更新失败')
    }
  }

  const handleBatchDocs = async (action) => {
    if (!selectedId || selectedDocIds.length === 0) return
    if (action === 'delete') {
      const _ok = await confirm({ message: `确定删除选中的 ${selectedDocIds.length} 篇文档吗？`, variant: 'danger', confirmText: '确定删除' })
      if (!_ok) return
    }
    try {
      await kbApi.batchDocuments(selectedId, action, selectedDocIds)
      setSelectedDocIds([])
      await loadDocs(selectedId)
      toast.success('已完成批量操作')
    } catch (err) {
      toast.error(err.message || '批量操作失败')
    }
  }

  const handleReplacePick = (docId) => {
    setReplaceTargetId(docId)
    replaceInputRef.current?.click()
  }

  const handleReplaceFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !selectedId || !replaceTargetId) return
    try {
      await kbApi.replaceDocumentFile(selectedId, replaceTargetId, file)
      toast.success('已替换原文件，正在重新解析')
      await loadDocs(selectedId)
    } catch (err) {
      toast.error(err.message || '替换失败')
    } finally {
      setReplaceTargetId(null)
    }
  }

  const toggleDocSelect = (docId) => {
    setSelectedDocIds((prev) => (prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]))
  }

  const handleSearch = async () => {
    if (!selectedId) return
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const res = await kbApi.search(selectedId, query, 0)
      setSearchResults(Array.isArray(res) ? res : [])
    } catch (err) {
      toast.error(`搜索失败：${err.message || err}`)
    } finally {
      setSearching(false)
    }
  }

  // 文件查询（读取原始 Excel/CSV 按条件查询）
  const handleFileQuery = async () => {
    if (!selectedId) return
    setFileQuerying(true)
    setFileQueryResults(null)
    try {
      const res = await kbApi.fileQuery(selectedId, {
        query: fileQuery,
        doc_id: fileQueryDocId,
        limit: 20,
      })
      setFileQueryResults(res)
    } catch (err) {
      toast.error(`文件查询失败：${err.message || err}`)
    } finally {
      setFileQuerying(false)
    }
  }

  const selectedKb = kbList.find((k) => k.id === selectedId)
  const canEditKb = canEditResource(selectedKb)
  const filteredDocs = useMemo(() => {
    let list = docs
    // 状态快捷筛选
    if (docStatusFilter) {
      list = list.filter((d) => {
        const isEnabled = d.enabled !== false
        if (docStatusFilter === 'disabled') return !isEnabled
        if (!isEnabled) return false
        if (docStatusFilter === 'processing') return d.status === 'parsing' || d.status === 'indexing'
        if (docStatusFilter === 'failed') return d.status === 'failed'
        if (docStatusFilter === 'available') return d.status !== 'failed' && d.status !== 'parsing' && d.status !== 'indexing'
        return true
      })
    }
    const kw = docSearch.trim().toLowerCase()
    if (!kw) return list
    return list.filter((d) =>
      (d.title || '').toLowerCase().includes(kw) ||
      (d.file_name || '').toLowerCase().includes(kw) ||
      (d.category || '').toLowerCase().includes(kw)
    )
  }, [docs, docSearch, docStatusFilter])

  // 文档状态指标统计（指标条 chips 用）
  const docStats = useMemo(() => {
    const s = { available: 0, processing: 0, failed: 0, disabled: 0, totalChars: 0 }
    docs.forEach((d) => {
      const isEnabled = d.enabled !== false
      if (!isEnabled) { s.disabled += 1; return }
      if (d.status === 'parsing' || d.status === 'indexing') s.processing += 1
      else if (d.status === 'failed') s.failed += 1
      else s.available += 1
      s.totalChars += d.char_count ?? (d.content || '').length
    })
    return s
  }, [docs])

  // 列表搜索 + 排序
  const filteredKbList = useMemo(() => {
    let list = kbList
    if (kbSearch.trim()) {
      const kw = kbSearch.trim().toLowerCase()
      list = list.filter((kb) =>
        (kb.name || '').toLowerCase().includes(kw) ||
        (kb.description || '').toLowerCase().includes(kw)
      )
    }
    const sorted = [...list]
    if (kbSort === 'docs') {
      sorted.sort((a, b) => (b.doc_count ?? 0) - (a.doc_count ?? 0))
    } else if (kbSort === 'created') {
      sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    } else {
      // updated
      sorted.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    }
    return sorted
  }, [kbList, kbSearch, kbSort])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">知识库</h1>
          {!loadingKb && (
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium tabular-nums text-foreground">{kbList.length}</span> 个库 ·{' '}
              <span className="font-medium tabular-nums text-foreground">
                {kbList.reduce((acc, k) => acc + (k.doc_count || 0), 0).toLocaleString()}
              </span>{' '} 篇文档
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TutorialButton onClick={() => setTutorialOpen(true)} />
          <button type="button" onClick={loadKb} className="btn-secondary btn-sm" title="刷新知识库列表">
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </button>
          {canCreate && (
            <button
              type="button"
              onClick={() => {
                setKbEditing(null)
                setKbFormOpen(true)
              }}
              className="btn-primary btn-sm"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> 新建知识库
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左侧：知识库列表 */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border bg-card">
          <div className="border-b border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                知识库列表
              </h2>
              <span className="text-[10px] text-muted-foreground">{filteredKbList.length}/{kbList.length}</span>
            </div>
            {/* 搜索框 */}
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={kbSearch}
                onChange={(e) => setKbSearch(e.target.value)}
                placeholder="搜索知识库名称..."
                className={`${inputBaseCls} w-full pl-8 text-xs`}
              />
            </div>
            {/* 排序 */}
            <div className="flex items-center gap-1">
              <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
              {[
                { v: 'updated', label: '最近更新' },
                { v: 'created', label: '创建时间' },
                { v: 'docs', label: '文档数' },
              ].map((s) => (
                <button
                  key={s.v}
                  type="button"
                  onClick={() => setKbSort(s.v)}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                    kbSort === s.v ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {/* 批量操作工具条：勾选 ≥1 个知识库后显示 */}
            {selectedCount > 0 && (
              <div className="mb-2">
                <BatchActions
                  selectedCount={selectedCount}
                  onClear={clearKbSelection}
                  actions={[
                    { key: 'share', label: '批量授权', icon: Share2, variant: 'default', onClick: () => setBatchShareOpen(true) },
                  ]}
                />
              </div>
            )}
            {loadingKb ? (
              <div className="flex flex-col gap-1.5 p-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 shrink-0 rounded-full skeleton-shimmer" />
                      <div className="h-3.5 w-2/3 rounded skeleton-shimmer" />
                    </div>
                    <div className="mt-2 h-2.5 w-1/2 rounded skeleton-shimmer" />
                    <div className="mt-2 h-3 w-16 rounded skeleton-shimmer" />
                  </div>
                ))}
              </div>
            ) : kbList.length === 0 ? (
              <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 p-4 text-left">
                <p className="text-xs font-medium text-foreground">开始创建第一个知识库</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                  <li>点击右上角「新建知识库」或上传文档</li>
                  <li>等待自动分段与向量化完成</li>
                  <li>在智能体编辑页「能力配置 → 知识库」中勾选启用</li>
                </ol>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  系统已预置「安全响应规范」「常用研判口径」等内置库，重启后端后会自动出现。
                </p>
              </div>
            ) : filteredKbList.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">未匹配到知识库</div>
            ) : (
              <div className="card-stagger flex flex-col gap-1.5">
                {filteredKbList.map((kb) => {
                  const health = kbHealthStatus(kb)
                  const checked = selectedKeys.includes(kb.id)
                  const isHealthy = (kb.doc_count ?? 0) > 0 && !(kb.failed_docs > 0)
                  return (
                    <div
                      key={kb.id}
                      onClick={() => setSelectedId(kb.id)}
                      className={`group cursor-pointer rounded-lg border p-3 backdrop-blur-sm transition-colors ${
                        selectedId === kb.id
                          ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_color-mix(in_oklch,var(--ring)_15%,transparent)]'
                          : checked
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-border bg-card hover:border-primary/50 hover:bg-muted'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        {/* 多选 checkbox：阻止冒泡，避免触发选中卡片 */}
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
                          checked={checked}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => toggleKbSelect(kb.id, e.target.checked)}
                          title="勾选以批量授权"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${health.color} ${isHealthy ? 'animate-pulse' : ''}`}
                              title={`状态：${health.label}`}
                            />
                            <div className="truncate text-sm font-medium text-foreground">
                              {kb.name || `#${kb.id}`}
                            </div>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{kb.doc_count ?? 0}</span> 篇文档
                            <span title={kb.updated_at ? fmtTime(kb.updated_at) : ''}>{kb.updated_at ? ` · ${relTime(kb.updated_at)}` : ''}</span>
                          </div>
                          {/* 精简配置标签：只显示检索模式 */}
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground">
                              {INDEX_MODES.find((m) => m.value === kb.index_mode)?.label || kb.index_mode}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-1 opacity-0 transition group-hover:opacity-100">
                          {canEditResource(kb) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setKbEditing(kb)
                                setKbFormOpen(true)
                              }}
                              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                            >
                              编辑
                            </button>
                          )}
                          {canManageShare(kb) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setShareResource(kb)
                                setShareOpen(true)
                              }}
                              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                              title="共享给其他用户"
                            >
                              <Share2 className="h-3 w-3" />共享
                            </button>
                          )}
                          {canEditResource(kb) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteKb(kb)
                              }}
                              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-danger-700 hover:text-destructive"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧：文档管理 + 搜索 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!selectedId ? (
            /* 欢迎引导页：首次进入或无选中时展示 */
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                  <Database className="h-8 w-8" />
                </div>
                <h2 className="mb-2 text-lg font-semibold text-foreground">欢迎使用知识库</h2>
                <p className="mb-6 text-sm text-muted-foreground">知识库让智能体具备专业领域知识，支持文档检索和精确查询</p>
                <div className="card-stagger grid grid-cols-1 gap-3 text-left">
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 transition hover:border-primary/40">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium text-foreground">支持多种文件类型</div>
                      <div className="text-[11px] text-muted-foreground">PDF、Word、Excel、CSV、Markdown、TXT、JSON</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 transition hover:border-primary/40">
                    <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium text-foreground">3 步创建知识库</div>
                      <div className="text-[11px] text-muted-foreground">1. 新建知识库 → 2. 配置分段与检索 → 3. 上传文档</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 transition hover:border-primary/40">
                    <Search className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium text-foreground">语义搜索 + 表格精确查询</div>
                      <div className="text-[11px] text-muted-foreground">自然语言提问或按 IP/列名精确过滤</div>
                    </div>
                  </div>
                </div>
                {kbList.length === 0 ? (
                  canCreate && (
                    <button
                      type="button"
                      onClick={() => { setKbEditing(null); setKbFormOpen(true) }}
                      className="mt-6 btn-primary btn-sm"
                    >
                      + 创建第一个知识库
                    </button>
                  )
                ) : (
                  <div className="mt-4 text-[11px] text-muted-foreground">在左侧选择一个知识库开始管理</div>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* 顶部信息条 + 配置 */}
              <div className="border-b border-border bg-card px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {selectedKb?.name || `知识库 #${selectedId}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setKbEditing(selectedKb)
                          setKbFormOpen(true)
                        }}
                        className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                      >
                        编辑配置
                      </button>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {selectedKb?.description || '暂无描述'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">文档 {docs.length} 篇</span>
                    <button
                      type="button"
                      onClick={handleReparseAll}
                      disabled={reparseAllLoading || docs.length === 0}
                      title="按最新知识库配置重新分段与向量化所有文档"
                      className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
                    >
                      {reparseAllLoading ? (
                        '解析中…'
                      ) : (
                        <>
                          <RefreshCw className="h-3.5 w-3.5" />
                          批量重建索引
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {/* 配置参数分组展示 */}
                {selectedKb && (
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
                    <div className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5">
                      <span className="text-muted-foreground">检索方式</span>
                      <span className="font-medium text-foreground">
                        {INDEX_MODES.find((m) => m.value === selectedKb.index_mode)?.label || selectedKb.index_mode}
                      </span>
                      <InfoTip text={INDEX_MODES.find((m) => m.value === selectedKb.index_mode)?.hint || ''} />
                    </div>
                    <div className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5">
                      <span className="text-muted-foreground">分段策略</span>
                      <span className="font-medium text-foreground">
                        {CHUNK_MODES.find((m) => m.value === selectedKb.chunk_mode)?.label || selectedKb.chunk_mode}
                        {selectedKb.chunk_mode === 'manual' && ` (${selectedKb.chunk_size}/${selectedKb.chunk_overlap})`}
                      </span>
                      <InfoTip text={CHUNK_MODES.find((m) => m.value === selectedKb.chunk_mode)?.hint || ''} />
                    </div>
                    {(selectedKb.index_mode === 'vector' || selectedKb.index_mode === 'hybrid') && (
                      <div className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5">
                        <span className="text-muted-foreground">Embedding</span>
                        <span className="font-medium text-foreground">{selectedKb.embedding_model}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5">
                      <span className="text-muted-foreground">召回参数</span>
                      <span className="font-medium text-foreground">Top-K {selectedKb.retrieval_top_k}</span>
                      {selectedKb.score_threshold > 0 && (
                        <span className="text-muted-foreground">/ 阈值 {selectedKb.score_threshold}</span>
                      )}
                      <InfoTip text="Top-K 控制返回分段数量；阈值过滤相似度低于该值的分段（0 表示不过滤）" />
                    </div>
                    {selectedKb.rerank_enabled > 0 && (
                      <span className="flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-primary">
                        <ShieldCheck className="h-3 w-3" /> Rerank 已启用
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* 滚动区：新增文档按钮 + 文档列表 + 搜索 */}
              <div className="flex-1 overflow-y-auto p-4">
                {/* 新增文档按钮 */}
                <div className="mb-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDocAddOpen(true)}
                    disabled={!canEditKb}
                    title={!canEditKb ? '无编辑权限，无法新增文档' : '向当前知识库追加文件或文本'}
                    className="btn-primary btn-sm flex-1"
                  >
                    + 新增知识文档
                  </button>
                </div>

                {/* 文档列表 */}
                <div className="mb-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      文档列表
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      <span className="tabular-nums">{docs.filter((d) => d.enabled !== false).length}</span>/<span className="tabular-nums">{docs.length}</span> 参与检索
                    </span>
                  </div>
                  {docs.length > 0 && (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputBaseCls} min-w-[160px] flex-1 text-xs`}
                        placeholder="搜索文件名 / 标题…"
                        value={docSearch}
                        onChange={(e) => setDocSearch(e.target.value)}
                      />
                      {canEditKb && selectedDocIds.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">已选 <span className="tabular-nums">{selectedDocIds.length}</span></span>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => handleBatchDocs('enable')}>启用检索</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => handleBatchDocs('disable')}>停用检索</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => handleBatchDocs('reparse')}>重建索引</button>
                          <button type="button" className="btn-secondary btn-sm text-destructive" onClick={() => handleBatchDocs('delete')}>删除</button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* 文档状态指标条：状态分布（点击快速筛选）+ 汇总 */}
                  {!loadingDocs && docs.length > 0 && (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      {[
                        { key: 'available', label: '就绪', dot: 'bg-success', active: 'bg-success/15 text-success ring-success/40' },
                        { key: 'processing', label: '解析中', dot: 'bg-warning', active: 'bg-warning/15 text-warning ring-warning/40' },
                        { key: 'failed', label: '失败', dot: 'bg-destructive', active: 'bg-destructive/15 text-destructive ring-destructive/40' },
                        { key: 'disabled', label: '已停用', dot: 'bg-zinc-500', active: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/40' },
                      ].map((chip) => {
                        const active = docStatusFilter === chip.key
                        const count = docStats[chip.key] || 0
                        return (
                          <button
                            key={chip.key} type="button"
                            onClick={() => setDocStatusFilter(active ? '' : chip.key)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 ${
                              active
                                ? `border-transparent ring-1 ${chip.active}`
                                : 'border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground'
                            }`}
                            title={active ? '点击取消该状态筛选' : `点击筛选「${chip.label}」的文档`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${
                                (chip.key === 'available' || chip.key === 'processing') && count > 0 ? 'animate-pulse' : ''
                              }`}
                            />
                            {chip.label}
                            <span className={`tabular-nums ${count > 0 ? '' : 'text-muted-foreground'}`}>{count}</span>
                          </button>
                        )
                      })}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        总计 <span className={`font-semibold tabular-nums ${docStats.totalChars > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {docStats.totalChars > 0 ? docStats.totalChars.toLocaleString() : '--'}
                        </span> 字符
                      </span>
                    </div>
                  )}
                  {loadingDocs ? (
                    <div className="flex flex-col gap-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="rounded-lg border border-border bg-card p-4">
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-1/4 rounded skeleton-shimmer" />
                            <div className="h-4 w-14 rounded skeleton-shimmer" />
                          </div>
                          <div className="mt-2.5 h-3 w-1/2 rounded skeleton-shimmer" />
                          <div className="mt-2 h-3 w-2/3 rounded skeleton-shimmer" />
                        </div>
                      ))}
                    </div>
                  ) : docs.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-8 text-center">
                      <FileText className="h-10 w-10 text-muted-foreground" />
                      <div className="text-xs text-muted-foreground">暂无文档，点击上方按钮随时追加文件</div>
                    </div>
                  ) : filteredDocs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
                      <div className="text-xs text-muted-foreground">未找到匹配的文档</div>
                      <button
                        type="button"
                        onClick={() => { setDocSearch(''); setDocStatusFilter('') }}
                        className="btn-secondary btn-sm"
                      >
                        清除筛选
                      </button>
                    </div>
                  ) : (
                    <div className="card-stagger flex flex-col gap-2">
                      {filteredDocs.map((doc) => {
                        const isUpload = doc.source_type === 'upload' || doc.has_original_file
                        const badge = isUpload ? fileBadge(doc.file_type) : null
                        const isEnabled = doc.enabled !== false
                        const statusInfo = !isEnabled
                          ? DOC_STATUS_MAP.disabled
                          : (DOC_STATUS_MAP[doc.status] || DOC_STATUS_MAP.available)
                        const charCount = doc.char_count ?? (doc.content || '').length
                        const checked = selectedDocIds.includes(doc.id)
                        return (
                          <div
                            key={doc.id}
                            className={`card-hover rounded-lg border bg-card p-4 backdrop-blur-sm transition-colors ${
                              isEnabled ? 'border-border hover:border-primary/40' : 'border-border opacity-70'
                            }`}
                          >
                            <div className="flex items-start justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  {canEditKb && (
                                    <input
                                      type="checkbox"
                                      className="h-3.5 w-3.5 accent-primary"
                                      checked={checked}
                                      onChange={() => toggleDocSelect(doc.id)}
                                    />
                                  )}
                                  {badge && (
                                    <span
                                      className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                      title={`文件类型：${badge.label}`}
                                    >
                                      {badge.icon} {badge.label}
                                    </span>
                                  )}
                                  <div className="truncate text-sm font-medium text-foreground">
                                    {doc.title || `文档 #${doc.id}`}
                                  </div>
                                  <span
                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.color}`}
                                    title={`状态：${doc.status}`}
                                  >
                                    {statusInfo.icon} {statusInfo.label}
                                  </span>
                                </div>
                                {doc.file_name && (
                                  <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{doc.file_name}</span>
                                  </div>
                                )}
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                                  <span>{fmtTime(doc.created_at)}</span>
                                  {doc.updated_at && doc.updated_at !== doc.created_at && (
                                    <span title={fmtTime(doc.updated_at)}>· 更新 {relTime(doc.updated_at)}</span>
                                  )}
                                  <span className="text-muted-foreground">|</span>
                                  <span className="tabular-nums text-primary">{doc.segment_count ?? 0} 段</span>
                                  <span className="text-muted-foreground">/</span>
                                  <span className="tabular-nums">{Number(charCount).toLocaleString()} 字符</span>
                                  {doc.file_size != null && (
                                    <>
                                      <span className="text-muted-foreground">/</span>
                                      <span className="tabular-nums">{(doc.file_size / 1024).toFixed(1)} KB</span>
                                    </>
                                  )}
                                </div>
                                {doc.status === 'failed' && doc.error_message && (
                                  <div className="mt-1 flex items-start gap-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span>{doc.error_message}</span>
                                  </div>
                                )}
                                {(doc.status === 'parsing' || doc.status === 'indexing') && (
                                  <div className="mt-2 flex items-center gap-2">
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                                      <div
                                        className="h-full rounded-full bg-primary transition-all duration-300"
                                        style={{ width: `${doc.progress || 0}%` }}
                                      />
                                    </div>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                      {doc.status === 'parsing' ? '解析分段' : '向量化'} {doc.progress || 0}%
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                                {canEditKb && (
                                  <button
                                    type="button"
                                    onClick={() => handleToggleDocEnabled(doc)}
                                    title={isEnabled ? '停用后不参与智能体检索（Dify 文档开关）' : '启用检索'}
                                    className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                                  >
                                    {isEnabled ? '停用' : '启用'}
                                  </button>
                                )}
                                {canEditKb && (
                                  <button
                                    type="button"
                                    onClick={() => handleReplacePick(doc.id)}
                                    title="用新文件覆盖这份文档并重新解析"
                                    className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                                  >
                                    替换文件
                                  </button>
                                )}
                                {doc.has_original_file && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await kbApi.downloadDocumentFile(selectedId, doc.id, doc.file_name)
                                      } catch (err) {
                                        toast.error(err.message || '下载失败')
                                      }
                                    }}
                                    title="下载当时上传的原始文件"
                                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                                  >
                                    <Download className="h-3 w-3" />
                                    原文件
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleViewSegments(doc)}
                                  title="查看解析、分段与向量化详情"
                                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-blue-600 hover:text-info"
                                >
                                  查看分段
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      const full = await kbApi.getDocument(selectedId, doc.id)
                                      setDocEditing(full)
                                      setDocEditOpen(true)
                                    } catch (err) {
                                      toast.error(err.message || '加载文档失败')
                                    }
                                  }}
                                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteDoc(doc.id)}
                                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-danger-700 hover:text-destructive"
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                            {doc.content_preview && (
                              <pre className="mt-2 max-h-20 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] text-muted-foreground ring-1 ring-border">
                                {doc.content_preview}
                              </pre>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* 统一搜索区：Tab 切换语义检索 / 表格查询 */}
                <div className="rounded-md border border-border bg-card p-4">
                  <div className="mb-3 flex items-center gap-1 border-b border-border pb-2">
                    <button
                      type="button"
                      onClick={() => setSearchTab('semantic')}
                      className={`flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition ${
                        searchTab === 'semantic'
                          ? 'border-primary text-primary'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Search className="h-3.5 w-3.5" /> 命中测试
                    </button>
                    <button
                      type="button"
                      onClick={() => setSearchTab('file')}
                      className={`flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition ${
                        searchTab === 'file'
                          ? 'border-primary text-primary'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Sheet className="h-3.5 w-3.5" /> 表格精确查询
                    </button>
                  </div>

                  {searchTab === 'semantic' ? (
                    <>
                      <div className="mb-1.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                        <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>用真实问法做命中测试（Dify Hit Testing）：看会召回哪一段、分数如何构成。</span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          className={inputCls}
                          placeholder="如：哪些 IP 属于境外？"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSearch()
                          }}
                        />
                        <button
                          type="button"
                          onClick={handleSearch}
                          disabled={searching}
                          className="btn-primary btn-sm shrink-0"
                        >
                          {searching ? '测试中…' : '测试'}
                        </button>
                      </div>
                      {searchResults.length > 0 && (
                        <div className="mt-3 flex flex-col gap-2">
                          <div className="flex items-start gap-1 text-[10px] text-muted-foreground">
                            <Target className="h-3 w-3 shrink-0 mt-0.5" />
                            <span>命中 {searchResults.length} 段；已排除停用/过期文档，分数含检索权重</span>
                          </div>
                          {searchResults.map((r, idx) => (
                            <div
                              key={idx}
                              className="rounded-md border border-border bg-background p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                    #{idx + 1}
                                  </span>
                                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                    段 #{(r.seq ?? 0) + 1}
                                  </span>
                                  <div className="min-w-0 truncate text-sm font-medium text-foreground">
                                    {r.title || `文档 #${r.doc_id}`}
                                  </div>
                                  {r.file_name && (
                                    <span className="hidden max-w-[140px] truncate text-[10px] text-muted-foreground sm:inline">
                                      {r.file_name}
                                    </span>
                                  )}
                                </div>
                                <span className="shrink-0 rounded bg-success/20 px-2 py-0.5 text-[10px] font-medium text-success">
                                  {(r.score ?? 0).toFixed(4)}
                                </span>
                              </div>
                              {/* 分数明细 */}
                              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${Math.min(100, Math.round((r.score || 0) * 100))}%` }}
                                />
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning" title="BM25 关键词匹配分数（归一化）">
                                  BM25: {(r.bm25_score ?? 0).toFixed(4)}
                                </span>
                                <span className="rounded bg-info/15 px-1.5 py-0.5 text-[9px] text-info" title="向量语义余弦相似度（归一化）">
                                  向量: {(r.vector_score ?? 0).toFixed(4)}
                                </span>
                                {r.retrieval_weight != null && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                    权重 {r.retrieval_weight}
                                  </span>
                                )}
                              </div>
                              {r.content && (
                                <pre className="mt-1.5 max-h-28 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-card p-2 font-mono text-[11px] text-muted-foreground ring-1 ring-border">
                                  {r.content}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="mb-1.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                        <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>按 IP 或「列名=值」精确过滤。适合 IP 列表、资产台账等结构化数据。</span>
                      </div>
                      <div className="flex gap-2">
                        <CompactSelect
                          size="lg"
                          block
                          className="w-40 shrink-0"
                          value={fileQueryDocId || ''}
                          onChange={(e) => setFileQueryDocId(e.target.value ? Number(e.target.value) : null)}
                        >
                          <option value="">全部文档</option>
                          {docs.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.title}
                            </option>
                          ))}
                        </CompactSelect>
                        <input
                          className={inputCls}
                          placeholder="如 198.51.100.1 或 公网地址=203.0.113.4"
                          value={fileQuery}
                          onChange={(e) => setFileQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleFileQuery()
                          }}
                        />
                        <button
                          type="button"
                          onClick={handleFileQuery}
                          disabled={fileQuerying}
                          className="btn-primary btn-sm shrink-0"
                        >
                          {fileQuerying ? '查询中…' : '查询'}
                        </button>
                      </div>
                      {fileQueryResults && (
                        <div className="mt-3">
                          {fileQueryResults.error ? (
                            <div className="rounded border border-border bg-background p-3 text-xs text-muted-foreground">
                              {fileQueryResults.error}
                            </div>
                          ) : fileQueryResults.message ? (
                            <div className="rounded border border-border bg-background p-3 text-xs text-muted-foreground">
                              {fileQueryResults.message}
                            </div>
                          ) : (
                            <FileQueryResultView data={fileQueryResults} />
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        onChange={handleReplaceFileChange}
      />

      {/* 知识库编辑/新建弹窗 */}
      <KBFormModal
        open={kbFormOpen}
        initial={kbEditing}
        onClose={() => {
          setKbFormOpen(false)
          setKbEditing(null)
        }}
        onSubmit={handleKbSubmit}
        saving={kbSaving}
      />

      {/* 文档编辑弹窗 */}
      <DocEditModal
        open={docEditOpen}
        initial={docEditing}
        onClose={() => {
          setDocEditOpen(false)
          setDocEditing(null)
        }}
        onSubmit={handleDocUpdate}
        saving={docSaving}
        canEdit={canEditResource(selectedKb)}
      />

      {/* 新增知识文档弹窗（5维度渐进式表单） */}
      <DocAddModal
        open={docAddOpen}
        kbConfig={selectedKb}
        onClose={() => setDocAddOpen(false)}
        onSubmit={handleDocAdd}
        saving={docAdding}
      />

      {/* 分段查看弹窗 */}
      <SegmentsModal
        open={segOpen}
        data={segData}
        loading={segLoading}
        reparsing={segReparsing}
        onClose={() => {
          setSegOpen(false)
          setSegDoc(null)
          setSegData(null)
        }}
        onReparse={handleReparseDoc}
      />

      {/* 使用教程 */}
      <TutorialDrawer
        open={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
        title="知识库使用教程"
        subtitle="了解如何创建知识库、上传文档和配置检索"
        sections={KNOWLEDGE_BASE_TUTORIAL}
      />

      {/* 资源共享设置弹窗 */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="knowledge_base"
        resourceId={shareResource?.id}
        resourceName={shareResource?.name}
        ownerUserId={shareResource?.created_by}
      />

      {/* 批量授权弹窗：把选中的多个知识库一次性授权给多位用户 */}
      <BatchShareDialog
        open={batchShareOpen}
        onClose={() => setBatchShareOpen(false)}
        resourceType="knowledge_base"
        resources={selectedKeys
          .map((id) => kbList.find((kb) => kb.id === id))
          .filter(Boolean)
          .map((kb) => ({ id: kb.id, name: kb.name }))}
        onDone={() => clearKbSelection()}
      />
    </div>
  )
}

export default KnowledgeBase
