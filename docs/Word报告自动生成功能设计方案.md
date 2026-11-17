# Word 报告自动生成功能设计方案

> 版本：v1.0　日期：2026-11-16　适用范围：SOAR 平台「报告中心」新模块
> 结论先行：**三段式方向正确，但顺序需要调整、边界需要收窄。** 最优路径是「确定性模板渲染内核 + 人工配置映射采集 + AI 仅做辅助」，而不是让 AI 端到端生成报告。

---

## 一、结论摘要（TL;DR）

1. **可行，但不要按"AI 先生成模板"的顺序落地。** 先做 1 条真实报告的确定性闭环（模板 → 采集 → 渲染 → 校验），再叠加 AI。否则 AI 生成的模板没有渲染内核承接，返工成本最高。
2. **AI 只产出"结构化模板规格（JSON）+ 占位符清单"，不直接产出 Word 二进制，也不参与填数。** 正式报告的数字必须来自确定性抽取，否则不可审计、不可复现。
3. **浏览器内"完整 Word 所见即所得编辑"是最大隐性成本，v1 不做。** 采用「结构化模板在线编辑 + 复杂模板离线 Word/WPS 编辑后上传校验 + 只读高保真预览」分级策略。
4. **三段式缺少两个关键环节：运行编排（调度/并发/重试）与校验审核（准确性/发布）。** 实际应为五段：模板资产化 → 配置 → 采集 → 渲染 → 校验审核发布。
5. **模板版本与映射配置必须解耦并做兼容性校验。** 模板一旦改动，旧映射可能静默失效，必须有 manifest diff + 配置迁移向导。
6. **推荐落地形态是"双通道"**：正式/周期报告走模板流水线；临时/探索性报告继续走现有 Agent `generate_document`。两者共享渲染内核与数据连接器。
7. **准确性保障的核心原则：缺失数据绝不静默填 0。** 统一用「失败标记 + 局部降级 + 校验报告 + 人工签收」兜底。

---

## 二、现状盘点：可直接复用的资产

