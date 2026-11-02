# 未提交变更总结 — Agent 文档生成功能模块

> **生成时间**：2026-10-29
> **变更主题**：为 Agent 系统新增文档生成能力（Word / Excel / Markdown 三格式），含统一工具接口、动态内容注入、格式配置、对话界面下载入口与异常处理
> **变更规模**：3 个文件修改 + 1 个文件新增，共 **+471 / -1** 行
> **涉及数据库变更**：无（复用既有 `AgentFile` 表，无需迁移）

---

## 一、变更文件清单

| # | 状态 | 文件路径 | 变更量 | 职责 |
|---|------|---------|--------|------|
| 1 | 修改 | `backend/app/core/tool_runner.py` | +387 | 核心生成逻辑：Markdown 解析、三格式构建器、落盘与 DB 注册、沙箱注入 |
| 2 | 修改 | `backend/app/core/tools/definitions/builtin.py` | +31 | 注册 `generate_document` 内置工具定义（自动入库，全智能体可用） |
| 3 | 修改 | `frontend/src/components/chat/ToolTimeline.jsx` | +54 / -1 | 对话工具时间线渲染文档预览卡片与下载按钮 |
| 4 | 新增 | `backend/tests/test_document_generation.py` | 新文件 | 14 项单元/集成测试（解析、清洗、校验、三格式生成） |

> 无删除文件。开发过程中的临时端到端验证脚本（`tests/_e2e_download_check.py`）已清理，不入库。

---

## 二、功能模块与技术点归纳

### 2.1 涉及功能模块

| 模块 | 层级 | 本次角色 |
|------|------|---------|
| 工具执行沙箱（`tool_runner.py`） | 后端核心 | **主要改动**：新增文档生成宿主函数并注入沙箱命名空间 |
| 内置工具注册（`builtin.py` → `catalog.py` → `seed_service.py`） | 后端配置 | 新增工具定义，经既有 `ensure_preset_tools()` 启动幂等同步至 DB `tools` 表 |
| 智能体文件库（`AgentFile` 模型 + `/api/v1/agent-files`） | 后端存储 | **纯复用**：生成文件落盘 `uploads/agent_files/` 并注册记录，下载走既有接口 |
| 对话工具时间线（`ToolTimeline.jsx`） | 前端展示 | 新增文档文件卡片（预览入口）与带鉴权的 blob 下载 |
| 前端 API 客户端（`client.js` 的 `agentFiles.download`） | 前端接口 | **纯复用**：已有 blob + Bearer token 下载实现 |

### 2.2 业务场景

- 用户在对话中对 Agent 说"帮我生成一份 Word 报告 / 导出 Excel 表格 / 整理成 Markdown 纪要"，LLM 自动调用 `generate_document` 工具完成生成
- Agent 可将工具查询结果、上下文数据、用户输入动态填充进文档内容（`content` 参数由运行时组装）
- 生成后用户在消息时间线直接看到文件卡片并点击下载；API 调用方使用返回的 `download_url`

### 2.3 核心技术点

1. **沙箱宿主函数注入**：工具代码在 AST 沙箱中执行（禁 import/open），故生成能力实现在可信宿主模块 `tool_runner.py`，通过 `load_tool_function()` 的 namespace 注入（`functools.partial` 绑定 `agent_id`/`user_id` 作用域）
2. **Markdown 中间表示**：以 Markdown 作为统一内容协议，`_parse_markdown_blocks()` 解析为块序列（heading/paragraph/list/table/code），各格式构建器独立消费，实现"一次输入、三种输出"的模块化扩展结构
3. **格式兼容细节**：docx 中文渲染需设置 `w:eastAsia` XML 字体属性；xlsx 数值转换需排除前导零（`"007"`）与超长数字（IP 地址等）防失真
4. **参数类型扩展**：`options` 参数使用 `Object` 类型（依赖既有 `tool_builders._TYPE_MAP` 的 `"Object": dict` 映射）

---

## 三、核心变更详解

### 3.1 `backend/app/core/tool_runner.py`（+387 行）

**修改目的**：提供文档生成的全部后端能力，作为沙箱可信宿主函数。

