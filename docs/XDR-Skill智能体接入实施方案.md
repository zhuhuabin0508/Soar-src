# XDR 开放性 Skill 接入 SOAR 智能体实施方案

> 依据：《XDR 开放性 Skill 能力标准文档》（2026-11 版）
> 目标：让 SOAR 平台智能体能够按标准调用 XDR OpenAPI，完成「需求分析 → 参数确定 → 签名请求 → 结果解析 → 落盘回传」全链路
> 适用对象：平台研发、交付实施、XDR 数据接入负责人

---

## 0. 结论先行

### 0.1 三条硬结论

**结论一：SOAR 的 Skill 不是可调用函数，不能“注册到工具列表”。**

平台中 `Skill` 与 `Tool` 是两类实体：

- `Skill = 纯文本指令`，启用后由 `prompt_assembler` 拼接到 system prompt，持续影响模型行为；
- `Tool = 可执行函数`，由 `code` / `http` 两种执行器实际发起动作。

对应代码事实：

- [skill.py](file:///d:/trae%20project/soar-src/backend/app/models/skill.py#L1-L10)：注释明确写“技能不是可调用函数，与 Tool（code/http 可执行工具）是两类不同实体”；
- [prompt_assembler.py](file:///d:/trae%20project/soar-src/backend/app/agent/prompt_assembler.py#L97-L170)：只做正文拼接与变量替换；
- [AgentEditor.jsx](file:///d:/trae%20project/soar-src/frontend/src/pages/AgentEditor.jsx#L1958-L1976)：界面提示“Skill 只收说明文字，脚本请到工具库添加”。

因此正确的落地形态是：**三个 Skill 作为“方法论/规范”注入提示词，另配 3 个可执行工具承担真实动作**。

**结论二：XDR OpenAPI 的签名是动态签名，平台现有 HTTP 工具无法直接对接。**

XDR 签名需要每次请求生成 `sign-date`、对 body 做哈希、对 headers 排序后 HMAC，平台 `http` 工具的 `auth_type` 仅支持静态 `bearer / api_key / oauth2 / basic`（见 [tool_http_runner.py](file:///d:/trae%20project/soar-src/backend/app/core/tool_http_runner.py)）。静态头无法通过 XDR 网关校验，直接配置 HTTP 工具必然 401。

因此必须新增一个**平台级 XDR 签名执行器**（后端模块 + 预置 code 工具），把签名逻辑封装在服务端，模型只传业务参数。

**结论三：大屏 Skill 不能在 SOAR 运行时内完成代码生成。**

`ai-dashboard-production-line` 的工作流依赖：复制 `ai-bigscreen` 工程 → 写文件 → `pnpm dev` 自测 → `pnpm build:zip` 打包，需要 Node/pnpm 与文件系统（见标准文档 §4.1、§4.4）。SOAR 的 code 沙箱禁止文件系统与进程操作，且无 Node 运行时。

因此平台内只保留该 Skill 的“**需求梳理 + 指标口径 + 接口清单 + 字段映射**”部分；源码生成、ZIP 打包必须回到 Trae/IDE 或研发本地环境执行。方案中不会声称平台可直接产出可导入 ZIP，避免与标准冲突。

### 0.2 三技能 → 平台形态映射

| 标准 Skill | 标准定位 | 平台承载方式 | 平台执行载体 |
|---|---|---|---|
| `openapi-requirement-analyzer` | 需求分析与接口方案设计，不请求真实环境 | 文本技能（精简版，注入 prompt） | `search_xdr_api_docs`、`query_xdr_api_doc` |
| `fetch-openapi-data` | 按既定方案签名、请求、落盘 | 文本技能（精简版，注入 prompt） | `query_xdr_openapi` |
| `ai-dashboard-production-line` | 大屏需求 → 可运行前端工程 → ZIP | 文本技能（降级：仅方案与数据契约） | 无执行工具；源码生成交回 IDE/研发 |

### 0.3 改动清单（文件级）

| 序号 | 文件 | 动作 | 目的 |
|---|---|---|---|
| 1 | `backend/app/config.py` | 修改 | 新增 XDR 环境变量字段 |
| 2 | `backend/app/tools/xdr_openapi.py` | 新增 | authCode 解码、签名、请求、错误映射 |
| 3 | `backend/app/tools/xdr_docs.py` | 新增 | 接口文档检索与读取 |
| 4 | `backend/app/data/xdr_skill_reference/` | 新增目录 | 同步 92 份接口文档 + 7 份规范文档 |
| 5 | `backend/app/core/tools/definitions/xdr.py` | 新增 | 3 个预置工具定义 |
| 6 | `backend/app/core/tools/definitions/__init__.py` | 修改 | 导出 `XDR_TOOLS` |
| 7 | `backend/app/core/tools/catalog.py` | 修改 | 纳入内置工具目录与 seed |
| 8 | `backend/app/core/tool_runner.py` | 修改 | 向沙箱命名空间注入 XDR 函数 |
| 9 | `backend/app/agent/hermes/tool_dispatch.py` | 修改 | 标记为只读并行安全 |
| 10 | `backend/app/agent/hermes/tool_result_classification.py` | 修改 | 标记为无副作用工具 |
| 11 | `backend/.env` / `.env.example` | 修改 | 写入主机与联动码（仅部署环境） |
| 12 | SOAR 技能库 3 条记录 | 修改正文 | 替换文件读写为平台工具调用 |
| 13 | 目标 Agent | 修改配置 | 绑定 3 技能 + 3 工具 + 新提示词 |

---

## 1. 标准文档约束基线（实施必须遵守）

### 1.1 三个 Skill 的标准定义

标准文档表 1（§1.2）：

| Skill | 定位 | 输入 | 输出 |
|---|---|---|---|
| openapi-requirement-analyze | 需求分析与接口方案设计 | 自然语言业务需求 | 可实施的 API 调用方案 |
| fetch-openapi-data | 请求执行与数据落盘 | 已确定的接口信息与本地联动配置 | 完整 JSON 响应文件 |
| ai-dashboard-production-line | 大屏代码生成 | 大屏自然语言需求 | 独立前端源码工程 / 确认后 ZIP |

标准协作链（§1.2）：

1. 用户提出业务需求；
2. 需求分析 Skill 扫描接口文档，输出接口选型、参数映射、调用顺序；
3. 数据获取 Skill 读取联动配置、签名、请求、落盘；
4. 二次加工（统计、可视化、报表、大屏）。

### 1.2 认证机制（§3、§4 与 Skill 资产）

XDR OpenAPI 使用 **联动码 authCode → AK/SK → HMAC-SHA256 请求签名**：

1. `authCode` 为 hex 字符串，解码后按 `|` 切分为 14 段；
2. 取第 `0,1,2,3,4,5,6,11` 段用 `+` 拼接，SHA-256 得到 32 字节 AES 密钥；
3. 用 AES-256-CBC（零 IV、无 padding）分别解密第 `9` 段得到 AK、第 `10` 段得到 SK；
4. 每次请求生成四个签名头：
   - `Authorization: algorithm=HMAC-SHA256, Access=<AK>, SignedHeaders=<...>, Signature=<...>`
   - `sdk-host: <XDR 主机名>`
   - `sdk-content-type: application/json`
   - `sign-date: YYYYMMDDTHHMMSSZ`（UTC）
5. 签名后不得再修改 URL、query、headers、body；参数变化必须重新构造并重新签名。

> 算法基准来自 Skill 资产内 `authCode.ts` / `signature.ts` / `packages/ui/scripts/aksk-debug.mjs`，三者逐函数一致，可作为唯一实现依据。

### 1.3 安全合规红线（§8）

1. authCode 最小权限：只开放业务必需接口；
2. authCode 等同访问凭证：**禁止写入文档、代码仓库、技能正文、提示词、聊天回复**；
3. 落盘 JSON 含真实告警/资产数据：按数据分级保存、定期清理；
4. 生产请求需确认：执行前确认接口、参数、时间范围；
5. 不虚构接口与数据：接口文档与真实响应是唯一依据。

> **立即动作**：当前 `fetch-openapi-data/config.json` 中存有明文联动码（本方案不复制、不回显该值）。上线前应轮换该联动码，并把新值只写入部署环境的 `.env`，不得进入 Git。

### 1.4 对实施的三条强制约束

- **分析阶段禁止发真实请求**（标准 §2.4-1）；平台通过提示词 + 工具路由保证：分析阶段只允许文档工具。
- **执行阶段不替用户选接口**（标准 §3.4-1）；接口必须来自分析结论或用户明确给出。
- **无接口满足时必须明确缺口**（标准 §2.4-3、§8-5）；禁止用推测字段补全。

---

## 2. 当前系统现状与差距

### 2.1 Skill 注入机制

- 存储：`skills` 表，`content` 为纯文本，支持 `{{key}}` 变量；
- 注入：`Agent.enabled_skills`（JSON 数组）→ `assemble_system_prompt` 按 `priority` 降序拼接；
- 生效：技能 `enabled=false` 时立即不注入；
- 约束：单条 prompt 超过 32000 字符仅告警不阻断，但会挤占上下文。

**影响**：技能正文必须“精简且可执行”，不能把 90 多份接口文档塞进 prompt，只能通过工具按需检索。

### 2.2 Tool 执行机制

- `code` 工具：在沙箱执行 `async def run(**kwargs)`；
- 沙箱注入模块：`asyncio / json / datetime / timedelta / re / ipaddress / httpx`；
- **禁止 import、禁止文件系统与进程操作**（[tool_runner.py](file:///d:/trae%20project/soar-src/backend/app/core/tool_runner.py#L1040-L1051)）；
- 平台已通过“宿主函数注入”模式扩展能力，例如 `save_json_as_agent_file`、`check_whitelist`、`execute_device_action_by_id`（[tool_runner.py](file:///d:/trae%20project/soar-src/backend/app/core/tool_runner.py#L1063-L1131)）。

**影响**：签名不能用工具内联代码实现（无 `hashlib/hmac/cryptography`），必须在宿主模块实现后注入函数名。

### 2.3 工具结果回传机制

- 工具返回值被 `json.dumps` 后写入 `ToolMessage`；
- 单结果超过 100000 字符会持久化到 `Execution.variables`，上下文只保留预览，模型可用 `query_persisted_result` 取回（[budget.py](file:///d:/trae%20project/soar-src/backend/app/agent/hermes/budget.py#L1-L30)）；
- 含 `error` 键的 dict 会被判定为失败（[tool_result_classification.py](file:///d:/trae%20project/soar-src/backend/app/agent/hermes/tool_result_classification.py#L100-L134)）。

**影响**：工具必须返回稳定、结构化的“摘要 + 文件 + 数据”，并统一错误键名。

### 2.4 差距分析

| 能力要求 | 当前平台 | 差距 | 解决方式 |
|---|---|---|---|
| 技能可被“调用” | 仅文本注入 | 无函数入口 | 技能文本 + 工具执行 |
| authCode 动态签名 | 无 | 无签名执行器 | 新增 `xdr_openapi.py` |
| 接口文档检索 | 无 | 无法读 92 份文档 | 新增文档工具 + 数据目录 |
| 大体积响应落盘 | 有 AgentFile 能力 | 无 XDR 专用落盘 | 工具内调用 `save_json_as_agent_file` |
| 大屏源码生成 | 无 Node/FS | 无法执行 | 平台只做方案，源码回 IDE |

---

## 3. 总体架构

### 3.1 组件关系

```
用户
  │
  ▼
SOAR 智能体（Hermes）
  ├─ system prompt
  │    ├─ 基础提示词（路由规则 / 执行纪律 / 错误处理）
  │    └─ 三个 Skill 正文（方法论，纯文本）
  │
  ├─ 工具：search_xdr_api_docs / query_xdr_api_doc
  │      └─ 读取 backend/app/data/xdr_skill_reference/（接口文档 + 规范）
  │
  └─ 工具：query_xdr_openapi
         └─ app.tools.xdr_openapi（宿主模块）
               ├─ authCode → AES-CBC → AK/SK
               ├─ canonical + HMAC-SHA256 签名
               ├─ httpx 请求 XDR（verify 可配置）
               └─ 结构化结果 + AgentFile 落盘
                          │
                          ▼
                    XDR OpenAPI（/api/xdr/v1/...）
```

### 3.2 一次完整调用的时序

1. 用户提出需求；
2. 智能体判断意图：分析 or 执行 or 大屏 or 闲聊；
3. 分析意图：`search_xdr_api_docs` → `query_xdr_api_doc` → 输出方案（不请求）；
4. 执行意图：回显 `method/path/params/time range` → 用户确认；
5. 调用 `query_xdr_openapi`；
6. 宿主模块解码联动码 → 生成签名头 → 发送请求；
7. 工具解析响应外壳 → 生成摘要 → 落盘 JSON → 返回 ToolMessage；
8. 智能体基于摘要与 `data.item` 继续推理/汇总/生成报表；
9. 用户拿到结论 + 落盘文件。

---

## 4. 实施步骤

### Step 1：凭据与运行配置

#### 1.1 新增配置项

修改 [config.py](file:///d:/trae%20project/soar-src/backend/app/config.py#L14-L66)，在 `Settings` 中追加：

```python
# ===== XDR 开放性 OpenAPI =====
# XDR 平台地址，必须带协议，如 https://10.5.41.194
XDR_OPENAPI_HOST: str = ""
# 联动码（等同访问凭证），仅允许通过部署环境变量注入
XDR_OPENAPI_AUTH_CODE: str = ""
# 单次请求超时（秒）；须小于 Hermes 工具总超时 30s
XDR_OPENAPI_TIMEOUT: float = 20.0
# XDR 自签证书环境默认关闭校验；生产有正式证书时置 true
XDR_OPENAPI_VERIFY_SSL: bool = False
# 是否允许非查询类方法（PUT/PATCH/DELETE），默认禁止
XDR_OPENAPI_ALLOW_WRITE: bool = False
# 接口文档目录
XDR_DOCS_DIR: str = str(BASE_DIR / "app" / "data" / "xdr_skill_reference")
```

#### 1.2 部署环境写入

在目标环境的 `backend/.env`（不得提交到仓库）中写入：

```dotenv
XDR_OPENAPI_HOST=https://<XDR平台地址>
XDR_OPENAPI_AUTH_CODE=<新轮换的联动码>
XDR_OPENAPI_TIMEOUT=20
XDR_OPENAPI_VERIFY_SSL=false
XDR_OPENAPI_ALLOW_WRITE=false
```

`.env.example` 只写空值占位与说明，不写真实值。

#### 1.3 安全要求

- 联动码只存在后端进程环境；不得进入技能正文、Agent 提示词、工具描述、日志、错误信息；
- 日志只记录 `method/path/status/耗时`，不记录 `Authorization/sdk-*`；
- 工具返回与异常信息中不得回显 AK/SK/authCode；
- 上线前轮换当前已暴露的联动码，并在 XDR「联动码管理」中复核授权范围（仅业务必需接口）。

---

### Step 2：新增 XDR 签名执行器

新建 `backend/app/tools/xdr_openapi.py`。模块职责：**只负责协议层**（解码、签名、发送、错误归类），不负责业务选型、不做结果美化。

#### 2.1 对外函数

```python
async def call_xdr_openapi(
    method: str,
    path: str,
    query: dict | None = None,
    body: dict | list | None = None,
    headers: dict | None = None,
) -> dict:
    """签名并请求 XDR OpenAPI，永不抛出异常，统一返回结构化结果。"""
```

#### 2.2 签名实现要点（必须逐条对齐）

1. **配置读取**
   - `host = settings.XDR_OPENAPI_HOST.rstrip("/")`；缺失 → 返回 `CONFIG_MISSING`；
   - `sign_host = urllib.parse.urlparse(host).netloc`（含端口时保留端口）；
   - `auth_code = settings.XDR_OPENAPI_AUTH_CODE`；缺失 → `CONFIG_MISSING`。

2. **联动码解码（带缓存）**
   - 按 `auth_code` 字符串做 `lru_cache`，避免每次请求重复 AES；
   - 解码失败 → `CONFIG_INVALID`（提示轮换或重新配置联动码）。

3. **请求路径规范化**
   - 必须匹配 `^/api/xdr/v1/`；
   - 不允许包含 `://`、`?`、`#`；
   - 签名时去掉 query、末尾补 `/`，再做 URL 编码（保留 `/`）。

4. **请求头**
   - 始终发送：`content-type: application/json`、`sdk-host`、`sdk-content-type`、`sign-date`；
   - `sign-date` 使用 UTC `%Y%m%dT%H%M%SZ`；
   - 用户自定义 headers 参与签名，但禁止覆盖保留头（`authorization/sdk-host/sdk-content-type/sign-date/content-type`）。

5. **Query 规范化**
   - 仅允许标量值（字符串/数字/布尔）；
   - 按 key 字典序排序，`key=value` 以 `&` 连接，key/value 均做 URL 编码；
   - 数组/对象参数一律放 body，不放入 query。

6. **Body 与 payload 哈希**
   - **必须只序列化一次**：`raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":"))`；
   - 用 `httpx` 发送 `content=raw_body`，**禁止使用 `httpx(json=body)`**（其序列化字节与签名字节可能不一致）；
   - payload 哈希规则：UTF-8 字节 → 升序排序 → 去掉 `0x20`（空格）→ SHA-256 → **大写 hex**。

7. **Canonical 字符串**

```
METHOD + "\n" +
encoded_path_with_trailing_slash + "\n" +
sorted_query_string + "\n" +
header_lines + signed_headers + "\n" +
payload_sha256_upper
```

其中 `header_lines` 为按 header 名小写排序后逐行 `key:value\n`，`signed_headers` 为同序 `key;key;...`（不含 `authorization`）。

8. **最终签名**

```
hashed_canonical = SHA256(canonical).hexdigest().upper()
total_str = "HMAC-SHA256\n" + sign_date + "\n" + hashed_canonical
signature = HMAC-SHA256(sk, total_str).hexdigest().upper()
authorization = f"algorithm=HMAC-SHA256, Access={ak}, SignedHeaders={signed_headers}, Signature={signature}"
```

9. **发送**
   - `httpx.AsyncClient(timeout=settings.XDR_OPENAPI_TIMEOUT, verify=settings.XDR_OPENAPI_VERIFY_SSL)`；
   - 签名后不得再改任何请求字段。

10. **方法白名单**
    - `GET/POST` 始终允许；
    - `PUT/PATCH/DELETE` 仅在 `XDR_OPENAPI_ALLOW_WRITE=true` 时允许，否则返回 `METHOD_FORBIDDEN`。

#### 2.3 返回值契约

成功：

```json
{
  "ok": true,
  "http_status": 200,
  "method": "POST",
  "path": "/api/xdr/v1/alerts/list",
  "code": "Success",
  "message": "",
  "data": { "total": 150, "page": 1, "pageSize": 20, "item": [] },
  "elapsed_ms": 86
}
```

失败（`error` 键用于平台 guardrail 判定失败）：

```json
{
  "ok": false,
  "error_type": "PERMISSION_DENIED",
  "http_status": 403,
  "error": "XDR 网关拒绝访问：联动码无权调用该接口",
  "hint": "请在 XDR 联动码管理中为该联动码开放对应接口权限",
  "retryable": false,
  "method": "POST",
  "path": "/api/xdr/v1/risk/list"
}
```

业务错误（HTTP 200 但 `code != "Success"`）也要转成失败：`error_type=APP_ERROR`，保留 `code/message`。

#### 2.4 错误映射表

| 场景 | `error_type` | `retryable` | Agent 行为 |
|---|---|---|---|
| 未配置 host/authCode | `CONFIG_MISSING` | false | 输出配置引导，停止 |
| 联动码解码失败 | `CONFIG_INVALID` | false | 提示管理员轮换/重配 |
| 401 | `AUTH_FAILED` | false | 提示联动码失效或签名失败 |
| 403 | `PERMISSION_DENIED` | false | 提示开放接口权限 |
| 404 | `NOT_FOUND` | false | 回查文档校正 path，不猜测 |
| 400/422 | `PARAM_ERROR` | false | 引用上游 message，回查字段规则 |
| 429 | `RATE_LIMITED` | true | 退避 1 次，仍失败则说明 |
| 5xx | `UPSTREAM_ERROR` | true | 重试 1 次，仍失败则给替代方案 |
| 超时 | `TIMEOUT` | true | 缩小时间范围/分页后重试 1 次 |
| 连接失败 | `NETWORK_UNREACHABLE` | false | 提示网络策略/地址 |
| TLS 失败 | `TLS_ERROR` | false | 提示证书或 `VERIFY_SSL` 配置 |
| 非查询方法 | `METHOD_FORBIDDEN` | false | 提示只允许查询 |

---

### Step 3：新增工具 A —— `query_xdr_openapi`

#### 3.1 工具元数据

| 字段 | 值 |
|---|---|
| name | `query_xdr_openapi` |
| tool_type | `code` |
| category | `xdr` |
| description | 使用平台托管的联动码签名并调用 XDR OpenAPI。仅用于已确认的接口；POST 也用于查询类接口。返回摘要、落盘文件与数据。 |
| 并行属性 | `query_` 前缀 → 并行安全、无副作用 |

#### 3.2 参数 Schema

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `method` | String | 是 | `GET/POST/PUT/PATCH/DELETE`；查询默认 `POST`（以文档为准） |
| `path` | String | 是 | 必须以 `/api/xdr/v1/` 开头；不含 host、协议、`?query` |
| `query` | Object | 否 | 仅标量键值；来源为文档的 Query 参数 |
| `body` | Object | 否 | 业务参数；GET 不传 |
| `headers` | Object | 否 | 预留；不得覆盖签名保留头 |
| `save_result` | Boolean | 否 | 默认 `true`，完整响应写入 AgentFile |
| `filename` | String | 否 | 落盘文件名（不含路径）；默认按 path + 时间生成 |

#### 3.3 工具代码（落库内容）

```python
async def run(**kwargs):
    method = (kwargs.get('method') or 'GET').upper()
    path = kwargs.get('path') or ''
    query = kwargs.get('query') or {}
    body = kwargs.get('body')
    headers = kwargs.get('headers') or {}
    save_result = kwargs.get('save_result', True)
    filename = kwargs.get('filename')

    result = await call_xdr_openapi(
        method=method, path=path, query=query, body=body, headers=headers
    )
    if not result.get('ok'):
        return result

    data = result.get('data')
    raw = json.dumps(data, ensure_ascii=False, default=str)

    file_meta = None
    if save_result:
        payload = data if isinstance(data, dict) else {'data': data}
        name = filename or ('xdr_' + path.strip('/').replace('/', '_') + '.json')
        saved = save_json_as_agent_file(payload, name)
        if saved and saved.get('ok'):
            file_meta = {
                'file_name': saved.get('file_name'),
                'file_size': saved.get('file_size'),
            }

    summary = summarize_xdr_data(data)
    out = {
        'ok': True,
        'http_status': result.get('http_status'),
        'code': result.get('code'),
        'message': result.get('message'),
        'method': method,
        'path': path,
        'summary': summary,
        'file': file_meta,
        'elapsed_ms': result.get('elapsed_ms'),
    }
    # 小于 8k 字符直接给全量，便于模型继续推理；大结果给预览
    if len(raw) <= 8000:
        out['data'] = data
    else:
        out['preview'] = data if len(raw) <= 30000 else summarize_xdr_data(data)
        out['truncated'] = True
    return out
```

> 说明：`call_xdr_openapi`、`save_json_as_agent_file`、`summarize_xdr_data` 均由宿主注入，工具代码不出现 import。

#### 3.4 摘要规则（`summarize_xdr_data`）

按“不假设具体业务字段”的方式生成：

- 顶层键列表；
- 若存在 `data` 对象，优先摘要 `data`；
- `total`（如有）；
- `page` / `pageSize`（如有）；
- 列表字段 `item/list/records/rows` 的长度；
- `has_more`：`total > page * pageSize` 或 `len(item) == pageSize`；
- 空数据标记：`total == 0` 或列表为空。

示例：

```json
{
  "total": 150,
  "page": 1,
  "page_size": 20,
  "returned": 20,
  "has_more": true,
  "top_level_keys": ["total", "page", "pageSize", "item"]
}
```

#### 3.5 结果示例

```json
{
  "ok": true,
  "http_status": 200,
  "code": "Success",
  "method": "POST",
  "path": "/api/xdr/v1/alerts/list",
  "summary": { "total": 150, "page": 1, "page_size": 20, "returned": 20, "has_more": true,
               "top_level_keys": ["total", "page", "pageSize", "item"] },
  "file": { "file_name": "xdr_alerts_list.json", "file_size": 48213 },
  "elapsed_ms": 86
}
```

---

### Step 4：新增工具 B —— 接口文档检索

#### 4.1 数据目录

将 Skill 的 `references/` 全量同步到 `backend/app/data/xdr_skill_reference/`：

```
xdr_skill_reference/
├── api-docs/
│   ├── alerts/          (告警)
│   ├── incidents/       (事件)
│   ├── assets/          (资产)
│   ├── vulnerabilities/ (脆弱性)
│   ├── risks/           (风险主机)
│   └── logs/            (分析日志)
├── business-glossary.md
├── matching-strategies.md
├── scheme-template.md
├── validation-checklist.md
├── enum-dictionary.md
├── enum-dictionary-pending.md
├── enum-dictionary-python.md
└── interface-conventions.md
```

规模：92 份接口文档，约 1.44 MB；随镜像发布，不进入 prompt。

#### 4.2 工具 B1：`search_xdr_api_docs`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keyword` | String | 是 | 业务关键词、接口名、字段名，如“告警 列表 分页” |
| `domain` | String | 否 | `alerts/incidents/assets/vulnerabilities/risks/logs/all` |
| `limit` | Number | 否 | 返回条数，默认 5，最大 10 |

返回：

```json
{
  "ok": true,
  "total_candidates": 7,
  "results": [
    {
      "path": "api-docs/alerts/alert-list.md",
      "title": "POST /api/xdr/v1/alerts/list",
      "score": 180,
      "snippet": "本接口用于分页查询XDR系统中的安全告警列表……"
    }
  ]
}
```

匹配规则：文件名命中 > 一级标题命中 > 正文命中次数；正文截取首个命中点前后 300 字。

#### 4.3 工具 B2：`query_xdr_api_doc`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | String | 是 | 相对路径，如 `api-docs/alerts/alert-list.md`、`scheme-template.md` |

安全与限额：

- 拒绝 `..`、绝对路径、非 `.md`；
- 读取上限 80000 字符；超限截断并返回 `truncated=true`，提示用搜索定位其他段落。

返回：

```json
{ "ok": true, "path": "api-docs/alerts/alert-list.md", "content": "# POST ...", "truncated": false }
```

---

### Step 5：工具注册与沙箱注入

#### 5.1 预置工具定义

新建 `backend/app/core/tools/definitions/xdr.py`，导出 `XDR_TOOLS`，包含上述 3 个工具；然后在：

- `definitions/__init__.py`：`from ...xdr import XDR_TOOLS`，加入 `__all__`；
- `catalog.py`：在 `builtin_definitions()` 中合并 `XDR_TOOLS`（保持 `TOOL_SOURCE_BUILTIN`，自动 `is_preset=True`）；
- `seed_code_map()` 会自动从 `builtin_definitions()` 取到工具代码，无需额外改动。

启动后 `ensure_preset_tools()` 幂等写入 `tools` 表，工具库页面即可看到。

#### 5.2 沙箱命名空间注入

在 [tool_runner.py](file:///d:/trae%20project/soar-src/backend/app/core/tool_runner.py#L1096-L1110) 的注入区追加：

```python
# XDR OpenAPI 宿主能力注入：沙箱禁止 import，签名与文档检索在宿主模块实现
try:
    from app.tools.xdr_openapi import call_xdr_openapi, summarize_xdr_data
    from app.tools.xdr_docs import search_xdr_docs, read_xdr_doc

    namespace["call_xdr_openapi"] = call_xdr_openapi
    namespace["summarize_xdr_data"] = summarize_xdr_data
    namespace["search_xdr_docs"] = search_xdr_docs
    namespace["read_xdr_doc"] = read_xdr_doc
except ImportError:  # pragma: no cover
    logger.debug("XDR OpenAPI 模块未安装，工具命名空间不注入 XDR 函数")
```

#### 5.3 只读与并行标记

- [tool_dispatch.py](file:///d:/trae%20project/soar-src/backend/app/agent/hermes/tool_dispatch.py#L37-L55)：三个工具均以 `query_/search_` 开头，已自动并行安全；建议显式加入 `_PARALLEL_SAFE_TOOLS`，便于审计。
- [tool_result_classification.py](file:///d:/trae%20project/soar-src/backend/app/agent/hermes/tool_result_classification.py#L33-L39)：加入 `NO_EFFECT_TOOL_NAMES`，中断后可安全丢弃、重试幂等。

---

### Step 6：技能正文平台化改造

#### 6.1 改造总原则

| 原 Skill 行为 | 平台替代 |
|---|---|
| `Glob references/api-docs/**/*.md` | `search_xdr_api_docs(keyword, domain)` |
| `Read references/xxx.md` | `query_xdr_api_doc(path)` |
| 读取 `config.json` | 平台环境变量托管，智能体不读取、不输出 |
| 写本地 JSON 文件 | `query_xdr_openapi` 自动落盘 AgentFile |
| 写 `docs/openapi-analysis/*.md` | 对话输出；如需文件，用 `save_document_as_agent_file` |
| `pnpm dev` / `pnpm build:zip` | 不在平台执行，交回 IDE/研发 |

**技能名称建议保持与目录一致**：

- `openapi-requirement-analyzer`（`priority=100`）
- `fetch-openapi-data`（`priority=90`）
- `ai-dashboard-production-line`（`priority=10`）

#### 6.2 Skill 1：openapi-requirement-analyzer（平台版改动）

保留原文的：核心原则、需求解析、五级匹配、接口选型优先级、聚合 limit 规则、告警聚合参数规则、业务名词先查字典、质量红线。

仅替换“知识库/工具调用”段落：

**替换 §知识库 为：**

```
## 知识库
接口文档由平台工具提供，不在提示词内。检索入口：
- search_xdr_api_docs(keyword, domain)：按业务域检索接口文档；
- query_xdr_api_doc(path)：读取命中文档或规范文档全文。

规范文档路径：
- matching-strategies.md（匹配策略）
- business-glossary.md（业务名词字典，匹配字段前必查）
- enum-dictionary.md / enum-dictionary-pending.md（枚举对照）
- scheme-template.md（方案模板）
- validation-checklist.md（完整性校验）
- interface-conventions.md（接口通用约定）
```

**替换 §第 2 步 的 1、2 条：**

```
1. 调用 search_xdr_api_docs(keyword=<业务对象+动作+关键过滤>, domain=<业务域>) 获取候选文档；
2. 调用 query_xdr_api_doc(path) 读取 matching-strategies.md 与候选文档的“接口概述/使用场景/业务逻辑”；
```

**替换 §第 3 步 的模板/字典读取：**

```
- 读取 scheme-template.md：query_xdr_api_doc("scheme-template.md")
- 读取枚举字典：query_xdr_api_doc("enum-dictionary.md")
- 读取待补枚举：query_xdr_api_doc("enum-dictionary-pending.md")
- 读取业务名词：query_xdr_api_doc("business-glossary.md")
```

**替换 §第 4 步：**

```
读取 validation-checklist.md 并逐项自检：query_xdr_api_doc("validation-checklist.md")
```

**替换 §第 5 步 保存路径：**

```
1. 对话中展示完整 Markdown 方案；
2. 本平台不写本地 docs 目录；如用户需要文件，调用 save_document_as_agent_file(markdown, "<需求摘要>.md")。
```

**追加硬规则（平台专属）：**

```
- 本技能只分析与设计，禁止在本阶段调用 query_xdr_openapi；
- 输出方案中必须包含：接口清单、参数明细、返回字段、枚举说明、调用顺序、异常与验证结论；
- 任何字段/枚举/路径必须来自 query_xdr_api_doc 的原文，禁止凭记忆补全。
```

#### 6.3 Skill 2：fetch-openapi-data（平台版正文建议）

原文较短，建议整体替换为以下平台版（保留原语义与输出规则）：

```markdown
# 获取 XDR OpenAPI 数据（平台版）

## 定位
当接口、方法、参数已经由分析技能或用户确认后，使用本技能执行真实请求并落盘。

## 配置
联动码（authCode）与 XDR 主机由平台托管（部署环境变量），智能体不得读取、输出或要求用户粘贴联动码。
若工具返回 CONFIG_MISSING / CONFIG_INVALID：
1. 停止执行；
2. 告知用户联系平台管理员配置 XDR_OPENAPI_HOST 与 XDR_OPENAPI_AUTH_CODE；
3. 提示联动码来源：XDR「配置管理 → 系统设置 → 开放性 → 联动码管理」；
4. 不得猜测、不得改用其他地址。

## 工作流
1. 校验输入完整性：method、path、query、body、时间范围；
2. 回显请求要素并确认（生产请求必须确认）；
3. 调用 query_xdr_openapi；
4. 工具返回 ok=false 时按错误类型处理，不重试超过 1 次；
5. 成功时读取 summary 与 file，聊天只返回摘要与文件名。

## 参数规则
- path 必须是 /api/xdr/v1/... 对外路径，不含 host、协议、query；
- Query 参数放 query，业务参数放 body；GET 不带 body；
- 时间使用秒级时间戳；枚举按部署语言环境传值；
- 聚合接口必须显式 limit；只要总数优先 list 接口的 total；
- 签名由工具完成，签名后不得再改参数；参数变化必须重新调用工具。

## 输出规则
- 完整响应由工具落盘，聊天不粘贴大段 JSON；
- 摘要包含：是否成功、total/返回条数、关键分布、落盘文件名；
- 不生成长期维护的集成代码。
```

#### 6.4 Skill 3：ai-dashboard-production-line（平台降级版）

保留需求梳理与接口分析能力，明确能力边界：

```markdown
# 大屏需求分析（平台版）

## 定位
本平台只负责大屏需求梳理、指标口径、接口清单与字段映射；不生成源码、不启动 pnpm、不打包 ZIP。

## 可交付内容
1. 使用对象、业务目标、核心指标优先级；
2. 面板清单、布局建议、视觉方向；
3. 每个面板的数据来源：接口路径、方法、参数、返回字段、字段映射；
4. 无法通过现有接口获得的数据，明确列出缺口。

## 硬规则
- 所有接口必须通过 search_xdr_api_docs / query_xdr_api_doc 校验存在性；
- 不得虚构接口、字段、指标；
- 需要生成可运行工程或 ZIP 时，明确告知：需在具备 Node/pnpm 的开发环境使用 ai-dashboard-production-line 完整版完成，本平台不执行；
- 联动码、AK/SK、Cookie 不得出现在任何方案或交付内容中。
```

#### 6.5 技能绑定操作步骤

**方式一（推荐）：界面操作**

1. 进入「技能库」，确认三条技能存在且 `enabled=true`；
2. 若不存在：用「导入文本新建技能」粘贴上述正文；
3. 若已存在：编辑正文，按 6.2–6.4 替换；
4. 设置优先级：100 / 90 / 10；
5. 进入「智能体编排 → 编辑目标智能体 → 能力配置 Tab → 技能」；
6. 勾选三条技能；
7. 同页「工具」Tab 勾选 `query_xdr_openapi`、`search_xdr_api_docs`、`query_xdr_api_doc`；
8. 保存并发布。

**方式二：API**

```http
PUT /api/v1/agents/{agent_id}
Content-Type: application/json

{
  "name": "<原名称>",
  "description": "<原描述>",
  "model_config_id": <原值>,
  "system_prompt": "<新提示词>",
  "temperature": 0.3,
  "max_tokens": 2048,
  "enabled_tools": ["query_xdr_openapi", "search_xdr_api_docs", "query_xdr_api_doc"],
  "enabled_kbs": [],
  "enabled_asset_types": [],
  "enabled_skills": [<skill1_id>, <skill2_id>, <skill3_id>],
  "enabled_workflows": [],
  "max_iterations": 8,
  "tool_configs": {},
  "variables": {"xdr_language_env": "zh_cn"}
}
```

> `PUT` 需要完整对象；建议先用 `GET /api/v1/agents/{id}` 取当前配置，合并后再提交，避免覆盖。

---

### Step 7：智能体提示词优化

#### 7.1 优化目标

1. **意图路由准确**：分析 / 执行 / 大屏 / 闲聊四类分流；
2. **阶段隔离**：分析阶段绝不发请求；
3. **参数合规**：执行前自检，减少 400；
4. **结果可用**：强制读摘要与字段，不编造；
5. **失败可控**：按错误类型降级，不无限重试；
6. **安全**：永不输出凭证。

#### 7.2 系统提示词模板（可直接使用）

```markdown
你是「XDR 数据接入智能体」，负责把用户的自然语言需求转化为 XDR OpenAPI 调用，并获取真实数据。

## 可用能力
### 技能（方法论）
- openapi-requirement-analyzer：接口选型、参数映射、调用顺序设计；只分析，不请求。
- fetch-openapi-data：按已确认方案执行请求并落盘。
- ai-dashboard-production-line：大屏需求与数据契约分析；不生成源码。

### 工具（唯一执行入口）
- search_xdr_api_docs(keyword, domain?)：检索 XDR 接口文档。
- query_xdr_api_doc(path)：读取接口文档或规范文档全文。
- query_xdr_openapi(method, path, query?, body?, headers?, save_result?, filename?)：
  使用平台托管的联动码签名并请求 XDR OpenAPI，完整响应自动落盘。

## 意图路由（先判断，再行动）
1. 用户不知道调哪个接口、需求含糊、要“方案/接口清单/怎么对接”：
   → 进入分析流程：search_xdr_api_docs → query_xdr_api_doc → 输出方案。
   → 本阶段禁止调用 query_xdr_openapi。
2. 用户已给出接口与方法，或已有确认过的方案，要“真实数据/总数/明细/导出”：
   → 进入执行流程：回显 method、path、query、body、时间范围 → 用户确认 → query_xdr_openapi。
3. 用户要做大屏：
   → 输出需求规格、指标口径、接口清单、字段映射；说明源码生成需在具备 Node/pnpm 的环境完成。
4. 与 XDR 数据无关：
   → 直接回答，不调用任何工具。

## 执行前自检（逐项确认）
- path 必须形如 /api/xdr/v1/...，不含 host、协议、?query；
- 查询参数放 query，业务参数放 body；GET 不带 body；
- 必填字段必须有值；缺关键值时最多追问 1-2 个问题；
- 时间范围使用秒级时间戳；枚举值中文环境用国际化值，国际版用数字值；
- 聚合接口必须显式 limit；只要一个总数时优先使用 list 接口的 total；
- 生产环境请求必须先回显参数并获得确认。

## 结果处理
- 成功：先读 summary（total / returned / has_more / top_level_keys），再按需读取 data.item；
- 分页：仅当用户要全量时继续翻页，最多 5 页；到上限必须说明“数据未取全”；
- 落盘：把 file.file_name 告知用户；不要粘贴完整 JSON，除非用户明确要求；
- 失败：按 error_type 处理；retryable=true 时最多重试 1 次；禁止用假数据补全；
- 空数据：total=0 时说明“当前条件下无数据”，并给出放宽条件的建议。

## 安全
- 永不输出 authCode、AK、SK、Authorization；
- 用户粘贴联动码时，告知其由平台管理员配置到部署环境变量，不在对话中保存；
- 不虚构接口、字段、枚举或返回值。

## 回答风格
中文；先结论后数据；简洁；需要长文时用表格。
```

#### 7.3 触发词与反触发词

| 意图 | 正向触发示例 | 反触发（不应进入 XDR 流程） |
|---|---|---|
| 需求分析 | “该调哪个接口”“接口方案”“怎么对接”“多个接口怎么串”“能不能实现” | “解释一下什么是告警” |
| 数据获取 | “查真实数据”“查最近7天”“给我总数”“导出明细”“跑一下这个接口” | “设计一个查询接口” |
| 大屏 | “做大屏”“大屏方案”“面板/指标/布局” | “画一个流程图” |
| 闲聊/通用 | — | 问候、平台使用问题、非 XDR 业务 |

#### 7.4 Few-shot 示例（建议写入提示词或技能）

**正例 1（分析）：**

- 用户：`我要查询最近 7 天高危且未处置的告警，该调哪个接口？`
- 正确：检索文档 → 输出 `POST /api/xdr/v1/alerts/list` + 参数 + 返回字段 + 校验结论；**不调用执行工具**。
- 错误：直接 `query_xdr_openapi` 发请求。

**正例 2（执行）：**

- 用户：`按上面的方案，查一下最近 7 天高危未处置告警的总数，时间 2026-10-29 00:00 到 2026-11-05 00:00。`
- 正确：回显参数 → 确认 → `query_xdr_openapi(POST, /api/xdr/v1/alerts/list, body={page:1,pageSize:5,...})` → 汇报 `total` + 文件名。
- 错误：把时间写成字符串日期；或把 body 塞进 query。

**反例 3（大屏）：**

- 用户：`给我生成一块大屏并打包 ZIP。`
- 正确：输出方案 + 明确“本平台不生成源码/ZIP，需在 IDE 用完整版 Skill 完成”。
- 错误：声称“已生成 ZIP”或编造下载链接。

#### 7.5 Prompt 体积控制

- 基础提示词 ≤ 1500 字；
- 每条技能正文 ≤ 6000 字；
- 总量超过 32000 字符会告警，且挤占上下文；接口细节一律走文档工具，不写入 prompt。

---

### Step 8：参数传递规范（严格执行）

#### 8.1 通用规则

| 规则 | 内容 |
|---|---|
| 路径 | 只用对外路径 `/api/xdr/v1/...`，不用 Spring 内部路径 |
| 主机 | 不传 host；由平台配置决定 |
| 方法 | 以接口文档为准；列表/聚合/趋势多为 POST |
| Query | 只放文档中的 Query 参数，标量值 |
| Body | 放 JSON 业务参数；字段名大小写严格按文档 |
| Header | 除工具托管签名头外，一般不传自定义头 |
| 时间 | 秒级时间戳（Long）；示例值必须可计算 |
| 枚举 | 中文环境传国际化值；国际版传数字值 |
| 分页 | `page` 从 1 开始；`pageSize` 遵守文档范围（告警列表为 5–200） |
| 聚合 | 必须显式 `limit`；已知有限枚举用枚举总数；未知值域让业务方给 N |
| 多接口 | 上一步响应字段 → 下一步请求字段，必须字段级映射 |

#### 8.2 标准示例

**示例 1：告警列表（POST，分页）**

```json
{
  "method": "POST",
  "path": "/api/xdr/v1/alerts/list",
  "body": {
    "page": 1,
    "pageSize": 20,
    "startTime": 1761667200,
    "endTime": 1762272000,
    "severity": [3, 4],
    "alertDealStatus": 1
  },
  "save_result": true
}
```

> 枚举/字段取值必须以 `api-docs/alerts/alert-list.md` 与 `enum-dictionary.md` 为准；上面仅为结构示例。

**示例 2：资产总数（POST）**

```json
{
  "method": "POST",
  "path": "/api/xdr/v1/assets/total",
  "body": { "classify1Id": [1], "manageStatus": "in_depot" }
}
```

**示例 3：GET 查询（无 body）**

```json
{
  "method": "GET",
  "path": "/api/xdr/v1/vuls/optionfield",
  "query": { "is_show": "true" }
}
```

#### 8.3 工具侧强校验（调用前直接拒绝）

- `path` 不以 `/api/xdr/v1/` 开头 → `PARAM_ERROR`；
- `path` 含 `://`、`?`、`#`、`..` → `PARAM_ERROR`；
- `method` 不在允许列表 → `METHOD_FORBIDDEN`；
- `query` 含对象/数组 → `PARAM_ERROR`（要求放 body）；
- `body` 非对象/数组 → `PARAM_ERROR`；
- `headers` 覆盖保留头 → `PARAM_ERROR`。

#### 8.4 Agent 侧强校验（提示词约束）

- 缺少必填字段时禁止“先调再看报错”，必须先追问；
- 无法确定枚举值时，先查 `enum-dictionary.md`；仍不确定则问业务方；
- 多接口编排必须先完成字段映射，再执行第二段；
- 聚合接口 `limit` 不允许省略，也不允许传超大值绕过截断。

---

### Step 9：结果解析与回传逻辑

#### 9.1 XDR 响应外壳

标准响应外壳：

```json
{
  "code": "Success",
  "message": "",
  "data": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "item": [ ... ]
  }
}
```

判定规则：

1. HTTP 非 2xx → 失败（按状态码映射）；
2. HTTP 2xx 且 `code` 缺失 → 按成功处理（部分接口无外壳）；
3. `code` 为 `"Success"` / `"0"` / `0` → 成功；
4. 其他 `code` → `APP_ERROR`，保留 `message`；
5. `data` 缺失 → `data=null`，摘要标记为空。

#### 9.2 工具回传结构（模型可见）

```json
{
  "ok": true,
  "http_status": 200,
  "code": "Success",
  "method": "POST",
  "path": "/api/xdr/v1/alerts/list",
  "summary": { "total": 150, "page": 1, "page_size": 20, "returned": 20, "has_more": true },
  "file": { "file_name": "xdr_alerts_list.json", "file_size": 48213 },
  "data": { "total": 150, "page": 1, "pageSize": 20, "item": [ ... ] }
}
```

大结果：

```json
{
  "ok": true,
  "truncated": true,
  "summary": { "total": 12000, "returned": 200, "has_more": true },
  "file": { "file_name": "xdr_alerts_list.json", "file_size": 1834221 },
  "preview": { "total": 12000, "page": 1, "pageSize": 200 }
}
```

#### 9.3 智能体解析纪律

1. **先读 `summary`，再读 `data`**；不得跳过摘要直接猜总数；
2. `total` 必须来自响应字段，不得由 `item.length` 推断（分页时 `item.length` 只是本页条数）；
3. 分页循环：
   - 仅当 `has_more=true` 且用户明确要全量时继续；
   - 每页请求参数只改 `page`；其他参数保持不变；
   - 最多 5 页；到上限明确告知“未取全”；
4. 多接口编排：
   - 严格按分析方案的字段映射取值；
   - 上一步为空时停止，不得用空值继续调用；
5. 空数据：
   - `total=0` 或列表为空 → 明确说明无数据；
   - 给出放宽建议（时间范围、枚举、资产组）；
   - 不得编造记录；
6. 下游加工：
   - 统计/趋势/报表只使用 `data` 中的真实记录；
   - 需要二次核对时，用落盘文件或 `query_persisted_result`（大结果）。
7. 输出：
   - 默认只输出结论、总量、关键分布、文件名；
   - 用户明确要求时才展示明细/JSON。

#### 9.4 落盘与预算协同

| 数据规模 | 工具行为 | 模型可见 |
|---|---|---|
| ≤ 8000 字符 | 返回完整 `data` + 落盘 | 全量 |
| 8k–100k 字符 | 返回摘要 + 预览 + 落盘 | 预览；全量在 ToolMessage 中 |
| > 100k 字符 | 返回摘要 + 落盘 | 平台持久化到 `Execution.variables`，可用 `query_persisted_result` 取回 |

---

### Step 10：异常处理与降级

#### 10.1 Agent 处理矩阵

| `error_type` | Agent 必须做什么 | 禁止做什么 | 给用户的回复要点 |
|---|---|---|---|
| `CONFIG_MISSING` | 停止；输出配置引导 | 猜测地址、改用其他 host | 需要管理员配置 XDR 主机与联动码 |
| `CONFIG_INVALID` | 停止；提示轮换联动码 | 反复重试 | 联动码无效，请在 XDR 重新生成 |
| `AUTH_FAILED` | 停止；提示检查联动码/时间 | 改参数盲试 | 鉴权失败，可能是联动码失效或时钟偏差 |
| `PERMISSION_DENIED` | 停止；列出所需接口权限 | 换接口绕过权限 | 联动码未开放该接口 |
| `NOT_FOUND` | 回查文档校正 path；仅校正 1 次 | 连续换路径试错 | 接口路径不存在，已按文档校正 |
| `PARAM_ERROR` | 引用上游 message；回查字段规则；修正后重试 1 次 | 删必填字段、传默认值糊弄 | 参数不合法，说明具体字段 |
| `APP_ERROR` | 展示 `code/message`；按文档核对业务约束 | 当成成功继续 | 业务校验失败 |
| `RATE_LIMITED` | 退避后重试 1 次 | 连续快速重试 | 触发限流，稍后重试 |
| `UPSTREAM_ERROR` | 重试 1 次；仍失败则给替代接口/缩小范围 | 无限重试 | XDR 服务异常 |
| `TIMEOUT` | 缩小时间范围或降低 pageSize 后重试 1 次 | 原参数反复重试 | 请求超时，已缩小范围 |
| `NETWORK_UNREACHABLE` | 停止；提示网络策略 | 换 host | 平台到 XDR 网络不通 |
| `TLS_ERROR` | 停止；提示证书/校验开关 | 忽略证书错误继续 | TLS 证书校验失败 |
| `METHOD_FORBIDDEN` | 停止；说明仅支持查询 | 改成 POST 绕过 | 当前仅允许查询类请求 |

#### 10.2 降级链

1. **接口降级**：list 失败 → 检查是否有聚合/统计接口可满足同一口径（仅当分析文档确认）；
2. **范围降级**：时间范围过大 → 缩短到 1 天/7 天；
3. **分页降级**：pageSize 超限 → 降到文档允许值；
4. **能力降级**：XDR 不可达 → 明确返回“数据不可得”，不生成假数据；
5. **大屏降级**：无法生成源码 → 只交付需求规格与接口清单。

#### 10.3 重试纪律

- 仅 `retryable=true` 允许重试；
- 同一次用户请求，同一接口最多重试 1 次（总尝试 2 次）；
- 参数错误不得原样重试；
- 重试必须在回复中说明原因。

---

### Step 11：验证测试（可直接执行）

> 以下命令以 PowerShell + `curl.exe` 为例。`{BASE}` 为 `http://localhost:8000/api/v1`，`{TOKEN}` 为登录后的 Bearer Token。

#### T0：配置自检

```powershell
# 后端容器/进程内应能看到配置（不打印真实值）
curl.exe -s "{BASE}/tools?enabled=true" -H "Authorization: Bearer {TOKEN}"
```

预期：返回列表中存在 `query_xdr_openapi`、`search_xdr_api_docs`、`query_xdr_api_doc`。

#### T1：工具级签名请求（核心用例）

```powershell
curl.exe -s -X POST "{BASE}/tools/{tool_id}/test" `
  -H "Authorization: Bearer {TOKEN}" `
  -H "Content-Type: application/json" `
  -d '{"parameters":{"method":"POST","path":"/api/xdr/v1/assets/total","body":{"classify1Id":[1],"manageStatus":"in_depot"},"save_result":false}}'
```

预期：

- HTTP 200；
- `result.ok=true`、`result.http_status=200`、`result.code="Success"`；
- `result.summary.total` 为数字；
- `logs` 中无 `Authorization`、AK/SK、authCode。

#### T2：文档检索

```powershell
curl.exe -s -X POST "{BASE}/tools/{doc_search_tool_id}/test" `
  -H "Authorization: Bearer {TOKEN}" -H "Content-Type: application/json" `
  -d '{"parameters":{"keyword":"告警 列表 分页","domain":"alerts","limit":5}}'
```

预期：`results[0].path` 为 `api-docs/alerts/alert-list.md`，`title` 含 `POST /api/xdr/v1/alerts/list`。

#### T3：文档全文读取

```powershell
curl.exe -s -X POST "{BASE}/tools/{doc_read_tool_id}/test" `
  -H "Authorization: Bearer {TOKEN}" -H "Content-Type: application/json" `
  -d '{"parameters":{"path":"api-docs/alerts/alert-list.md"}}'
```

预期：`ok=true`，`content` 以 `# POST /api/xdr/v1/alerts/list` 开头。

#### T4：智能体“只分析不请求”

```powershell
curl.exe -s -X POST "{BASE}/agents/{agent_id}/test" `
  -H "Authorization: Bearer {TOKEN}" -H "Content-Type: application/json" `
  -d '{"input":"我要查询最近7天高危且未处置的告警，该调哪个接口？给我完整调用方案。","session_id":"t4"}'
```

预期：

- 输出包含接口路径、方法、参数、返回字段、枚举说明、校验结论；
- **不得出现真实数据/总数**；
- 执行日志中不应出现 `query_xdr_openapi` 调用。

#### T5：智能体端到端取数

```powershell
curl.exe -s -X POST "{BASE}/agents/{agent_id}/test" `
  -H "Authorization: Bearer {TOKEN}" -H "Content-Type: application/json" `
  -d '{"input":"按 POST /api/xdr/v1/alerts/list 方案，查询 2026-10-29 00:00:00 至 2026-11-05 00:00:00 高危且未处置告警的总数，pageSize=5。请执行并告诉我总数。","session_id":"t5"}'
```

预期：

- 回复先回显参数并说明执行；
- 调用 `query_xdr_openapi` 一次；
- 回复包含 `total` 与落盘文件名；
- 文件库中存在对应 JSON，行数与 `total`/分页逻辑一致；
- 与 XDR 前台同条件统计一致（允许因数据实时变化导致的合理差异）。

#### T6：异常路径

| 用例 | 输入 | 预期 `error_type` | 预期行为 |
|---|---|---|---|
| 路径错误 | `path=/api/xdr/v1/alert/list` | `NOT_FOUND` | 回查文档，指出正确路径，不盲试 |
| 参数错误 | `pageSize=500` | `PARAM_ERROR` | 引用上游 message，改为 5–200 |
| 权限不足 | 使用未开放该接口的联动码 | `PERMISSION_DENIED` | 明确提示开放权限 |
| 联动码失效 | 使用已删除的联动码 | `AUTH_FAILED` 或 `CONFIG_INVALID` | 停止并提示重配 |
| 网络不可达 | 临时改错 host | `NETWORK_UNREACHABLE` | 停止并提示网络策略 |
| 配置缺失 | 清空 `XDR_OPENAPI_HOST` | `CONFIG_MISSING` | 输出配置引导，不请求 |

#### T7：安全验收

- 工具日志、Agent 执行日志、回复内容中均无 authCode/AK/SK；
- 技能正文、提示词、Git 仓库中无联动码；
- 落盘 JSON 按数据分级存放，具备清理策略。

#### 验收判定

全部满足即验收通过：

1. T1/T2/T3 工具级测试通过；
2. T4 分析阶段零真实请求；
3. T5 成功取到真实数据且落盘可下载；
4. T6 六类异常均返回正确 `error_type` 且无编造；
5. T7 无凭证泄露；
6. 与 XDR 前台同口径数据一致。

---

## 5. 风险与边界

| 风险 | 影响 | 应对 |
|---|---|---|
| 联动码泄露 | 数据越权访问 | 立即轮换；仅环境变量注入；日志脱敏 |
| XDR 自签证书 | TLS 校验失败 | 默认 `VERIFY_SSL=false`；生产有证书时开启 |
| 大结果撑爆上下文 | 推理失败 | 8k 以上落盘 + 摘要；平台 100k 持久化 |
| 接口文档与实现漂移 | 参数错误 | 以文档为唯一权威；发现漂移先修订文档 |
| 枚举语言环境不一致 | 查询为空/错值 | 提示词固化 `zh_cn` 规则；国际版显式切换 |
| 大屏能力误用 | 承诺无法交付 | 提示词与技能正文明确“平台不生成源码/ZIP” |
| 工具超时 | 请求中断 | XDR 超时 20s < 引擎 30s；超时降级缩小范围 |

---

## 6. 附录

### 6.1 签名算法速查

| 项 | 规则 |
|---|---|
| 联动码 | hex → utf-8 → `split("|")` → 必须 14 段 |
| AES 密钥 | `sha256("+".join(parts[0,1,2,3,4,5,6,11]))` |
| AK/SK | AES-256-CBC，IV=16 字节 0，无 padding，解密 parts[9]/parts[10] |
| 签名路径 | 去 query，末尾补 `/`，URL 编码保留 `/` |
| Query 串 | key 字典序，`k=v&k=v`，均 URL 编码 |
| Header 串 | 按 key 小写排序，逐行 `k:v\n`，再拼 `k1;k2` |
| Payload 哈希 | UTF-8 字节升序 → 去 0x20 → SHA-256 → 大写 hex |
| Canonical | `METHOD\nPATH\nQUERY\nHEADER_LINES+SIGNED_HEADERS\nPAYLOAD_HASH` |
| 最终签名 | `HMAC-SHA256(sk, "HMAC-SHA256\n"+sign_date+"\n"+sha256(canonical).upper())` |
| 发送要求 | 签名后不得修改任何请求要素；body 使用同一份序列化字节 |

### 6.2 工具与文档路径索引

| 用途 | 工具/路径 |
|---|---|
| 检索接口 | `search_xdr_api_docs(keyword, domain)` |
| 读取接口/规范 | `query_xdr_api_doc(path)` |
| 执行请求 | `query_xdr_openapi(method, path, query, body)` |
| 接口文档根 | `backend/app/data/xdr_skill_reference/api-docs/` |
| 规范文档 | `backend/app/data/xdr_skill_reference/*.md` |

### 6.3 推荐执行顺序（交付 checklist）

1. 轮换联动码，写入部署环境变量；
2. 新增 `xdr_openapi.py` 与 `xdr_docs.py`；
3. 同步 `xdr_skill_reference/` 文档目录；
4. 新增 `definitions/xdr.py` 并注册到 catalog；
5. 注入沙箱命名空间；
6. 标记只读/无副作用；
7. 重启后端，确认工具库出现 3 个工具；
8. 改造 3 条技能正文；
9. 更新目标 Agent 提示词并绑定技能/工具；
10. 执行 T0–T7 验证；
11. 记录验收结果与已知限制。

---

> 本方案严格遵循《XDR 开放性 Skill 能力标准文档》的定位、输入输出、签名机制与安全规范；未引入任何与标准冲突的替代实现。