| 现有能力 | 位置 | 在本方案中的复用方式 |
|---|---|---|
| 设备与设备动作（含鉴权、超时、重试、TLS、参数 Schema、请求体模板） | [device.py](file:///d:/trae%20project/soar-src/backend/app/models/device.py) | 作为「数据源注册中心」，新增 `category=query` 的查询类动作即可直接采集 |
| 设备动作执行器（httpx、SSRF 防护、调用日志） | [action_executor.py](file:///d:/trae%20project/soar-src/backend/app/devices/action_executor.py) | 采集器直接复用 `execute_device_action` 与 `record_device_call` |
| 声明式 HTTP 工具（method/headers/body/鉴权/JSONPath/重试） | [tool.py](file:///d:/trae%20project/soar-src/backend/app/models/tool.py) | 非设备类数据源（第三方 API）复用 `http_config` 配置模型 |
| Markdown 文档生成（docx/xlsx/md/pptx/pdf/html） | [tool_runner.py](file:///d:/trae%20project/soar-src/backend/app/core/tool_runner.py#L1286-L1360) | 保留为「临时报告通道」，与本方案的模板渲染内核分开 |
| GB/T 9704 公文版式引擎 | [govdoc.py](file:///d:/trae%20project/soar-src/backend/app/core/govdoc.py) | 作为渲染后的「版式规整器」，保证正式报告字体/行距/缩进 |
| 交付物管理（分类树、版本、SHA-256 判重、批量下载） | [deliverable.py](file:///d:/trae%20project/soar-src/backend/app/models/deliverable.py) | 报告审核通过后归档到交付物库 |
| 解析策略的草稿/发布/版本快照模式 | [parse_strategy.py](file:///d:/trae%20project/soar-src/backend/app/models/parse_strategy.py) | 模板与配置的版本管理直接照搬该模式 |
| Celery + Redis、审计日志、RBAC | `backend/app/tasks`、`audit_log`、`dependencies.py` | 报告运行异步化、全链路审计、权限控制 |
| Docx 前端预览 | `frontend/package.json` 的 `docx-preview` | 模板库/报告产物在线预览 |
| Agent/Hermes + 模型配置 | `backend/app/agent`、`llm_config` | 模板起草、映射建议、摘要润色 |

**关键结论**：本功能 60% 以上的基础设施已经存在，不需要另起炉灶。新增部分集中在「模板版本与占位符规范、映射配置、运行编排、校验器」四个域。

---

## 三、范围界定

### 3.1 本期范围

- 单份报告的模板化生成（Word 为主，预留 PDF 导出）
- 数据源：平台内设备动作、已配置的 HTTP 工具、平台内置数据（告警/资产/封禁等）
- 配置化：数据采集参数、字段抽取、占位符映射、轻量转换
- 运行：手动触发 + 定时触发 + API 触发
- 治理：版本管理、校验、审核、归档、审计

### 3.2 明确不做（v1）

- 浏览器内完整的 Word 所见即所得编辑（OnlyOffice/Collabora 级）
- 任意 Python/JavaScript 脚本作为数据转换（沙箱与可维护性风险）
- 让 LLM 直接生成报告数字或直接生成 OOXML
- 复杂排版对象（文本框、艺术字、SmartArt、嵌套域代码）的自动适配
- 多人在线协同编辑模板

---

## 四、三段式流程评估：问题、瓶颈与优化

### 4.1 第一阶段：AI Agent 生成初始模板草稿

| 编号 | 问题 | 严重度 | 说明与优化 |
|---|---|---|---|
| P1-1 | 输出物形态错误 | 高 | 让 LLM 直接产出 `.docx`/OOXML，样式、分页、编号不可控。**应输出结构化 JSON 模板规格（章节树 + 占位符 + 类型 + 示例值），由确定性渲染器生成 docx。** |
| P1-2 | 样式与规范漂移 | 高 | LLM 不了解企业模板规范与 GB/T 9704 细节。用「样式白名单 + govdoc 版式引擎 + 模板基线」约束，AI 只能选用白名单样式。 |
| P1-3 | 模板是长期资产，AI 是概率输出 | 高 | 同一提示两次生成结果不同，无法复现。AI 产物只能作为 `draft`，必须人工签收后冻结为 v1，且记录提示词、模型、输入摘要。 |
| P1-4 | 空白文档输入信息量太低 | 中 | "从零生成"质量取决于提示词，收益不稳定。**更优默认模式是"样例逆向"**：上传 1~2 份历史报告，AI 抽取章节结构、表格列、指标口径、占位符建议，准确率显著高于凭空生成。 |
| P1-5 | 占位符命名失控 | 中 | AI 容易产出 `var1`、`total_num_2`。必须使用受控命名规范 `域.指标[.属性]`，并做唯一性与命名合法性校验。 |
| P1-6 | 缺少可校验性 | 中 | AI 草稿必须同时产出「模板规格 + 占位符清单 + 建议数据源 + 缺失信息清单」，而不是只有一段正文。 |

**优化后的第一阶段产出物**：

```text
AI 输入：自然语言需求 / 历史样例 docx / 数据源元数据（设备动作 Schema）
AI 输出：
  1) template_spec.json     章节树、占位符、类型、示例值、必填标记
  2) template.docx          由渲染器根据 spec 生成（非 LLM 直接写 XML）
  3) mapping_suggestion.json 占位符 → 建议数据源/字段（仅建议，不生效）
  4) open_questions[]       信息缺口（如"高危漏洞的口径需确认"）
人工动作：审阅 → 修改 → 签收 → 发布 v1
```

### 4.2 第二阶段：模板库、可视化编辑与版本管理

| 编号 | 问题 | 严重度 | 说明与优化 |
|---|---|---|---|
| P2-1 | 浏览器内 Word WYSIWYG 被低估 | **极高** | `docx-preview` 只读；OnlyOffice/Collabora 需要独立服务、字体一致性、许可证与协同逻辑。**v1 分级处理**：结构化模板在线编辑；复杂/公文模板离线 Word 编辑后上传校验；只读预览用 docx-preview，最终保真预览用 LibreOffice 转 PDF。 |
| P2-2 | 模板版本与映射配置强耦合 | 高 | 模板删改占位符会让旧映射静默失效。必须：模板版本固定（pinned）、发布时做 manifest diff、旧配置标记"需迁移"并提供一键补映射向导。 |
| P2-3 | 二进制资产管理薄弱 | 中 | 只存路径会丢文件。需要文件哈希、大小、页数、字体清单、来源、上传人，并与版本记录一一对应。 |
| P2-4 | 预览与最终输出不一致 | 中 | 服务器缺中文字体会导致分页/换行变化。渲染容器必须安装模板所需字体，预览与产物使用同一套字体栈。 |
| P2-5 | 权限与发布失控 | 高 | 模板发布属于高风险操作，需独立权限 `report_template:publish` + 审计日志 + 双人复核（可配置）。 |
| P2-6 | 版本对比不可读 | 低 | 二进制 diff 无意义，应做 manifest 级 diff：新增/删除/重命名占位符、章节变更、表格列变更。 |

**优化后的版本模型**（照搬 ParseStrategy 的草稿/发布双态）：

```text
report_templates          模板主档（逻辑标识，稳定不变）
  └─ report_template_versions
       ├─ draft        编辑中，不参与运行
       ├─ published    运行唯一可选用版本
       └─ deprecated   历史版本，仅供回溯
report_configs            配置主档（绑定模板主档，不绑定具体版本）
  └─ report_config_versions
       ├─ draft
       └─ published  运行时会固化 template_version_id + config_version_no
```

### 4.3 第三阶段：数据映射 + 数据采集配置

| 编号 | 问题 | 严重度 | 说明与优化 |
|---|---|---|---|
| P3-1 | 设备接口高度异构 | 高 | 分页、鉴权、时间格式、错误码、限流各不相同。不要为每个设备写代码，统一走「设备动作 + 声明式配置」；新增设备只加动作配置。 |
| P3-2 | 只有"字段映射"不够 | 高 | 报告里大量指标需要聚合与口径转换（如"高危漏洞数"= 过滤 + 计数）。必须提供白名单转换算子：`to_int/to_float/date_format/map_values/count/sum/avg/join/truncate/mask/unit_convert`。 |
| P3-3 | 表格/图片/图表映射最复杂 | 高 | 表格需要「循环区域 + 列绑定 + 行数上限 + 排序」；图片需要 URL/Base64 下载与尺寸约束；图表需要先算数据再渲染。建议 v1 支持文本/数字/日期/表格，图片与图表放 v1.1。 |
| P3-4 | 串行采集导致分钟级耗时 | 高 | 10 个数据源 × 10s 超时 = 100s+。必须并行采集（全局信号量 + 单设备限流）、超时预算、缓存、熔断。 |
| P3-5 | 配置漂移无人维护 | 中 | 模板改了、设备接口升级了、映射没变 → 报告静默为空。需要「配置健康检查」：定时用样例数据 dry-run，失败即告警。 |
| P3-6 | 缺少可复现性 | 高 | 只存最终 docx，无法解释"这个 37 从哪来"。每次运行必须存「数据快照 + 血缘清单 + 配置版本」。 |
| P3-7 | 安全边界 | 高 | 凭据加密、SSRF、模板注入（Jinja2）、数据外泄、审计。复用现有 `decrypt_device_secret`、`validate_outbound_url`，并对模板启用沙箱。 |
| P3-8 | 配置界面复杂度过高 | 中 | 让用户从零填 JSONPath 不现实。必须「样例响应驱动」：先试调用拿到样例 JSON，再可视化点选字段，自动生成路径。 |

### 4.4 三段式缺失的环节

| 缺失环节 | 后果 | 补充设计 |
|---|---|---|
| 运行编排与调度 | 只能手工点，无法周期化 | 配置级 cron + 手动/API 触发 + 幂等键 |
| 数据快照与血缘 | 报告数字不可追溯 | `report_run_sources` 存每次请求/响应摘要/哈希 |
| 校验与审核发布 | 错误报告直接外发 | L0~L4 五层校验 + 审核状态机 |
| 权限与审计 | 谁改的、谁发的说不清 | RBAC + 全操作审计 |
| 观测与告警 | 失败无人知 | 运行成功率、耗时、失败原因 Top N、企业微信/邮件告警 |
| 回滚 | 发错版本无法恢复 | 模板/配置版本回滚 + 产物重新生成 |

### 4.5 建议的实际流程（五段式）

```text
① 模板资产化   上传/样例逆向/AI 起草 → 规格校验 → 人工签收 → 发布 vN
② 配置          选模板版本 → 配数据源 → 试调用 → 字段抽取 → 映射 → 转换 → 试渲染
③ 采集          并行拉取 → 抽取 → 转换 → L1 校验 → 数据快照
④ 渲染          绑定快照 → docxtpl 渲染 → 版式规整 → L2 校验
⑤ 校验发布      重开校验 → L3 交叉核对 → 生成校验报告 → 人工签收 → 归档交付物
```

---

## 五、总体技术架构

### 5.1 架构图

```text
┌──────────────────────────── 前端 React 19 + Tailwind ────────────────────────────┐
│ 模板库 │ 模板编辑/预览 │ 配置向导(采集→抽取→映射→预览) │ 运行中心 │ 审核发布 │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ REST / SSE（运行进度）
┌───────────────────────────────▼──────────── FastAPI 路由层 ──────────────────────┐
│ report_templates │ report_configs │ report_runs │ report_artifacts │ report_ai   │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────── 领域服务 app/report ─────────────────┐
│ TemplateService │ ManifestParser │ MappingService │ Collector │ Transformer      │
│ Renderer(docxtpl+govdoc) │ Validator(L0-L3) │ RunOrchestrator │ AIDrafter        │
│ ArtifactService │ CompatibilityChecker                                          │
└───┬───────────────┬───────────────┬───────────────┬───────────────┬──────────────┘
    │               │               │               │               │
 DeviceAction    Tool.http      docxtpl        python-docx      Deliverable
 (现网设备)      (第三方API)     Jinja2沙箱      读回校验          AgentFile
    │               │               │
┌───▼───────────────▼───────────────▼──────────────────────────────────────────────┐
│ PostgreSQL(JSONB) │ Redis/Celery │ 文件卷 uploads/report_{templates,artifacts}   │
│ LibreOffice(转PDF) │ 中文字体包   │ 审计日志 / 通知                               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 部署形态

- **API**：随现有 `soar-backend` 容器，新增路由前缀 `/api/v1/report-*`
- **执行器**：Celery 独立队列 `report`，与现有 `worker-dev` 同镜像、独立并发度，避免报告任务挤占工作流任务
- **LibreOffice**：v1 直接装进 worker 镜像（`soffice --headless --convert-to pdf`）；量大后再拆 sidecar
- **存储**：沿用本地卷；`uploads/report_templates/{template_id}/{version_no}.docx`、`uploads/report_artifacts/{run_id}.docx`，数据库存相对路径 + SHA-256

### 5.3 关键设计原则

1. **确定性优先**：同一「模板版本 + 配置版本 + 数据快照」必须渲染出内容一致的文档（仅时间戳等显式变量可变）。
2. **数据与渲染分离**：采集阶段输出扁平化 `data_context`，渲染阶段只做绑定，不发起网络请求。
3. **失败显式化**：任何缺失、超时、解析失败都进入 `validation_report`，不允许静默降级为零值。
4. **AI 旁路**：AI 不进入正式运行链路，只在「起草/建议/摘要」三个人工确认节点出现。
5. **可回滚**：模板、配置、产物均有版本与哈希。

---

## 六、模块划分

### 6.1 后端模块

| 模块 | 职责 | 输入 | 输出 | 复用/新增 |
|---|---|---|---|---|
| `report/template_service` | 模板 CRUD、上传、发布、回滚、权限 | docx 文件、元数据 | 模板与版本记录 | 新增 |
| `report/manifest_parser` | 解析 docx 中的占位符、章节、表格结构 | docx | `manifest_json` | 新增（python-docx） |
| `report/ai_drafter` | 模板规格起草、样例逆向、映射建议 | 需求文本/样例/数据源元数据 | `template_spec` + 建议 | 新增（复用 LLM 配置） |
| `report/mapping_service` | 占位符绑定、类型校验、兼容性检查 | manifest + 映射配置 | 绑定计划 | 新增 |
| `report/collector` | 并行采集设备/HTTP 数据源 | 数据源配置、运行参数 | 原始响应 + 元数据 | 新增（复用 action_executor） |
| `report/transformer` | JSONPath 抽取 + 白名单算子转换 | 原始响应 + 抽取规则 | `data_context` | 新增 |
| `report/renderer` | docxtpl 渲染、表格循环、图片、版式规整 | 模板版本 + `data_context` | docx 字节流 | 新增（复用 govdoc） |
| `report/validator` | L0~L3 校验、交叉核对、残留占位符检测 | 配置/数据/产物 | 校验报告 | 新增 |
| `report/run_orchestrator` | 状态机、重试、超时、并发、快照 | 运行请求 | 运行记录 + 产物 | 新增（Celery） |
| `report/artifact_service` | 产物落盘、PDF 导出、归档交付物 | docx | 产物记录 | 新增（复用 Deliverable） |
| `report/compatibility` | 模板发布时检查存量配置兼容性 | 新旧 manifest | 影响清单 | 新增 |

### 6.2 前端模块

| 页面/组件 | 职责 |
|---|---|
| 模板库列表 | 分类、搜索、状态、版本、使用次数、最近运行 |
| 模板详情/编辑 | 元数据编辑；结构化章节编辑；占位符管理；只读预览；版本时间线；manifest diff |
| 模板上传向导 | 上传 → 解析结果确认 → 未识别占位符处理 → 发布 |
| AI 起草面板 | 输入需求/上传样例 → 查看 AI 规格 → 差异对比 → 采纳/放弃 |
| 配置向导（4 步） | ① 数据源 ② 字段抽取 ③ 映射绑定 ④ 试运行预览 |
| 数据源测试面板 | 发起试调用、展示样例响应树、点选字段生成路径、显示耗时/状态码 |
| 映射工作台 | 左：占位符树；右：字段树；中间拖拽/点选绑定；未映射高亮；类型不匹配告警 |
| 运行中心 | 运行列表、实时进度（SSE）、失败原因、重试、下载、校验报告 |
| 审核发布 | 报告预览、校验结果、批注、通过/驳回、归档到交付物 |

### 6.3 数据模型

```text
report_templates
  id, code(unique), name, category, description, status(draft/published/archived),
  current_version_id, owner_id, tags, created_by, created_at, updated_at

report_template_versions
  id, template_id, version_no, file_path, file_hash, file_size, page_count,
  manifest_json, source(upload/ai_draft/manual), ai_draft_id, changelog,
  status(draft/published/deprecated), published_by, published_at

report_configs
  id, template_id, name, description, status(draft/published/disabled),
  schedule_cron, timezone, output_name_pattern, notify_channels,
  created_by, created_at, updated_at

report_config_versions
  id, config_id, version_no, template_version_id, params_schema_json,
  data_sources_json, mapping_json, transform_json, degradation_policy_json,
  changelog, status(draft/published/deprecated), published_by, published_at

report_runs
  id, config_id, config_version_no, template_version_id, trigger_type(manual/schedule/api/agent),
  trigger_user_id, params_json, idempotency_key, status, started_at, finished_at,
  duration_ms, error_code, error_message, stats_json, validation_json,
  data_snapshot_json, artifact_id, created_at

report_run_sources
  id, run_id, source_key, source_type, device_id, action_id, request_summary,
  status_code, latency_ms, retry_count, cache_hit, status, error_code,
  error_message, response_hash, response_size, fetched_at

report_artifacts
  id, run_id, file_path, file_name, file_hash, file_size, pdf_path,
  status(draft/pending_review/approved/rejected), reviewer_id, review_comment,
  published_deliverable_id, created_at
```

设计要点：
- `manifest_json` 是模板与配置之间的契约，映射只引用其中的占位符 `id/token`；
- `report_runs` 固化 `template_version_id + config_version_no`，保证历史可复现；
- `data_snapshot_json` 存扁平化后的最终取值（含每个值的来源与时间），用于审计与重新渲染；
- `idempotency_key = config_id + 周期标识`，防止定时任务重复生成。

---

## 七、核心配置模型

### 7.1 模板规格（manifest）

```json
{
  "format_version": 1,
  "styles": ["GB9704_TITLE", "GB9704_H1", "GB9704_BODY", "TABLE_GRID"],
  "sections": [
    {"id": "s1", "title": "一、总体情况", "required": true},
    {"id": "s2", "title": "二、漏洞明细", "required": true}
  ],
  "placeholders": [
    {
      "id": "p_total_alert",
      "token": "summary.total_alert",
      "label": "告警总数",
      "type": "number",
      "required": true,
      "format": {"decimals": 0, "thousands": true},
      "location": {"paragraph_index": 12}
    },
    {
      "id": "p_vuln_table",
      "token": "table.vuln",
      "label": "漏洞明细表",
      "type": "table",
      "required": true,
      "columns": [
        {"key": "asset", "label": "资产", "type": "text", "width_cm": 4},
        {"key": "level", "label": "等级", "type": "enum"},
        {"key": "count", "label": "数量", "type": "number"}
      ],
      "max_rows": 200
    }
  ]
}
```

### 7.2 数据源配置

```json
{
  "source_key": "fw_core",
  "source_type": "device_action",
  "device_id": 12,
  "action_id": 34,
  "params": {
    "start_time": "{{run.start_time}}",
    "end_time": "{{run.end_time}}"
  },
  "pagination": {
    "type": "page",
    "page_param": "page",
    "size_param": "page_size",
    "page_size": 100,
    "max_pages": 20
  },
  "timeout_seconds": 10,
  "retry": {"max_attempts": 2, "backoff": "exponential", "jitter": true},
  "rate_limit": {"per_device_qps": 2},
  "cache": {"ttl_seconds": 60, "scope": "run"},
  "on_error": "degrade_mark"
}
```

### 7.3 映射配置

```json
{
  "bindings": [
    {
      "placeholder_id": "p_total_alert",
      "source_key": "fw_core",
      "path": "$.data.total",
      "transforms": [{"op": "to_int"}],
      "required": true,
      "on_missing": "fail"
    },
    {
      "placeholder_id": "p_vuln_table",
      "source_key": "xdr_01",
      "path": "$.data.items[*]",
      "type": "table",
      "columns": {
        "asset": {"path": "$.host_name", "transforms": [{"op": "truncate", "length": 50}]},
        "level": {"path": "$.severity", "transforms": [{"op": "map_values", "map": {"1": "低", "2": "中", "3": "高", "4": "严重"}}]},
        "count": {"path": "$.count", "transforms": [{"op": "to_int"}]}
      },
      "sort": [{"by": "count", "order": "desc"}],
      "limit": 200,
      "on_missing": "degrade_mark"
    }
  ],
  "cross_checks": [
    {"type": "sum_equals", "detail": "table.vuln.count", "summary": "summary.vuln_total", "tolerance": 0},
    {"type": "range", "field": "summary.percent", "min": 0, "max": 100},
    {"type": "date_within", "field": "summary.latest_time", "range": "run.period"}
  ]
}
```

**转换算子白名单**（禁止任意代码）：`to_int`、`to_float`、`round`、`date_format`、`timezone`、`map_values`、`count`、`sum`、`avg`、`min`、`max`、`join`、`split`、`truncate`、`mask`、`unit_convert`、`default`。

---

## 八、交互逻辑与数据流转

### 8.1 模板生命周期

```text
上传/样例/AI 起草
      ↓
解析 manifest（占位符、章节、表格列）
      ↓ 有未识别占位符 → 人工标注
规格校验（命名唯一、类型合法、样式白名单、章节非空）
      ↓
保存 draft 版本
      ↓
预览（docx-preview 快速预览 / LibreOffice PDF 保真预览）
      ↓
发布 published vN（记录发布人、变更说明、影响配置清单）
      ↓
被配置引用（pinned version）
```

### 8.2 配置向导交互

**Step 1 数据源**
- 从「设备动作（查询类）」「HTTP 工具」「平台内置数据集」中选择
- 每选择一个即发起「试调用」，展示：状态码、耗时、响应大小、样例 JSON 树
- 试调用失败不允许进入下一步（可保存草稿）

**Step 2 字段抽取**
- 左侧展示样例响应树，右侧展示已选字段
- 点选节点自动生成 JSONPath（支持数组 `[*]`）
- 可设置分页、时间参数、过滤条件、排序

**Step 3 映射绑定**
- 左：模板占位符树（按章节分组，显示类型与必填）
- 右：可用字段树（按数据源分组）
- 拖拽或点选绑定；类型不匹配即时红色告警；未映射必填项顶部计数
- 提供「AI 建议映射」按钮：基于占位符名称/标签 + 字段路径相似度 + 样例值生成建议，逐条人工确认

**Step 4 试运行预览**
- 用当前配置真实采集一次，生成完整预览
- 同时展示：填充值表、校验报告、未解析占位符、耗时分解
- 通过后可发布配置版本

### 8.3 运行数据流

```text
触发（手动/定时/API）
  → 创建 run（固化模板版本 + 配置版本 + 参数 + 幂等键）
  → 解析 params_schema 校验入参
  → 并行采集（信号量限制）
       ├─ 设备动作：复用 execute_device_action
       ├─ HTTP 工具：复用 tool_http_runner
       └─ 内置数据集：直接查库
  → 每个源：JSONPath 抽取 → 算子转换 → 源级 L1 校验
  → 合并为 data_context（含 lineage）
  → L2 校验（必填、类型、范围、行数）
  → 数据快照落库
  → 渲染（docxtpl 沙箱 → 表格循环 → 版式规整）
  → L3 校验（读回 docx、占位符残留、表格行数、章节完整性、交叉核对）
  → 产物落盘 + 可选 PDF 转换
  → 校验报告生成
  → 状态：succeeded / partial / failed
  → 待审核 → 通过 → 归档交付物 / 驳回 → 回到配置或重跑
```

### 8.4 状态机

```text
run:     pending → collecting → extracting → rendering → validating
                                        ↘ failed（任一步不可恢复）
                                        ↘ partial（非必填字段降级）
         collecting/rendering → cancelled

artifact: draft → pending_review → approved → published（交付物）
                              ↘ rejected
```

### 8.5 关键 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/report-templates` | 列表 / 新建 |
| POST | `/api/v1/report-templates/upload` | 上传 docx 并解析 manifest |
| POST | `/api/v1/report-templates/{id}/ai-draft` | AI 起草/样例逆向 |
| POST | `/api/v1/report-templates/{id}/versions` | 创建新版本 |
| POST | `/api/v1/report-templates/{id}/versions/{v}/publish` | 发布（含兼容性检查） |
| GET | `/api/v1/report-templates/{id}/versions/{a}/diff/{b}` | manifest diff |
| POST | `/api/v1/report-configs` | 新建配置 |
| POST | `/api/v1/report-configs/{id}/test-source` | 数据源试调用 |
| POST | `/api/v1/report-configs/{id}/suggest-mapping` | AI 映射建议 |
| POST | `/api/v1/report-configs/{id}/preview` | 试渲染 |
| POST | `/api/v1/report-configs/{id}/publish` | 发布配置 |
| POST | `/api/v1/report-runs` | 触发运行 |
| GET | `/api/v1/report-runs/{id}/events` | SSE 进度 |
| POST | `/api/v1/report-runs/{id}/retry` | 重试 |
| GET | `/api/v1/report-runs/{id}/validation` | 校验报告 |
| POST | `/api/v1/report-artifacts/{id}/review` | 审核通过/驳回 |
| GET | `/api/v1/report-artifacts/{id}/download` | 下载（鉴权） |

---

## 九、准确性校验机制（L0~L4）

| 层级 | 时机 | 校验内容 | 失败处理 |
|---|---|---|---|
| **L0 配置期** | 保存/发布配置 | 模板规格 schema；占位符唯一且被引用；映射完整性；数据源可连通；JSONPath 在样例上可命中；转换算子合法 | 阻断发布，返回精确位置 |
| **L1 采集期** | 每个数据源返回后 | HTTP 状态/业务码；响应结构符合样例；必填字段非空；类型可转换；数值范围；行数预期；时间范围 | 按 `on_error` 策略：失败/标记降级/用快照 |
| **L2 渲染前** | 合并 data_context 后 | 所有必填占位符有值；表格行不为空（若必填）；图片可访问；总字数/行数不超限 | 阻断渲染，生成缺失清单 |
| **L3 产物期** | 渲染完成 | 读回 docx：无 `{{ }}` / `{% %}` 残留；表格行数匹配；必需章节存在；文档可打开；页数合理；交叉核对规则通过；可选 PDF 转换成功 | 标记 `partial` 或 `failed`，禁止自动发布 |
| **L4 人工** | 审核环节 | 业务口径确认、敏感信息检查、版式抽查 | 驳回并记录原因 |

**交叉核对规则**（可配置）：
- 明细求和 = 汇总值
- 百分比 ∈ [0, 100]
- 日期落在报告周期内
- 计数非负
- IP/域名/端口格式合法
- 表格行数 = 明细计数
- 同一指标多源取值差异超阈值时告警

**反静默失败原则**：
- 缺失值展示为 `—` 或 `数据获取失败（SRC_TIMEOUT）`，绝不填 `0`；
- `partial` 报告必须带「数据完整性说明」章节或页脚标记；
- 审核页面顶部固定展示校验结论，未通过项可一键定位到占位符。

**可复现性**：
- 每次运行保存 `data_snapshot_json`（值 + 来源 + 抓取时间 + 响应哈希）；
- 支持「用快照重渲染」：不重新采集，验证渲染器变更是否影响内容；
- 黄金样例回归：固定样例 JSON + 期望取值断言（不做二进制比对）。

---

## 十、异常处理方案

### 10.1 错误分类与处置

| 错误码 | 场景 | 重试 | 默认处置 |
|---|---|---|---|
| `SRC_TIMEOUT` | 设备/接口超时 | 是（指数退避 + 抖动） | 必填→失败；非必填→标记降级 |
| `SRC_AUTH` | 401/403、Token 失效 | 否 | 失败，提示检查凭据 |
| `SRC_RATE_LIMIT` | 429 | 是（遵循 Retry-After） | 排队重试，超限失败 |
| `SRC_HTTP_4XX` | 参数/路径错误 | 否 | 失败，记录请求摘要 |
| `SRC_HTTP_5XX` | 设备内部错误 | 是（有限次） | 降级或失败 |
| `SRC_PARSE` | 响应非 JSON / 结构不符 | 否 | 失败，保存响应片段 |
| `SRC_EMPTY` | 合法但无数据 | 否 | 视为空数据集，表格显示"本期无数据" |
| `MAP_MISSING` | 路径未命中 | 否 | 按 `on_missing` |
| `MAP_TYPE` | 类型转换失败 | 否 | 标记降级并告警 |
| `TPL_PARSE` | 模板损坏/不支持的对象 | 否 | 阻断，提示重新上传 |
| `TPL_RENDER` | Jinja 语法/未定义变量 | 否 | 阻断，列出变量名 |
| `TPL_RESIDUE` | 产物存在未替换占位符 | 否 | `partial`，禁止发布 |
| `VAL_CROSS_CHECK` | 交叉核对不通过 | 否 | `partial`，人工确认 |
| `ARTIFACT_SAVE` | 落盘/入库失败 | 是（1 次） | 失败，保留临时文件 |

### 10.2 降级策略（按字段配置）

| 策略 | 行为 | 适用 |
|---|---|---|
| `fail` | 整个运行失败 | 核心指标、合规必填 |
| `degrade_mark` | 填 `数据获取失败（错误码）` 并标记 partial | 一般统计项 |
| `last_known` | 用上次成功快照，并注明数据时间 | 变化缓慢的资产台账类 |
| `skip_section` | 整段标注"本期无数据" | 可选章节 |
| `default` | 使用显式默认值（必须人工确认过） | 布尔/枚举类 |

### 10.3 其他异常

- **LLM 起草失败**：超时/限流/JSON 不合规 → 重试 2 次 → 降级为「空白骨架模板」，不阻塞人工创建；AI 产物一律不自动入库。
- **并发与背压**：Celery 队列长度阈值触发拒绝新任务并提示；单设备 QPS 限制；全局采集信号量。
- **任务超时**：Celery `soft_time_limit` 分级（采集 120s、渲染 60s），超时释放并标记。
- **大表格**：`max_rows` 硬限制；超限截断并在文末注明"仅展示前 N 条"；单单元格长度上限。
- **模板安全**：拒绝 `.docm`；剥离外部关系（远程模板/图片外链）；限制解压体积防 zip bomb；Jinja2 使用 `SandboxedEnvironment` 并禁用属性穿透。
- **数据安全**：凭据走现有加密字段；API 响应不回显密钥；敏感字段支持 `mask` 算子；审计记录操作人/IP/对象。
- **通知**：运行失败、连续 N 次失败、配置健康检查失败 → 站内通知 + 可配邮件/Webhook。

---

## 十一、技术选型建议

| 能力 | 候选 | 推荐 | 理由 |
|---|---|---|---|
| Word 模板引擎 | docxtpl / python-docx 手写 / Aspose.Words / docx4j | **docxtpl（Jinja2）** | 保留原 Word 样式；支持表格行循环 `{%tr%}`、图片 `InlineImage`、富文本；与现有 python-docx 技术栈一致。用 `SandboxedEnvironment` 加固 |
| 复杂模板兜底 | Aspose.Words（商业） | 备选 | 极端保真/复杂对象场景；需采购与内网授权评估 |
| 版式规范 | 现有 `govdoc.py` | **直接复用** | GB/T 9704 已实现，避免重复造轮子 |
| 高保真预览 | LibreOffice headless / OnlyOffice / docx-preview | **LibreOffice→PDF + docx-preview** | 前者作为最终保真基准，后者做快速页内预览 |
| 在线编辑 | 结构化块编辑器 / OnlyOffice / WPS WebOffice | **v1 结构化编辑 + 离线 Word 编辑** | 成本可控；复杂模板不承诺在线 WYSIWYG |
| 字段抽取 | JSONPath（jsonpath-ng）/ JMESPath | **JSONPath** | 与现有 HTTP 工具 `response_jsonpath` 口径一致 |
| 转换表达式 | 白名单算子 / simpleeval / 任意脚本 | **白名单算子** | 安全、可审计、可校验；拒绝任意代码 |
| HTTP 采集 | httpx AsyncClient | **复用现有** | 已具备超时/重试/SSRF 防护 |
| 异步与调度 | Celery + Redis + Beat | **复用现有** | 独立 `report` 队列隔离 |
| 配置存储 | PostgreSQL JSONB | **JSONB** | 配置结构多变，便于版本快照与 diff |
| 文件存储 | 本地卷 / MinIO | **v1 本地卷 + 哈希**，v2 视容量上 MinIO | 与现有 uploads 一致 |
| 图表 | matplotlib（CJK 字体）/ ECharts SSR | **v1.1 matplotlib** | 后端可控；ECharts SSR 需 Node 运行时 |
| 文档解析辅助 | python-docx（段落/表格）/ docx2python | **python-docx** | 已依赖，覆盖占位符与结构 |
| 前端映射 UI | React 19 + Tailwind + 现有组件 | **自研双栏映射台** | 交互特殊，通用库适配差 |
| 字体 | 仿宋_GB2312 / 黑体 / 楷体_GB2312 / 方正小标宋简体 | **随镜像安装并做字体缺失检测** | 缺字体直接导致分页与版式偏差；注意授权 |

**不推荐**：
- 用 LLM 直接生成 docx/OOXML；
- 用任意 Python 脚本做转换（不可审计、沙箱逃逸风险）；
- 用二进制 diff 做模板版本对比；
- 把报告数据送进 LLM 做"智能填表"。

---

## 十二、实现步骤（里程碑与验收标准）

### M0 渲染内核与模板规范（最优先）
- 定义 `template_spec` / `manifest` v1 规范
- docxtpl 渲染封装：文本、数字、日期、表格循环、简单图片
- 复用 govdoc 做版式规整；Jinja2 沙箱加固
- 黄金样例：1 份真实报告模板 + 固定 JSON → 产物断言
- **验收**：给定固定数据，连续渲染 10 次内容一致；无占位符残留；标准字体/行距正确

### M1 数据连接器与抽取
- 设备动作查询类动作复用 `execute_device_action`
- HTTP 工具数据源复用 `http_config`
- JSONPath 抽取 + 白名单算子 + 分页
- 并行采集、超时预算、单设备限流、错误分类
- **验收**：接入 2 类真实设备，10 个字段抽取正确；单源超时不影响其他源；错误码归类准确

### M2 运行编排与存储
- `report_templates/configs/runs/artifacts` 表与迁移
- 状态机、幂等键、数据快照、血缘清单
- Celery `report` 队列；SSE 进度
- 审计与 RBAC 权限点
- **验收**：手动触发全链路成功；重复触发命中幂等；失败可重试；快照可重渲染

### M3 配置向导前端
- 模板选择、数据源试调用、响应树点选、映射台、试渲染预览
- 未映射/类型不匹配即时提示
- **验收**：非开发人员可在 30 分钟内完成一份报告配置（以真实用户试用手测为准）

### M4 模板库与版本治理
- 上传/解析/预览/发布/回滚/归档
- manifest diff、配置兼容性检查与迁移向导
- 模板发布权限与审计
- **验收**：删除占位符后发布，能准确列出受影响配置；迁移向导可补齐映射

### M5 AI 辅助（横切能力）
- 样例逆向：上传历史报告 → 抽取章节/占位符/表格列
- 从需求起草：输出 spec + 待确认清单
- 映射建议：占位符 ↔ 字段相似度建议，逐条确认
- 全部产出标记 `draft`，人工签收后生效
- **验收**：AI 草稿的占位符命名合法率、章节覆盖率达到人工可接受水平；不产生自动发布

### M6 校验、审核与运维
- L0~L3 校验、交叉核对、校验报告
- 审核状态机与交付物归档
- 配置健康检查（定时 dry-run）与告警
- 运行指标看板（成功率、耗时、失败 TopN）
- **验收**：人为制造缺字段/超时/表格超限，系统均能给出准确校验结论且不产出"看似正常"的错误报告

> 顺序说明：**先 M0/M1 再做 M5**。若按"AI 生成模板 → 模板库 → 配置"推进，会在没有渲染内核和校验机制时先产出大量不可验证的模板，返工概率最高。

---

## 十三、全自动 vs 半自动方案对比

| 维度 | AI Agent 全自动生成 | AI 辅助 + 人工配置（推荐） |
|---|---|---|
| 数字准确性 | 依赖模型复述，存在幻觉与口径漂移 | 确定性抽取，可逐字段核对 |
| 可审计性 | 低（无法解释数字来源） | 高（快照 + 血缘 + 配置版本） |
| 可复现性 | 低（同输入不同输出） | 高（同快照同产物） |
| 合规与正式报告 | 不适合 | 适合 |
| 单份运行成本 | 高（长上下文 + 多轮工具调用） | 低（仅 HTTP 采集 + 渲染） |
| 运行时延 | 分钟级，波动大 | 秒级到分钟级，可并行优化 |
| 模板质量 | 一次性、样式易漂移 | 规范可复用、可版本化 |
| 异常可控性 | 弱（模型自行决定降级） | 强（策略显式配置） |
| 新增报告类型成本 | 低（写提示词即可） | 中（配置一次，可复用） |
| 维护成本 | 提示词/模型变更即回归 | 配置与模板变更需回归，但可控 |
| 安全风险 | 设备数据进入 LLM，存在提示注入 | 数据不进 LLM，边界清晰 |
| 用户操作负担 | 低 | 首次配置较高，后续可复制 |
| 适用场景 | 临时、探索性、格式要求低的报告 | 正式、周期、对外交付、合规报告 |

**结论**：
- 正式报告必须走半自动确定性流水线；
- 全自动方案并非完全放弃，而是**收窄为"临时报告通道"**：继续用现有 Agent `generate_document` 处理一次性、非正式的输出；
- AI 在半自动方案中的三个正确位置：**模板起草/样例逆向、映射建议、摘要润色（数字只引用不生成）**。

### 13.1 最优实现路径（可落地）

```text
第 1 步：选 1 份真实高频报告（如"月度安全巡检报告"）+ 2 类真实设备
第 2 步：按 M0→M1→M2 打通"固定模板 + 固定映射"的硬编码闭环（先不做配置 UI）
第 3 步：把硬编码配置抽成 JSON，再做 M3 配置向导
第 4 步：M4 模板库与版本治理，接入第 2、3 份报告验证复用性
第 5 步：M5 引入 AI 辅助，先用"样例逆向"验证准确率，再开放"从零起草"
第 6 步：M6 校验审核与定时运行，接入交付物归档
```

**判定是否成功的硬指标**：
- 同一配置连续 20 次运行，核心指标与人工核对一致率 100%；
- 数据源单点故障时，报告不产生错误数字（要么标记缺失，要么失败）；
- 新增一份同类报告，配置耗时相比首次显著下降；
- 任一历史报告可在 1 分钟内回答"这个数字来自哪台设备、哪个字段、什么时候取的"。

---

## 十四、风险清单与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 模板复杂度超预期（文本框/合并单元格/页眉页脚/域） | 渲染错位、占位符丢失 | 模板准入检查；不支持对象显式告警；提供"简化模板"模板基线；Aspose 兜底 |
| 中文字体缺失/授权 | 分页与版式偏差 | 镜像固定字体包；启动自检；预览与产物同字体栈 |
| 设备接口无文档/不稳定 | 采集失败率高 | 试调用 + 样例驱动配置；熔断；缓存；与设备负责人建立接口台账 |
| 业务口径变化（如"高危"定义） | 数字对但口径错 | 口径写入配置说明与校验规则；报告附数据口径附录；变更走配置版本 |
| 配置漂移 | 静默产出空报告 | 定时 dry-run 健康检查 + 告警 |
| AI 草稿质量不稳定 | 返工 | 默认"样例逆向"；强制人工签收；AI 产物不自动发布 |
| 用户期望"在线编辑 Word" | 体验落差 | 产品明确分级：结构化编辑 / 离线 Word 编辑 / 只读预览 |
| 报告数据敏感 | 外泄 | 权限最小化、下载鉴权、脱敏算子、审计、禁止进入 LLM |
| 报告体积/表格过大 | 渲染慢、文件大 | 行数上限、分页、附件化明细 |

---

## 十五、待确认决策点

1. **首批报告类型与样例**：建议选 1 份月报 + 1 份事件报告，需提供真实模板与 3 份历史样例。
2. **模板编辑保真度预期**：能否接受"结构化在线编辑 + 离线 Word 编辑"？还是必须浏览器内完整 WYSIWYG（决定是否引入 OnlyOffice）。
3. **部署边界**：是否允许引入 OnlyOffice/Aspose 等外部组件；是否全内网离线。
4. **审核流程**：报告是否必须人工签收后才能归档/外发；签收角色是谁。
5. **数据留存**：报告产物与数据快照的保存期限、是否需定期清理。
6. **与 Agent 的关系**：临时报告通道是否保留 `generate_document`，还是统一收敛到报告中心。
