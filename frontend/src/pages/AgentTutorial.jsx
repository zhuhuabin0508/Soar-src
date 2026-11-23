/**
 * 智能体使用教程 —— 图文详解每个配置项
 *
 * 从智能体列表页 header 的「使用教程」按钮进入。
 * 左侧固定目录导航 + 右侧滚动内容，每个配置模块含图标、说明、配置方法、效果、提示。
 */
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen, Sparkles, FileText, Settings, Brain, MessageSquare, Wrench, Library,
  Target, Puzzle, SlidersHorizontal, Bug, TrendingUp, Trophy, LayoutDashboard, Tag,
  Smile, MessageCircle, Lightbulb, Link, Thermometer, Ruler, RefreshCw, PenLine,
  CheckSquare, Palette, TrafficCone, Search, Shield, ShieldCheck, Repeat, Database,
  BarChart3, ClipboardList, ScrollText, AlertTriangle, Ban, Activity, Check, X,
  Loader2, GitBranch,
} from 'lucide-react'

// Emoji → lucide 图标映射（统一教程页图标风格）
const EMOJI_TO_ICON = {
  '📖': BookOpen, '✨': Sparkles, '📝': FileText, '⚙️': Settings, '🧠': Brain,
  '💬': MessageSquare, '🔧': Wrench, '📚': Library, '🎯': Target, '🧩': Puzzle,
  '🎛️': SlidersHorizontal, '🐞': Bug, '📈': TrendingUp, '🏆': Trophy,
  '📐': LayoutDashboard, '📛': Tag, '📄': FileText, '😊': Smile, '👋': MessageCircle,
  '💡': Lightbulb, '🔗': Link, '🌡️': Thermometer, '📏': Ruler, '🔄': RefreshCw,
  '✍️': PenLine, '☑️': CheckSquare, '🎨': Palette, '🚦': TrafficCone, '🔍': Search,
  '🛡️': Shield, '✅': ShieldCheck, '🔁': Repeat, '💾': Database, '📊': BarChart3,
  '📋': ClipboardList, '📜': ScrollText, '🚫': Ban,
}
function renderTutorialIcon(emoji, className) {
  const C = EMOJI_TO_ICON[emoji]
  return C ? <C className={className} /> : <span>{emoji}</span>
}

// 教程 hero 配图（AI 生成）
const HERO_IMAGE =
  'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=Modern%20cybersecurity%20SOAR%20platform%20illustration%20with%20AI%20robot%20agent%20security%20shields%20workflow%20automation%20network%20nodes%20dark%20blue%20gradient%20technology%20background%20clean%20flat%20design%20wide%20banner&image_size=landscape_16_9'

// 目录结构
const TOC = [
  { id: 'overview', icon: '📖', label: '智能体概述' },
  { id: 'create', icon: '✨', label: '创建智能体' },
  { id: 'basic', icon: '📝', label: '基础信息' },
  { id: 'engine', icon: '⚙️', label: '推理引擎' },
  { id: 'model', icon: '🧠', label: '模型配置' },
  { id: 'prompt', icon: '💬', label: '系统提示词' },
  { id: 'tools', icon: '🔧', label: '工具配置' },
  { id: 'knowledge', icon: '📚', label: '知识库对接' },
  { id: 'skills', icon: '🎯', label: '技能注入' },
  { id: 'middleware', icon: '🧩', label: '中间件配置' },
  { id: 'advanced', icon: '🎛️', label: '高级设置' },
  { id: 'debug', icon: '🐞', label: '调试与测试' },
  { id: 'monitor', icon: '📈', label: '监控与追溯' },
  { id: 'best-practices', icon: '🏆', label: '最佳实践' },
]