**实现结构**（新增代码位于 `save_json_as_agent_file` 之后）：

```
常量定义
├─ _GENERATE_DOC_FORMATS = ("docx", "xlsx", "md")      # 支持格式白名单
├─ _GENERATE_DOC_MAX_CHARS = 400_000                   # 内容长度上限
├─ _UNSAFE_FILENAME_RE                                  # 文件名非法字符（含路径穿越）
└─ _BOLD_RE = r"\*\*(.+?)\*\*"                          # 行内粗体解析

纯函数（无副作用，单测友好）
├─ _sanitize_doc_name(name, fmt)      → 清洗非法字符→strip→80字符截断→剥离任意扩展→追加规范扩展；空名默认 "agent文档_时间戳"
├─ _parse_markdown_blocks(content)    → 解析为 [{kind, ...}] 块序列；表格识别含分隔行校验；有序列表兼容 "1." 与 "1、"；连续普通行合并段落
├─ _add_docx_runs(paragraph, text)    → "**粗体**" 拆分为多个 run，保留行内强调
└─ _coerce_cell(value)                → 正则 `-?(0|[1-9]\d*)(\.\d+)?` 且长度 <15 才转数值（排除前导零/超长数字）

格式构建器
├─ _build_docx(content, options)      → title 注入 level-0 大标题；Normal 样式设置 body_font（默认微软雅黑）+ w:eastAsia；表格 Table Grid 样式+表头加粗+列数不齐补空；代码块 Courier New
└─ _build_workbook(content, options)  → 表格永远独立 create_sheet（标题取就近 heading 或 "表格N"，31 字符截断）；文本块写入「文档」表（heading 加粗）；表头加粗+浅灰底纹（header_bold）+冻结 A2（freeze_header）；列宽估算；纯表格时移除空「文档」表

主入口
└─ save_document_as_agent_file(content, suggested_name, fmt, options, agent_id, user_id)
   ├─ 校验：空内容 / 格式别名归一（markdown→md、word→docx）/ 非法格式 / 超长 / options 非 dict → 均返回 {"error": "明确中文提示"}，全程不抛异常
   ├─ 生成：md（title 注入 "# title\n\n"）/ docx / xlsx → BytesIO
   ├─ 落盘：uploads/agent_files/{uuid}.{fmt} + 注册 AgentFile(agent_id, created_by)
   └─ 返回：{"ok": True, "file_id", "file_name", "file_type", "file_size", "download_url": "/api/v1/agent-files/{id}/download"}
```

**沙箱注入**（`load_tool_function` 内两处：正常路径 + 沙箱回退路径均覆盖）：

```python
namespace["save_document_as_agent_file"] = _partial(
    save_document_as_agent_file, agent_id=agent_id, user_id=user_id
)
```

**预期效果**：任何智能体的工具代码可直接调用 `save_document_as_agent_file(...)`，文件自动归属当前智能体与用户，经既有权限隔离接口下载。

### 3.2 `backend/app/core/tools/definitions/builtin.py`（+31 行）

**修改目的**：将生成能力注册为内置工具 `generate_document`，使 LLM 可通过自然语言触发。

**实现要点**：

