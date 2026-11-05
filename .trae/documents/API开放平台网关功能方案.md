# API 开放平台（数据开放网关）实施方案

## 一、需求概述

将系统数据通过开放 API 提供给第三方系统调取，具备：
- **安全**：API Key 认证、IP 白名单、过期时间、按应用可配置的数据授权、独立限流配额
- **监控**：调用日志、调用量/成功率/耗时统计、管理看板
- **数据可见性**：每个应用授权了哪些资源、每个资源开放了什么数据一目了然

已确认决策：**API Key 认证**（非 HMAC/OAuth2）、**可配置授权**（按应用勾选资源目录）、**需要完整前端管理界面**。

## 二、现状分析（探索结论）

| 能力 | 现状 | 可复用性 |
|---|---|---|
| 框架 | FastAPI（[main.py](file:///d:/trae%20project/soar-src/backend/app/main.py)），路由统一挂 `/api/v1`（[api/v1/\_\_init\_\_.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/__init__.py)） | 网关路由照此注册 |
| 用户鉴权 | JWT `get_current_user` / `require_permission(module, action)`（[dependencies.py](file:///d:/trae%20project/soar-src/backend/app/dependencies.py#L87-L144)） | 管理端点复用；开放端点用新的 API Key 依赖 |
| 限流 | slowapi（[core/limiter.py](file:///d:/trae%20project/soar-src/backend/app/core/limiter.py)），key 维度为 IP，且限流值需静态声明 | **不适合按应用动态配额**，改为 Redis 固定窗口（Redis 已在项目中使用，见 JWT 黑名单） |
| 审计 | `audit_middleware` 只记写操作（[core/audit.py](file:///d:/trae%20project/soar-src/backend/app/core/audit.py#L206-L251)），`get_client_ip()` 可复用 | 网关全是 GET，不冲突；新写一个专用调用日志中间件，模式照抄 audit_middleware |
| 权限模块 | `PERMISSION_MODULES` / `MODULE_NAMES`（[core/permissions.py](file:///d:/trae%20project/soar-src/backend/app/core/permissions.py#L35)），main.py 启动时自动同步 admin 全量 | 新增 `open_api` 模块即可自动下发 |
| 建表 | `Base.metadata.create_all` 启动自动建表（main.py `_init_db`），新表无需迁移脚本 | 新模型自动建表 |
| 前端 | React19 + Vite + Zustand + ECharts；路由在 [App.jsx](file:///d:/trae%20project/soar-src/frontend/src/App.jsx#L174-L177)（`RequirePermission` 模式），菜单在 AppShell.jsx | 新页面照现有模式注册 |

**开放数据候选资源**（模型已确认存在）：告警 `alert_events`、资产 `assets`、封禁 IP `banned_ips`、工单 `tickets`、工作流执行 `executions`、统计汇总。

## 三、总体架构

```
第三方系统 ──(X-API-Key)──> /api/v1/open/{resource}   ← 网关端点（API Key 鉴权）
                              │
                              ├─ 鉴权: app 有效/未过期/IP白名单/scope 授权
                              ├─ 限流: Redis 每应用独立配额
                              └─ 调用日志中间件 → open_api_call_logs

管理员(JWT) ──> /api/v1/open-admin/*                  ← 管理端点（权限矩阵 open_api 模块）
                              ├─ 应用/密钥/授权 CRUD
                              ├─ 调用统计 / 日志查询
                              └─ 资源目录（开放了什么数据）
```

## 四、后端改动

### 4.1 数据模型（新文件 `backend/app/models/open_api.py`）

单文件 3 个模型，在 `models/__init__.py` 中 import（触发 create_all 建表）：

```python
class OpenApiApp(Base):            # 表 open_api_apps
    id, app_name(String(64), unique, not null)
    description(String(255), default "")
    access_key(String(64), unique, index, not null)   # "ak_" + 32位随机hex，公开标识
    secret_hash(String(64), not null)                 # secret 明文的 SHA-256，明文不落库
    status(String(16), default "active")              # active / disabled
    rate_limit_per_minute(Integer, default 60)        # 该应用每分钟最大调用量
    allowed_ips(Text, default "[]")                   # JSON 数组，空数组=不限制
    expires_at(DateTime, nullable)                    # 可选过期时间
    total_calls(Integer, default 0)                   # 累计调用数（异步累加）
    last_call_at(DateTime, nullable)
    created_by(Integer)                               # 创建管理员 user.id
    created_at(DateTime, default beijing_now)

class OpenApiScope(Base):           # 表 open_api_scopes
    id, app_id(FK open_api_apps.id, ondelete CASCADE, index)
    resource_code(String(64), not null)
    UniqueConstraint(app_id, resource_code)

class OpenApiCallLog(Base):         # 表 open_api_call_logs
    id, app_id(index, nullable)      # 应用被删后日志保留 → nullable
    app_name(String(64))             # 冗余快照，防应用删除后日志失去归属
    resource_code(String(64), index)
    method(String(8)), path(String(255))
    query_params(Text, default "")   # 查询参数 JSON 摘要
    status_code(Integer)
    response_ms(Integer)
    client_ip(String(64))
    user_agent(String(255))
    error_message(Text, nullable)
    created_at(DateTime, index, default beijing_now)  # 时间范围查询走索引
```

### 4.2 开放资源目录（新文件 `backend/app/core/open_api_registry.py`）

声明"开放了什么数据"的唯一权威来源，管理端与网关共用：

```python
OPEN_API_RESOURCES = {
    "alerts":           {"name": "告警事件", "description": "标准化告警列表（含严重级别/状态/源IP/时间）",
                          "filters": ["status", "severity", "start_time", "end_time"]},
    "assets":           {"name": "资产清单", "description": "资产名称/IP/类型/部门/负责人/状态", ...},
    "banned_ips":       {"name": "封禁记录", "description": "IP封禁记录与到期状态", ...},
    "tickets":          {"name": "安全工单", "description": "工单标题/状态/处理人/SLA", ...},
    "executions":       {"name": "执行记录", "description": "工作流执行历史与结果", ...},
    "dashboard_stats":  {"name": "安全统计汇总", "description": "告警/封禁/工单总量等聚合指标", ...},
}
```

每个资源实现只读 handler `def list_xxx(db, params) -> (items: list[dict], total: int)`：
- 直接查询对应模型（alert_event.py / asset.py / banned_ip.py / ticket.py / execution.py 等），**输出字段白名单裁剪**，剔除 `devices`/`extensions`/`extra_fields` 等原始大 JSON 与敏感字段（secret/password_hash 一律不出现）
- 统一约定：`page`（默认1）、`page_size`（默认20，**上限100**）、`start_time`/`end_time` 过滤
- `dashboard_stats` 返回聚合 dict（告警总数/今日新增/未处置、封禁总数/生效中、工单总数/进行中等），不分页

### 4.3 网关鉴权（新文件 `backend/app/core/open_api_auth.py`）

```python
def generate_key_pair() -> tuple[str, str, str]:
    # 返回 (access_key, secret, secret_hash)
    # access_key = "ak_" + secrets.token_hex(16)
    # secret = "sk_" + secrets.token_hex(32)   # 明文仅在创建/重置响应中一次性返回
    # secret_hash = hashlib.sha256(secret.encode()).hexdigest()

def verify_api_key(resource_code: str) -> Callable:   # FastAPI 依赖工厂
    # 1. 从 X-API-Key 头取值，格式 "{access_key}:{secret}"；缺失/格式错 → 401
    # 2. 查 OpenApiApp：不存在 → 401；status != active → 403(应用已停用)；
    #    expires_at 已过 → 403(应用已过期)
    # 3. sha256(secret) != secret_hash → 401；连续失败 10 次锁 10 分钟(Redis 计数，防爆破)
    # 4. IP 白名单：allowed_ips 非空时，get_client_ip(request)(复用 core/audit.py)
    #    不在名单 → 403
    # 5. Scope 校验：OpenApiScope 中无 (app_id, resource_code) → 403(未授权该资源)
    # 6. 限流：Redis INCR "open_api:rl:{access_key}" + EXPIRE 60s 固定窗口，
    #    超过 app.rate_limit_per_minute → 429；Redis 不可用时降级放行(与 JWT 黑名单降级策略一致)
    # 7. 通过 → 返回 app 对象，并挂 request.state.open_api_app 供日志中间件使用
```

同文件内实现**调用日志中间件** `open_api_call_middleware`（模式照抄 [audit_middleware](file:///d:/trae%20project/soar-src/backend/app/core/audit.py#L206-L251)）：
- 仅处理 `path.startswith("/api/v1/open/")` 的请求（401/403/429 拒绝也要记录，便于监控攻击与误配置）
- 记录耗时（`time.perf_counter`）、status_code、query_params、client_ip、user_agent、error_message（5xx 时）
- 独立 `SessionLocal` 写 `OpenApiCallLog`，同步累加 `OpenApiApp.total_calls/last_call_at`（同一条 update 语句），失败仅 warning 不阻断

### 4.4 网关路由（新文件 `backend/app/api/v1/open_api.py`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/open` | 该 Key 有权访问的资源目录（code/name/description/支持过滤参数）——第三方自助发现"能拿什么数据" |
| GET | `/api/v1/open/{resource_code}` | 统一数据端点，`Depends(verify_api_key(resource_code))`，响应 `{code:0, message:"ok", resource:{code,name}, data:{items, total, page, page_size}}`；resource_code 不在目录 → 404 |

### 4.5 管理路由（新文件 `backend/app/api/v1/open_api_admin.py`）

全部走 JWT + `require_permission("open_api", ...)`（[dependencies.py L222](file:///d:/trae%20project/soar-src/backend/app/dependencies.py#L222-L247)）：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/open-admin/apps` | view | 应用列表（含授权资源数/总调用/最近调用，secret 不返回） |
| POST | `/open-admin/apps` | edit | 创建应用，body: app_name/description/resource_codes/rate_limit_per_minute/allowed_ips/expires_at；**响应一次性返回 access_key + secret 明文** |
| PUT | `/open-admin/apps/{id}` | edit | 更新名称/描述/限流/白名单/过期时间/状态（启用停用）/resource_codes 全量替换 |
| DELETE | `/open-admin/apps/{id}` | edit | 删除应用（scope 级联删除，调用日志保留） |
| POST | `/open-admin/apps/{id}/rotate-secret` | edit | 重置密钥，旧密钥立即失效，一次性返回新 secret |
| GET | `/open-admin/resources` | view | 全量资源目录（供管理页勾选授权） |
| GET | `/open-admin/stats` | view | 看板数据：时间序列(近24h按小时/近7天按天)、按应用聚合、按资源聚合、成功率、平均耗时、今日调用数 |
| GET | `/open-admin/call-logs` | view | 调用日志分页列表，过滤：app_id/resource_code/status_code(可按 4xx/5xx)/start_time/end_time/client_ip |

管理操作（创建/修改/删除/重置密钥）调用现有 `log_audit()`（[core/audit.py L15](file:///d:/trae%20project/soar-src/backend/app/core/audit.py#L15-L68)）写审计日志，`resource_type="open_api_app"`。

### 4.6 权限模块注册（[core/permissions.py](file:///d:/trae%20project/soar-src/backend/app/core/permissions.py)）

- `PERMISSION_MODULES` 增加 `"open_api": ["view", "edit"]`
- `MODULE_NAMES` 增加 `"open_api": "API开放平台"`
- main.py 启动时 `_sync_role_permission_modules` 会自动为 admin 角色展开全量，无需额外种子

### 4.7 路由与中间件注册

- [api/v1/\_\_init\_\_.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/__init__.py)：include `open_api.router`、`open_api_admin.router`
- [models/\_\_init\_\_.py](file:///d:/trae%20project/soar-src/backend/app/models/__init__.py)：import `open_api` 三个模型
- [main.py](file:///d:/trae%20project/soar-src/backend/app/main.py#L393-L396)：在现有 `_audit_middleware` 旁注册 `open_api_call_middleware`（`@app.middleware("http")`）
- **无需**改 `_RESOURCE_MAP`（网关全 GET，审计中间件只记写操作）

## 五、前端改动

### 5.1 API 客户端（新文件 `frontend/src/api/openApi.js`）

照 `frontend/src/api/` 下现有模块模式封装上表全部管理端点。

### 5.2 管理页面（新目录 `frontend/src/pages/openapi/`）

主页面 `ApiOpenManage.jsx`，三个 Tab（子组件同目录）：

1. **应用管理** `AppsTab.jsx`
   - 表格：应用名 / access_key（可复制）/ 状态(启用/停用 tag) / 授权资源(倒排 chip) / 限流(次/分) / 累计调用 / 最近调用 / 操作
   - 新建/编辑抽屉：名称、描述、**授权资源多选**（来自 `/open-admin/resources`，每项显示 name+description，明确"开放的是什么数据"）、限流输入、IP 白名单 tag 输入、过期时间可选
   - **密钥一次性弹窗**：创建/重置成功后全屏弹窗展示 access_key + secret，红字警示"仅此一次显示"，带复制按钮
   - 操作：停用/启用、重置密钥（二次确认）、删除（二次确认）

2. **调用监控** `StatsTab.jsx`
   - 概览卡片：今日调用总数 / 成功率(2xx占比) / 平均耗时 / 活跃应用数
   - ECharts 折线图（echarts-for-react 已在依赖中）：调用量趋势（24h/7d 切换），双系列=成功/失败
   - 按资源 / 按应用聚合柱状图

3. **调用日志** `LogsTab.jsx`
   - 筛选器：应用下拉 / 资源下拉 / 状态码（全部/2xx/4xx/5xx）/ 时间范围
   - 表格：时间 / 应用 / 资源 / method / path / 状态码(色标) / 耗时 / IP

### 5.3 路由与菜单

- [App.jsx](file:///d:/trae%20project/soar-src/frontend/src/App.jsx#L174-L177)：
  ```jsx
  { path: '/api-open', element: <RequirePermission perm={['open_api', 'view']} label="API开放平台"><ApiOpenManage /></RequirePermission> }
  ```
- [AppShell.jsx](file:///d:/trae%20project/soar-src/frontend/src/components/AppShell.jsx)：在系统管理区（备份恢复/审计日志同级）加"API开放平台"菜单项，key `open_api`

## 六、安全设计要点汇总

1. Secret 明文**仅创建/重置时一次性返回**，库中只存 SHA-256（key 为 64+ 位高熵随机值，快哈希即可，不用 bcrypt 避免拖慢高频校验）
2. 密钥错误连续 10 次 → 该 access_key 锁定 10 分钟（Redis 计数，防爆破）
3. IP 白名单可选；过期时间可选；停用立即生效
4. 输出字段白名单裁剪，杜绝 secret/password_hash/原始设备 JSON 泄露；page_size 上限 100
5. 每应用独立限流配额（Redis 固定窗口），Redis 故障降级放行（与项目既有降级策略一致）
6. 网关端点只读（GET only），无写操作面
7. 管理操作全部落审计日志

## 七、实施顺序

1. 模型 + 注册（models/open_api.py、models/__init__.py）→ 启动建表
2. 资源目录 + 各资源只读 handler（open_api_registry.py）
3. 鉴权依赖 + 调用日志中间件（open_api_auth.py）+ main.py 注册
4. 网关路由（open_api.py）+ 管理路由（open_api_admin.py）+ 权限模块（permissions.py）+ api/v1/__init__.py 注册
5. 前端 API 客户端 → 三个 Tab 页面 → 路由/菜单注册

## 八、验证步骤

**后端（curl / httpx）**
1. 启动服务确认三张新表自动创建
2. JWT 登录 admin → `POST /api/v1/open-admin/apps` 创建应用（授权 alerts），记录一次性返回的 access_key:secret
3. `GET /api/v1/open/alerts` 带正确 `X-API-Key` → 200 返回分页数据
4. 不带 Key → 401；错误 secret → 401；授权外的资源 `assets` → 403；`GET /api/v1/open` 仅显示 alerts 一项
5. 快速连打超过 rate_limit_per_minute → 429
6. 停用应用后再调 → 403；rotate-secret 后旧密钥 401、新密钥 200
7. 查 `open_api_call_logs`：401/403/429/200 均有记录且耗时/状态码正确
8. 非 admin 且无 `open_api` 权限的用户调 `/open-admin/*` → 403

**前端**
9. 以 admin 登录：侧栏出现"API开放平台"，三个 Tab 正常渲染
10. 创建应用 → 密钥一次性弹窗；监控 Tab 出现调用曲线；日志 Tab 可按资源/状态码过滤

**回归**
11. 现有登录、审计日志、webhook 等功能不受影响（新增均为独立前缀，无既有路由改动）