// 可复用：配置项卡片
function ConfigCard({ icon, title, name, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        {renderTutorialIcon(icon, 'h-4 w-4 shrink-0 text-primary')}
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {name && (
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs text-primary">{name}</code>
        )}
      </div>
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

// 可复用：提示框
function Tip({ type = 'tip', children }) {
  const styles = {
    tip: 'border-primary/30 bg-primary/10 text-primary/80',
    warn: 'border-amber-500/30 bg-warning/10 text-warning',
    danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  }
  const icons = { tip: <Lightbulb className="h-4 w-4" />, warn: <AlertTriangle className="h-4 w-4" />, danger: <Ban className="h-4 w-4" /> }
  return (
    <div className={`my-3 flex gap-2 rounded-md border px-3 py-2 text-sm ${styles[type]}`}>
      <span className="shrink-0">{icons[type]}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

// 可复用：内容区块
function Section({ id, icon, title, subtitle, children }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-border py-8 first:border-t-0">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
          {renderTutorialIcon(icon, 'h-5 w-5 text-primary')}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-3 pl-1">{children}</div>
    </section>
  )
}

function AgentTutorial() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState('overview')
  const contentRef = useRef(null)

  // 滚动监听：高亮当前目录项
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActiveSection(e.target.id)
        })
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    )
    TOC.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [])

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      {/* 左侧目录 */}
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-card p-3 lg:block">
        <div className="mb-3 flex items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <ClipboardList className="h-3.5 w-3.5" />
          目录
        </div>
        <nav className="flex flex-col gap-0.5">
          {TOC.map(({ id, icon, label }) => (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                activeSection === id
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {renderTutorialIcon(icon, 'h-3.5 w-3.5 shrink-0')}
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </nav>
        <button
          onClick={() => navigate('/studio')}
          className="mt-4 w-full rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          ← 返回智能体列表
        </button>
      </aside>

      {/* 右侧内容 */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {/* Hero 区 */}
        <div className="relative h-48 overflow-hidden md:h-64">
          <img
            src={HERO_IMAGE}
            alt="智能体教程"
            className="h-full w-full object-cover"
            onError={(e) => { e.target.style.display = 'none' }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/60 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-6 md:p-10">
            <h1 className="text-2xl font-semibold text-foreground md:text-3xl">智能体使用教程</h1>
          </div>
        </div>

        {/* 正文 */}
        <div className="mx-auto max-w-4xl px-6 pb-20 md:px-10">
          {/* ===== 1. 概述 ===== */}
          <Section id="overview" icon="📖" title="智能体概述" subtitle="什么是智能体？它能做什么？">
            <p className="text-sm leading-relaxed text-muted-foreground">
              <strong className="text-foreground">智能体（Agent）</strong>是 SOAR 平台的核心执行单元。
              它是一个由大语言模型（LLM）驱动的 AI 助手，能够：
            </p>
            <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
              <li>理解自然语言指令，进行多轮对话</li>
              <li>调用工具（查询资产、威胁情报、封禁 IP、读取文件等）完成实际任务</li>
              <li>检索知识库，基于私有文档回答问题</li>
              <li>遵循预设技能（SOP）执行标准化流程</li>
              <li>委派子代理并行处理复杂任务（Hermes 引擎）</li>
              <li>展示思考过程，让推理链路透明可见</li>
            </ul>
            <Tip>
              智能体 = <strong>LLM 大脑</strong> + <strong>工具双手</strong> + <strong>知识记忆</strong> +
              <strong>技能规范</strong>。配置智能体就是为它装配这些能力。
            </Tip>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">架构示意</div>
              <pre className="overflow-x-auto text-xs text-muted-foreground">{`用户输入
   ↓
┌──────────────────────────────────┐
│  系统提示词 (System Prompt)       │ ← 定义角色和行为规范
│  + 技能注入 (Skills)              │ ← 注入 SOP 流程指令
├──────────────────────────────────┤
│  推理引擎 (Hermes)                │ ← ReAct 循环：思考→行动→观察
│    ↓         ↓        ↓          │
│  调用工具  检索知识库  委派子代理  │
├──────────────────────────────────┤
│  中间件层 (guardrails/verification)│ ← 安全护栏 + 人工确认
├──────────────────────────────────┤
│  流式输出 (token + thinking + 工具)│ ← SSE 实时返回
└──────────────────────────────────┘
   ↓
用户看到回复 + 思考过程 + 工具调用详情`}</pre>
            </div>
          </Section>

          {/* ===== 2. 创建 ===== */}
          <Section id="create" icon="✨" title="创建智能体" subtitle="从哪里开始？">
            <p className="text-sm text-muted-foreground">
              进入 <strong className="text-primary">智能体</strong> 页面，点击右上角
              <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-primary">+ 新建智能体</code>
              按钮，进入编辑器页面。
            </p>
            <ConfigCard icon="📐" title="编辑器布局" >
              <p>编辑器采用<strong>左右分栏</strong>布局：</p>
              <ul className="ml-4 mt-1 list-disc space-y-1">
                <li><strong className="text-foreground">左侧</strong>：6 大配置模块（基础信息、模型配置、工具、知识库、技能、高级设置），以可折叠卡片形式展示</li>
                <li><strong className="text-foreground">右侧</strong>：调试预览面板，可实时测试智能体对话、查看工具调用和思考过程</li>
              </ul>
              <p className="mt-2">填写名称后点击「保存」即可创建。所有配置随时可修改，保存后立即生效。</p>
            </ConfigCard>
            <Tip type="warn">未保存的修改会触发离开确认提示。建议先填写名称并保存，再逐步完善其他配置。</Tip>
          </Section>

          {/* ===== 3. 基础信息 ===== */}
          <Section id="basic" icon="📝" title="基础信息" subtitle="智能体的「身份证」">
            <ConfigCard icon="📛" title="名称" name="name">
              智能体的显示名称，必填。会显示在智能体列表、对话页面侧边栏、监控记录中。
              建议用简洁明确的名称，如「告警研判助手」「资产查询机器人」。
            </ConfigCard>
            <ConfigCard icon="📄" title="描述" name="description">
              一句话描述智能体的用途。帮助用户快速了解功能，也作为工具搜索时的匹配文本。
              例如：「接收安全告警，自动查询资产归属和威胁情报，给出处置建议」。
            </ConfigCard>
            <ConfigCard icon="😊" title="头像" name="avatar">
              智能体的 Emoji 头标（如 🤖、🛡️、🔍）。显示在对话列表和消息气泡中，
              帮助用户视觉区分不同智能体。留空则默认显示首字母。
            </ConfigCard>
            <ConfigCard icon="👋" title="问候语" name="greeting">
              用户进入对话时智能体自动发送的欢迎消息。用于引导用户提问。
              例如：「你好！我是告警研判助手，请发送告警信息，我会帮你分析。」
              <Tip>留空则不自动发送问候语。建议设置，提升用户体验。</Tip>
            </ConfigCard>
            <ConfigCard icon="💡" title="建议问题" name="suggested_questions">
              对话页面展示的快捷提问按钮。用户点击即可快速发送预设问题。
              建议设置 3-5 个典型问题，覆盖智能体的核心功能场景。
              例如：['查询 IP 198.51.100.5 的资产信息', '分析告警：源IP 1.2.3.4 端口扫描']
            </ConfigCard>
          </Section>

          {/* ===== 4. 推理引擎 ===== */}
          <Section id="engine" icon="⚙️" title="推理引擎" subtitle="Hermes，平台的推理核心">
            <p className="text-sm text-muted-foreground">
              推理引擎决定了智能体的核心运行机制。平台统一采用 Hermes 引擎，无需手动选择。
            </p>
            <div className="grid gap-3">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-foreground">Hermes 引擎</h4>
                </div>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 支持工具调用（ReAct 循环）</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 支持子代理委派（delegate_task）</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 支持技能注入与框架级工具</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 思考过程独立 SSE 事件展示</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 工具并行执行 + 超时保护</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 中间件层（护栏/验证/人工确认）</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-success" /> 执行记录自动创建（监控可见）</li>
                </ul>
              </div>
            </div>
            <Tip type="tip">
              <strong>Hermes 是平台唯一的推理引擎</strong>，提供完整的工具链和监控能力。
            </Tip>
          </Section>

          {/* ===== 5. 模型配置 ===== */}
          <Section id="model" icon="🧠" title="模型配置" subtitle="选择大脑，调节性格">
            <ConfigCard icon="🔗" title="模型配置" name="model_config_id">
              选择智能体使用的 LLM 模型（需先在<strong>模型设置</strong>页面配置）。
              不同模型在能力、速度、成本上有差异：
              <ul className="ml-4 mt-1 list-disc space-y-0.5 text-xs">
                <li><strong className="text-foreground">Claude 3.5 Sonnet</strong>：推理强、工具调用稳定，推荐用于安全分析</li>
                <li><strong className="text-foreground">GPT-4o</strong>：通用能力强、响应快</li>
                <li><strong className="text-foreground">GLM-4</strong>：国产模型，中文理解优秀</li>
                <li><strong className="text-foreground">DeepSeek</strong>：性价比高，适合高频调用</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🌡️" title="温度" name="temperature">
              控制模型输出的随机性，范围 0.0 ~ 2.0。
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded border border-border bg-muted p-2">
                  <div className="font-semibold text-foreground">0 ~ 0.3</div>
                  <div className="text-muted-foreground">严谨确定。适合安全分析、工具调用、数据查询</div>
                </div>
                <div className="rounded border border-border bg-muted p-2">
                  <div className="font-semibold text-foreground">0.4 ~ 0.8</div>
                  <div className="text-muted-foreground">均衡。适合对话助手、通用问答</div>
                </div>
                <div className="rounded border border-border bg-muted p-2">
                  <div className="font-semibold text-foreground">0.9 ~ 2.0</div>
                  <div className="text-muted-foreground">创造性。适合文案生成、头脑风暴</div>
                </div>
              </div>
              <Tip>安全运营场景建议设为 <strong>0.3</strong> 以下，确保分析结论稳定可靠。</Tip>
            </ConfigCard>
            <ConfigCard icon="📏" title="最大 Token 数" name="max_tokens">
              模型单次回复的最大 token 数。影响回复长度上限。
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>1024：简短回复，适合工具调用场景</li>
                <li>2048：标准回复，适合大多数对话</li>
                <li>4096+：长文本输出，适合报告生成</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🔄" title="上下文轮数" name="context_turns">
              智能体记忆的历史对话轮数。设为 10 表示保留最近 10 轮对话作为上下文。
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>轮数越大 → 上下文越完整，但 token 消耗越多</li>
                <li>轮数越小 → 省 token，但可能遗忘早期信息</li>
                <li>建议 5~20 轮，按场景调整</li>
              </ul>
            </ConfigCard>
          </Section>

          {/* ===== 6. 系统提示词 ===== */}
          <Section id="prompt" icon="💬" title="系统提示词" subtitle="定义智能体的角色和行为规范">
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">系统提示词（System Prompt）</strong>
              是智能体最重要的配置之一。它定义了智能体的角色、职责、行为边界和输出格式。
              每次对话都会作为系统消息发送给模型。
            </p>
            <ConfigCard icon="✍️" title="system_prompt" name="system_prompt">
              编写要点：
              <ol className="ml-4 mt-1 list-decimal space-y-1 text-xs">
                <li><strong className="text-foreground">角色定义</strong>：「你是一名 SOC 安全分析师」</li>
                <li><strong className="text-foreground">能力边界</strong>：明确能做什么、不能做什么</li>
                <li><strong className="text-foreground">工具使用指引</strong>：何时调用哪个工具的决策规则</li>
                <li><strong className="text-foreground">输出格式</strong>：要求的回复结构（表格、JSON、分点等）</li>
                <li><strong className="text-foreground">安全约束</strong>：危险操作前需确认、不泄露敏感信息</li>
              </ol>
            </ConfigCard>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">示例：告警研判助手</div>
              <pre className="overflow-x-auto text-xs text-muted-foreground">{`你是一名 SOC 高级安全分析师，负责告警研判。

## 工作流程
1. 收到告警后，先用 check_whitelist 检查源 IP 是否在白名单
2. 用 get_asset_info 查询目标 IP 的资产归属
3. 用 get_threat_intel 查询源 IP 的威胁情报
4. 综合以上信息，给出处置建议

## 输出格式
- 告警概述（一句话）
- 分析过程（分点列出查询结果）
- 处置建议（封禁/观察/放行 + 理由）
- 风险等级（高/中/低）

## 约束
- 白名单 IP 不触发封禁
- 关键资产被攻击时风险等级至少为中
- 封禁操作需通过 block_ip_on_firewall 工具执行`}</pre>
            </div>
            <Tip>
              系统提示词支持 <code className="rounded bg-secondary px-1 text-primary">{'{{变量名}}'}</code> 模板变量，
              会被「高级设置」中的变量值替换。例如
              <code className="ml-1 rounded bg-secondary px-1 text-primary">{'{{company_name}}'}</code> 会被替换为对应变量值。
            </Tip>
          </Section>

          {/* ===== 7. 工具配置 ===== */}
          <Section id="tools" icon="🔧" title="工具配置" subtitle="为智能体装配「双手」">
            <p className="text-sm text-muted-foreground">
              工具是智能体执行实际操作的能力。在<strong>工具配置</strong>卡片中勾选要启用的工具。
              智能体在对话中会根据需要自动调用这些工具。
            </p>
            <ConfigCard icon="☑️" title="启用工具" name="enabled_tools">
              勾选的工具会被注入智能体的工具列表。模型在 ReAct 循环中可自主决定调用哪个工具。
              <Tip type="warn">只勾选必要的工具。工具过多会增加模型决策难度，降低准确率。</Tip>
            </ConfigCard>
            <ConfigCard icon="🎨" title="工具类型标识">
              工具列表中每个工具有颜色标识：
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded border border-border bg-secondary px-2 py-0.5 text-muted-foreground">Code（灰色）</span>
                <span className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">HTTP（蓝色）</span>
                <span className="rounded border border-purple-500/40 bg-primary/10 px-2 py-0.5 text-primary">框架内置（紫色）</span>
              </div>
              <ul className="ml-4 mt-2 list-disc text-xs">
                <li><strong className="text-foreground">Code</strong>：Python 代码工具，在沙箱中执行</li>
                <li><strong className="text-foreground">HTTP</strong>：调用外部 API，支持 GET/POST/DELETE 等方法</li>
                <li><strong className="text-foreground">框架内置</strong>：引擎级工具（委派/澄清/规划等），不可编辑/删除</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🚦" title="HTTP 方法颜色">
              HTTP 工具按方法区分颜色，便于安全识别：
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-success/20 px-2 py-0.5 text-success">GET（绿色·查询）</span>
                <span className="rounded bg-warning/20 px-2 py-0.5 text-warning">POST（橙色·创建）</span>
                <span className="rounded bg-destructive/20 px-2 py-0.5 text-destructive">DELETE（红色·删除）</span>
              </div>
            </ConfigCard>
            <ConfigCard icon="🔧" title="工具高级配置" name="tool_configs">
              展开工具项可配置：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground">执行时机</strong>：自动执行 / 需用户确认（危险操作建议设为确认）</li>
                <li><strong className="text-foreground">参数映射</strong>：将上下文变量自动映射到工具参数</li>
                <li><strong className="text-foreground">异常处理</strong>：工具失败时的行为（继续/中止/询问用户）</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🔍" title="工具搜索状态" name="tool_search">
              <strong className="text-foreground">Hermes 引擎专属功能</strong>。当智能体启用的工具较多时，
              所有工具的参数定义会占用大量上下文 token。此功能将部分工具标记为
              <strong className="text-foreground">「可延迟」</strong>，不直接注入上下文，而是按需检索。
              <ul className="ml-4 mt-2 list-disc text-xs">
                <li><strong className="text-foreground">auto（推荐）</strong>：自动判断，可延迟工具的 schema token 超过上下文窗口阈值的 10% 时激活检索</li>
                <li><strong className="text-foreground">on</strong>：只要有可延迟工具就激活检索</li>
                <li><strong className="text-foreground">off</strong>：关闭，所有工具直接注入上下文（工具少时用）</li>
              </ul>
              <p className="mt-2 text-xs">
                激活后，智能体通过 <code className="text-primary">tool_search</code> 工具按关键词检索可用工具，
                再用 <code className="text-primary">tool_call</code> 执行，从而节省上下文空间。
              </p>
              <Tip type="warn">工具少于 10 个时无需开启，直接注入上下文即可。</Tip>
            </ConfigCard>
            <ConfigCard icon="📄" title="文档读取工具" name="read_document">
              <p className="text-xs">
                <code className="text-primary">read_document</code> 和{' '}
                <code className="text-primary">list_documents</code> 是内置工具，用于
                <strong className="text-foreground">直接读取上传的未分段文档原文</strong>，而非读取知识库分段处理后的内容。
              </p>
              <ul className="ml-4 mt-2 list-disc text-xs">
                <li><strong className="text-foreground">适用场景</strong>：需要完整文档内容时（如通读完整报告、解析整张表格、按原文顺序分析）</li>
                <li><strong className="text-foreground">与知识库的区别</strong>：知识库做精准片段检索（RAG），返回最相关的若干分段；此工具读取整篇文档原文</li>
                <li><strong className="text-foreground">使用方法</strong>：先调用 <code className="text-primary">list_documents</code> 获取文件 ID 列表，再用 <code className="text-primary">read_document(file_id=X)</code> 读取指定文档</li>
                <li><strong className="text-foreground">超长保护</strong>：内容超过 20000 字符会自动截断，避免耗尽上下文</li>
              </ul>
              <Tip>
                无需额外配置：这两个工具为框架内置，智能体勾选后即可在对话中调用。
                用户在对话中上传的文件会自动可被这两个工具读取。
              </Tip>
            </ConfigCard>
            <Tip type="danger">
              危险操作工具（如封禁 IP、删除文件）务必设置为<strong>需用户确认</strong>执行。
              中间件层会在调用前弹出确认提示。
            </Tip>
          </Section>

          {/* ===== 8. 知识库 ===== */}
          <Section id="knowledge" icon="📚" title="知识库对接" subtitle="让智能体「读过」你的私有文档">
            <p className="text-sm text-muted-foreground">
              知识库让智能体基于你的私有文档回答问题。在<strong>知识库</strong>卡片中勾选要关联的知识库。
            </p>
            <ConfigCard icon="🔗" title="启用知识库" name="enabled_kbs">
              勾选后，智能体对话时会自动检索知识库内容，作为回答依据。
              检索结果会注入上下文，模型基于检索到的文档片段生成回答。
            </ConfigCard>
            <ConfigCard icon="⚙️" title="知识库配置（在知识库页面）">
              每个知识库可独立配置：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground">分块模式</strong>：固定大小 / 按段落 / 按标题</li>
                <li><strong className="text-foreground">索引模式</strong>：向量检索 / 全文检索 / 混合检索</li>
                <li><strong className="text-foreground">Embedding 模型</strong>：文本向量化模型</li>
                <li><strong className="text-foreground">检索设置</strong>：Top-K 数量、相似度阈值</li>
              </ul>
            </ConfigCard>
            <Tip>
              知识库适合存放<strong>文档类知识</strong>（安全策略、操作手册、FAQ）。
              实时数据（资产信息、威胁情报）应通过工具查询，而非知识库。
            </Tip>
          </Section>

          {/* ===== 9. 技能 ===== */}
          <Section id="skills" icon="🎯" title="技能注入" subtitle="用自然语言编写 SOP 流程">
            <p className="text-sm text-muted-foreground">
              技能是以自然语言编写的流程指令，注入到系统提示词中，引导智能体按 SOP 执行。
              与工具不同，技能不是可调用的函数，而是<strong>行为规范</strong>。
            </p>
            <ConfigCard icon="🎯" title="启用技能" name="enabled_skills">
              在<strong>技能注入</strong>卡片中勾选要启用的技能。技能内容会拼接到系统提示词末尾，
              智能体在对话中遵循这些指令。
              <Tip>禁用技能后立即生效，无需重启。技能内容支持变量替换。</Tip>
            </ConfigCard>
            <ConfigCard icon="✍️" title="编写技能（在技能页面）">
              技能用自然语言编写，无需代码。例如「告警研判SOP」：
              <pre className="mt-2 overflow-x-auto rounded bg-background p-3 text-xs text-muted-foreground">{`## 告警研判标准流程
1. 提取告警关键字段：源IP、目标IP、告警类型
2. 查询源IP白名单状态 → 命中则终止研判，标记为误报
3. 查询目标IP资产归属 → 关键资产提升优先级
4. 查询源IP威胁情报 → 恶意IP触发封禁建议
5. 输出研判报告，包含处置建议和风险等级`}</pre>
            </ConfigCard>
            <Tip type="tip">
              技能适合编写<strong>流程性指令</strong>（先做什么、再做什么）。
              工具适合<strong>执行性操作</strong>（查询、封禁、读取文件）。两者配合使用效果最佳。
            </Tip>
          </Section>

          {/* ===== 10. 中间件 ===== */}
          <Section id="middleware" icon="🧩" title="中间件配置" subtitle="安全护栏 + 人工确认 + 验证机制">
            <p className="text-sm text-muted-foreground">
              中间件是工具调用前后的拦截层，提供安全防护和人工把关能力。
              在工具配置区域的<strong>中间件配置</strong>中设置（仅 Hermes 引擎支持）。
            </p>
            <ConfigCard icon="🛡️" title="安全护栏（Guardrails）">
              在工具调用前拦截不安全请求：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground">关键词过滤</strong>：拦截含敏感词的输入/输出</li>
                <li><strong className="text-foreground">PII 脱敏</strong>：自动遮盖身份证号、手机号等</li>
                <li><strong className="text-foreground">注入防护</strong>：检测 prompt injection 攻击</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="✅" title="验证机制（Verification）">
              危险操作前要求人工确认：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground">自动执行</strong>：工具直接运行，无需确认</li>
                <li><strong className="text-foreground">需用户确认</strong>：弹出确认提示，用户同意后执行</li>
                <li>建议对删除、封禁、写入类工具启用确认</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="⏱️" title="执行时机">
              控制工具何时触发：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground">自动</strong>：模型决定调用时立即执行</li>
                <li><strong className="text-foreground">用户确认</strong>：模型决定调用后，等待用户确认</li>
              </ul>
            </ConfigCard>
          </Section>

          {/* ===== 11. 高级设置 ===== */}
          <Section id="advanced" icon="🎛️" title="高级设置" subtitle="精细调控智能体行为">
            <ConfigCard icon="🔁" title="最大迭代次数" name="max_iterations">
              ReAct 循环的最大轮数。每轮包含一次「思考→工具调用→观察」。
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>3-5：简单任务（单次查询、直接回答）</li>
                <li>5-10：多步骤任务（查询多个工具、综合分析）</li>
                <li>10+：复杂编排（委派子代理、多轮推理）</li>
              </ul>
              <Tip type="warn">迭代次数过多会增加延迟和 token 消耗。建议按需设置，默认 5 轮足够大多数场景。</Tip>
            </ConfigCard>
            <ConfigCard icon="💾" title="长期记忆" name="enable_memory">
              开启后，智能体可使用 save_memory / recall_memory 工具跨对话记住信息。
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>适合需要记住用户偏好的个人助手</li>
                <li>记忆存储在服务端 JSON 文件中，持久化保留</li>
                <li>关闭后智能体不会主动使用记忆工具</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🎨" title="语气风格" name="tone_style">
              控制回复的语言风格：
              <ul className="ml-4 mt-1 grid grid-cols-2 gap-1 text-xs">
                <li>👔 <strong>专业严谨</strong>：安全分析首选</li>
                <li>😄 <strong>幽默风趣</strong>：轻松场景</li>
                <li>☕ <strong>轻松随意</strong>：日常对话</li>
                <li>🎩 <strong>正式礼貌</strong>：商务场景</li>
                <li>✂️ <strong>简洁明了</strong>：快速问答</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="📊" title="变量" name="variables">
              键值对形式的自定义变量，可在系统提示词中通过
              <code className="mx-1 rounded bg-secondary px-1 text-primary">{'{{key}}'}</code>
              引用。
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>例如：company_name = 「XX安全部」</li>
                <li>提示词中写「你服务于 {'{{company_name}}'}」→ 自动替换</li>
                <li>适合多环境部署（同一智能体适配不同组织）</li>
              </ul>
            </ConfigCard>
          </Section>

          {/* ===== 12. 调试 ===== */}
          <Section id="debug" icon="🐞" title="调试与测试" subtitle="右侧面板实时验证">
            <p className="text-sm text-muted-foreground">
              编辑器右侧的<strong>调试预览</strong>面板支持实时测试智能体对话。
              输入消息后发送，可观察完整的推理过程。
            </p>
            <ConfigCard icon="📊" title="流式输出">
              调试面板展示 4 类实时事件：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li><strong className="text-foreground inline-flex items-center gap-1"><Brain className="h-3 w-3" /> 思考过程</strong>：模型的推理链（可折叠）</li>
                <li><strong className="text-foreground inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" /> 回复内容</strong>：逐 token 流式输出</li>
                <li><strong className="text-foreground inline-flex items-center gap-1"><Wrench className="h-3 w-3" /> 工具调用</strong>：每个工具的开始/结束/结果（可折叠）</li>
                <li><strong className="text-foreground inline-flex items-center gap-1"><GitBranch className="h-3 w-3" /> 子代理委派</strong>：按 subagent_id 分组，可展开查看嵌套事件</li>
              </ul>
            </ConfigCard>
            <ConfigCard icon="🔄" title="状态标识">
              <ul className="ml-4 list-disc text-xs">
                <li className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-success" /> 绿色：工具成功完成</li>
                <li className="inline-flex items-center gap-1"><X className="h-3 w-3 text-destructive" /> 红色：工具执行出错（可查看错误详情）</li>
                <li className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> 脉冲动画：工具正在执行中</li>
              </ul>
            </ConfigCard>
            <Tip type="tip">
              修改配置后需点击「保存」才会生效。调试时会自动保存当前配置。
              流式输出使用 requestAnimationFrame 节流，保证流畅渲染。
            </Tip>
          </Section>

          {/* ===== 13. 监控 ===== */}
          <Section id="monitor" icon="📈" title="监控与追溯" subtitle="对话记录全程可查">
            <ConfigCard icon="📋" title="执行记录">
              每次对话（Hermes 引擎）自动创建 Execution 记录，包含：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>输入消息、回复内容</li>
                <li>工具调用列表及结果</li>
                <li>执行状态（running/success/failed）</li>
                <li>耗时统计</li>
              </ul>
              在智能体列表点击「监控」按钮查看历史记录。
            </ConfigCard>
            <ConfigCard icon="📜" title="日志中心">
              「运行监控」分组下的<strong>日志中心</strong>页面可查看系统所有日志，
              包括操作日志、执行记录、执行日志、模型调用日志，支持多维度筛选与保留策略配置。
            </ConfigCard>
            <ConfigCard icon="📊" title="执行监测">
              <strong>执行监测</strong>页面提供实时监控看板，展示：
              <ul className="ml-4 mt-1 list-disc text-xs">
                <li>执行成功率、平均耗时</li>
                <li>工具调用统计</li>
                <li>错误分析</li>
              </ul>
            </ConfigCard>
          </Section>

          {/* ===== 14. 最佳实践 ===== */}
          <Section id="best-practices" icon="🏆" title="最佳实践" subtitle="来自实战的经验总结">
            <div className="space-y-3">
              <ConfigCard icon="1️⃣" title="先写提示词，再配工具">
                先在系统提示词中定义工作流程，再根据流程需要勾选对应工具。
                避免先勾一堆工具再想怎么用——这会让模型困惑。
              </ConfigCard>
              <ConfigCard icon="2️⃣" title="工具宜精不宜多">
                单个智能体启用 3-8 个工具最佳。工具超过 10 个时，
                可用 tool_search 工具按需检索（Hermes 引擎支持渐进式工具发现）。
              </ConfigCard>
              <ConfigCard icon="3️⃣" title="危险操作加护栏">
                封禁 IP、删除数据等操作务必设置「需用户确认」。
                宁可多一步确认，不可误操作。
              </ConfigCard>
              <ConfigCard icon="4️⃣" title="温度调低，分析才稳">
                安全分析场景温度 ≤ 0.3。高温会导致模型「创造性发挥」，
                在安全场景中这是危险的。
              </ConfigCard>
              <ConfigCard icon="5️⃣" title="技能编写流程，工具执行操作">
                技能用自然语言写「先做什么再做什么」；
                工具负责具体的查询和操作。两者分工明确。
              </ConfigCard>
              <ConfigCard icon="6️⃣" title="调试时关注思考过程">
                通过思考过程（thinking 事件）可以诊断模型为何做出某个决策。
                如果模型不调用工具，通常是系统提示词指引不够明确。
              </ConfigCard>
              <ConfigCard icon="7️⃣" title="复杂任务用委派">
                Hermes 引擎支持 delegate_task 工具委派子代理。
                将重复性子任务交给子代理，保持父上下文简洁。
                子代理拥有独立历史，goal 必须 self-contained。
              </ConfigCard>
            </div>
            <Tip type="tip">
              遇到问题？在<strong>日志中心</strong>查看执行记录与失败信息，
              或检查后端日志中的工具加载/执行信息。沙箱环境禁止 import 语句，
              工具代码需使用注入的模块（json/re/ipaddress/httpx 等）。
            </Tip>
          </Section>

          {/* 底部 */}
          <div className="mt-12 flex items-center justify-between border-t border-border pt-6">
            <button
              onClick={() => navigate('/studio')}
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              ← 返回智能体列表
            </button>
            <button
              onClick={() => navigate('/agents/new')}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-primary"
            >
              立即创建智能体 →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AgentTutorial