- 追加至 `HERMES_BUILTIN_TOOLS` 列表（唯一定义处），位于 `read_pdf` 之后
- 属性：`tool_type: "code"`、`category: "file_operations"`、`enabled: True`
- **4 个参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_name` | String | 是 | 文件名（可不含扩展名，非法字符自动清洗） |
| `content` | String | 是 | Markdown 正文（动态内容注入点） |
| `format` | String | 否 | docx（默认）/ xlsx / md |
| `options` | Object | 否 | `{title, body_font, font_size, header_bold, freeze_header}` |

- `description` 内置**调用时机引导**（"当用户要求生成/导出文档…时调用"）与**完整调用示例**（Agent 开发者集成参考）
- 工具 `code` 内做空 `file_name` 前置校验后转发宿主函数

**预期效果**：经 `catalog.preset_definitions()` → `seed_service.ensure_preset_tools()` 启动幂等同步自动入库；executor 对非 BUILDER/GLOBAL_WORKFLOW 类工具默认挂载，**全部智能体无需配置即可使用**（已验证热重载后自动生效）。

### 3.3 `frontend/src/components/chat/ToolTimeline.jsx`（+54 / -1 行）

**修改目的**：在对话界面提供文档预览入口与下载能力（用户无需展开工具详情即可见）。

**实现要点**：

- `parseDocFile(tc)`：仅匹配 `tc.name === 'generate_document'`，兼容 result 为对象或 JSON 字符串，要求 `ok && file_id` 才认定为成功产物
- `ToolNode` 内新增 `downloading` state 与 `handleDownload`：调用既有 `agentFiles.download(file_id, file_name)`（fetch blob + Bearer token，`<a>` 直链不带鉴权头不可用），失败 alert 错误信息，`finally` 复位按钮状态
- JSX：工具名行下渲染绿色（emerald）文件卡片 —— 📄 文件名（truncate + title 悬浮全名）+ 文件大小（KB）+ 下载按钮（下载中禁用防重复点击）

**预期效果**：Agent 生成文档后，用户在消息时间线直接看到文件卡片，一键下载到本地。

### 3.4 `backend/tests/test_document_generation.py`（新增）

**修改目的**：保障核心逻辑正确性与回归安全。

**14 项测试覆盖**：

| 类别 | 测试项 |
|------|--------|
| Markdown 解析 | 全文档块序列断言（8 种块型）/ 空输入 / 无分隔行的单 `\|` 行按段落处理 |
| 文件名清洗 | 非法字符剥离 / 路径穿越（`../evil/path` → `evilpath.md`）/ 空名默认值 / 超长截断 |
| 数值转换 | `"8080"`→int、`"3.14"`→float、`"007"`/`"1.1.1.1"`/超长数字保留字符串 |
| 参数校验 | 空内容 / 非法格式 / 超长 / options 类型错误 → 均返回明确 error 不抛异常 |
| 生成集成 | md（title 注入、正文保留、agent_id/created_by 归属隔离断言）/ docx（段落/表格/粗体 run/eastAsia 字体，python-docx 读回）/ xlsx（双 Sheet、数值类型、冻结 A2、表头加粗、纯表格移除空文本表）/ 格式别名与默认值 |

集成测试通过 monkeypatch 替换上传目录与 `SessionLocal`（FakeSession），**不依赖真实数据库**。

---

## 四、兼容性、影响范围与测试要点

### 4.1 兼容性说明

| 项 | 结论 |
|----|------|
| 数据库 | **无 schema 变更**，复用 `AgentFile` 表（original_name/stored_name/file_path/file_type/file_size/agent_id/created_by 均为既有字段），无需迁移 |
| 工具同步 | `ensure_preset_tools()` 幂等：按 name 匹配更新，已有环境启动即生效，不冲突 |
| 文件下载 | 生成文件扩展（md/docx/xlsx）均在下载接口 `ALLOWED_EXTENSIONS` 白名单内；权限沿用既有规则（仅上传者或公共文件可下载，实测 403 拦截） |
| 依赖库 | python-docx / openpyxl 为后端既有运行依赖（`read_uploaded_file` 同源），无新增依赖 |
| 前端 | `parseDocFile` 仅匹配 `generate_document`，对其他工具的时间线渲染零影响；`agentFiles.download` 为既有 API |
| 参数类型 | `options` 的 `Object` 类型依赖既有 `_TYPE_MAP` 映射（`"Object": dict`，此前已支持） |
| 沙箱 | 注入覆盖正常与回退两条路径，沙箱安全策略（AST 审查 + builtins 白名单）不受影响 |

### 4.2 潜在影响范围

- **executor 工具可见性**：`generate_document` 属默认挂载类别，所有智能体（含已有智能体）对话中均可被 LLM 调用——如需限制个别智能体，需后续在智能体配置中显式管理工具列表
- **磁盘占用**：生成文件持久化于 `uploads/agent_files/`（docker volume `soaragent_uploads`），单文件上限 40 万字符内容，长期需关注文件清理策略（与既有上传文件一致）
- **无 API 契约变更**：未修改任何既有端点的请求/响应结构

### 4.3 测试要点与验证记录

**已执行的验证（全部通过）**：

| 验证项 | 命令/方式 | 结果 |
|--------|----------|------|
| 单元/集成测试 | `python -m pytest tests/test_document_generation.py tests/test_chat_history.py tests/test_chat_sessions.py -q` | **43 passed**（本文档功能 14 项 + 对话历史回归 29 项） |
| 前端构建 | `npm run build` | 2754 modules，16.64s，无错误 |
| 工具自动入库 | 容器热重载后查询 DB `tools` 表 | `generate_document` 已存在（enabled=True, category=file_operations） |
| 三格式端到端 | 容器内直接调用宿主函数生成并读回 | docx（4 段落 1 表格）/ xlsx（双 Sheet，A1 正确）/ md（标题注入）内容完整 |
| 下载链路端到端 | 容器内真实 HTTP 请求 | 属主下载 **200**（字节数一致、docx 读回内容一致、RFC 5987 中文名）；越权 **403**；未认证 **401** |

**后续回归建议**：

1. 提交前重跑：`python -m pytest tests/ -q`（全量后端测试）
2. 前端手工验证：对话页触发"生成 Word/Excel/Markdown"话术，确认绿色卡片出现、下载按钮可用、文件可正常打开
3. 边界场景：让 Agent 生成空内容文档，确认返回明确错误提示且对话流程不中断

---

## 五、Git 提交信息（可直接使用）

### 提交标题

```
feat(agent): 新增 generate_document 文档生成工具，支持 Word/Excel/Markdown 三格式
```

### 详细描述

```
feat(agent): 新增 generate_document 文档生成工具，支持 Word/Excel/Markdown 三格式

为 Agent 系统新增文档生成能力模块，用户在对话中通过自然语言即可
触发文档生成并直接下载：

后端
- tool_runner.py 新增文档生成宿主函数 save_document_as_agent_file：
  Markdown 块解析（标题/列表/表格/代码块/粗体）+ docx/xlsx/md 三格式
  构建器，生成文件落盘 uploads/agent_files/ 并注册 AgentFile（agent_id
  与 created_by 双归属，沿用既有权限隔离下载接口）
- 格式配置：options 支持 title / body_font（docx 默认微软雅黑 +
  w:eastAsia 中文渲染）/ font_size / header_bold / freeze_header
- 异常处理：空内容、非法格式、超长（40 万字符）、options 类型错误均
  返回明确中文错误提示，全程不抛异常
- builtin.py 注册 generate_document 内置工具（file_operations 类别，
  4 参数含 Object 类型 options），description 内置调用时机引导与示例，
  启动幂等同步后全部智能体默认可用

前端
- ToolTimeline.jsx 工具时间线新增文档文件卡片：文件名 + 大小 +
  下载按钮（blob + Bearer token），无需展开详情即可见

测试
- 新增 test_document_generation.py 共 14 项：块解析/文件名清洗/数值
  转换/参数校验/三格式生成集成（monkeypatch 隔离，不依赖真实 DB）
- 回归：文档生成 + 对话历史共 43 项测试通过；前端构建通过；
  容器内三格式生成与下载链路（200/403/401）端到端验证通过

无数据库 schema 变更；无既有 API 契约变更；无新增依赖。
```

### 变更文件

```
backend/app/core/tool_runner.py                 | 387 ++++++++++++++++
backend/app/core/tools/definitions/builtin.py   |  31 ++
frontend/src/components/chat/ToolTimeline.jsx   |  54 ++-
backend/tests/test_document_generation.py       | 新增（14 项测试）
3 files changed, 471 insertions(+), 1 deletion(-)
```

---

## 六、扩展性说明（后续新增格式指引）

模块化设计下新增文档格式（如 PDF、HTML）只需三步，无需触碰既有代码：

1. 在 `_GENERATE_DOC_FORMATS` 常量中追加格式标识（如 `"pdf"`）
2. 实现对应的 `_build_pdf(content, options)` 构建器（输入统一为块序列，输出 BytesIO）
3. 在 `save_document_as_agent_file` 主函数中增加一个格式分支

工具 `description` 中的格式列表与前端无需改动（前端卡片按返回结果渲染，不感知具体格式）。
