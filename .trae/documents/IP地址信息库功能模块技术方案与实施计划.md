# IP地址信息库功能模块 — 技术方案与实施计划（修订版）

## Context（背景）

在「资源管理」下新增**独立菜单项「IP地址库」**，导入并管理 4 份 IPv4 数据源 CSV，总计约 **92.5 万行**：

| 库代码 | 数据源 | 行数 | 表 |
|---|---|---|---|
| `cloud_cn` | 中国大陆云服务IPv4合集 | 257 | ip_lib_cloud_cn |
| `geo_cn` | 中国大陆APNIC分配及运营商地理信息 | 82,461 | ip_lib_geo_cn |
| `holder_cn` | 中国大陆APNIC含注册持有者 | 82,461 | ip_lib_holder_cn |
| `overseas` | 境外IPv4地址库（全球减中国大陆） | 760,248 | ip_lib_overseas |

**核心设计取向（用户已确认）**：
- 数据存储：**4 个独立分表**（每库自有 schema，复用政务云动态建表模式）
- 导入方式：**Celery 后台异步任务**（上传即返回，前端轮询进度）
- 功能入口：**资源管理下独立菜单项**（与资产管理平级），新顶级权限模块 `ip_library`
- 前端形态：**概览 + 查询为主，不做全量列表浏览**——92.5 万行静态参照库逐页浏览价值低，核心场景是「查 IP 归属」；仅对查询结果分页，顺带消除深分页性能问题

## 一、数据存储结构（4 分表 + 索引）

**新建 `backend/app/models/ip_library.py`**，工厂模式动态建 4 模型（复用 [govcloud_asset.py L76-109](file:///d:/trae%20project/soar-src/backend/app/models/govcloud_asset.py#L76-L109) 的 `_build_resource_model` 模式）+ 1 张批次表。

### 通用列（4 表共有）

```python
id       = Integer, primary_key
cidr     = String(64), nullable=False    # 规范化 CIDR，如 "1.2.3.0/24"
ip_start = BigInteger, nullable=False     # 网络地址整数（无符号32位，必须 bigint，int4 溢出）
ip_end   = BigInteger, nullable=False     # 广播地址+1（右开）
ip_range = INT8RANGE, nullable=False      # [ip_start, ip_end)，随行写入
batch_id = FK → ip_library_import_batches.id, index
created_at / updated_at
```

### 各库业务列

- **cloud_cn**：`cloud_provider`（云服务商名称）
- **geo_cn**：`isp, province, city, geo_status, apnic_status, apnic_alloc_date`
- **holder_cn / overseas**（14 列同构）：`holder_name, holder_match_level, holder_url, isp, country_geo, province, city, rir_country, rir_registry, reg_status, alloc_date, geo_country_code, geo_status`

### 每表索引

| 索引 | 用途 |
|---|---|
| `UNIQUE(ip_start, ip_end)` | upsert 冲突目标（整数键天然去重：`1.2.3.0/24` 与 `1.2.3.4/24` 规范化后同键） |
| `GiST(ip_range)` | IP 点查 `@>` / 网段重叠 `&&`（项目已验证 9.8 万行 ~1ms；本表预估 1-5ms） |
| `btree(ip_start)` | 查询结果按网段排序 |
| `GIN trgm(文本列)` | 关键词包含匹配（holder_cn/overseas：isp+holder_name+country_geo+province+city；geo_cn：isp+province+city；cloud_cn：cloud_provider） |

### 批次表 `ip_library_import_batches`（照抄 [GovCloudImportBatch](file:///d:/trae%20project/soar-src/backend/app/models/govcloud_asset.py#L13-L55)，新增异步状态字段）

`library_type, filename, file_size, status(pending/running/success/failed), phase(parsing/importing/finalizing), percent, csv_rows, unique_cidrs, inserted, updated, deleted, skipped, live_count, duration_ms, import_mode(full/incremental), note, created_by, created_at`

### 建表与 pg_trgm

- `models/__init__.py` 注册新模型；
- [main.py `_init_db`](file:///d:/trae%20project/soar-src/backend/app/main.py#L35-L52)：`create_all` **之前**执行幂等 `CREATE EXTENSION IF NOT EXISTS pg_trgm`（postgres:15 镜像自带 contrib），trgm GIN 索引随表一次建好。

## 二、异步导入与增量更新（Celery）

复用 [celery_app.py](file:///d:/trae%20project/soar-src/backend/app/core/celery_app.py)（Redis broker）+ [workflow_tasks.py](file:///d:/trae%20project/soar-src/backend/app/tasks/workflow_tasks.py) 的「DB 状态跟踪 + 前端轮询」模式。

### 流程

1. **`POST /ip-library/import?library_type=&mode=`**（multipart CSV，权限 `ip_library/edit`）：
   - 校验（.csv、≤100MB）→ 保存至 `backend/uploads/ip_library/<batch_id>.csv`（复用 [knowledge_base.py UPLOAD_DIR](file:///d:/trae%20project/soar-src/backend/app/api/v1/knowledge_base.py#L29-L34) 模式，Celery worker 同卷可读）
   - 创建批次记录（status=pending）→ 派发 Celery 任务 → **立即返回 `{batch_id}`**
2. **新建 `backend/app/tasks/ip_library_tasks.py`** `@celery_app.task import_ip_library(batch_id, library_type, mode, file_path)`：
   - 复用 govcloud 的 `_decode_csv_bytes` 编码策略 + 中文表头映射 + 每 2000 行 `ON CONFLICT(ip_start, ip_end) DO UPDATE` 分块 upsert
   - 每完成一批更新批次记录：phase/percent/inserted/updated（前端轮询可见）
   - **full**：upsert 后 `DELETE WHERE batch_id != :新批次`；**incremental**：仅 upsert
   - 解析失败行 skipped 计数不中断；结束回填 live_count/duration_ms/status，删除临时文件
3. **前端轮询** `GET /ip-library/batches/{id}`（1.5s 间隔）展示进度；导入中可关页面继续其他操作，批次历史可见最终状态

## 三、查询接口设计（查询为主，无全量浏览）

| 端点 | 说明 | 权限 |
|---|---|---|
| `GET /ip-library/meta` | 4 库定义（列/标签）+ **概览统计**（网段数、覆盖 IP 数、最近批次） | view |
| `GET /ip-library/lookup?ip=` | **核心点查**：4 表并行 GiST `@>`（UNION ALL），返回 IP 命中的所有网段及归属（库/cidr/运营商/持有者/国家/省市） | view |
| `GET /ip-library/records` | **条件查询结果分页**：`ip`/`cidr`（GiST）或 `keyword`（trgm）或 `country`/`isp`/`province` 等值过滤，`library_type` 可选（不传=4 表 UNION ALL），page/page_size(默认50)，按 ip_start 排序。**不做无条件的全量浏览** | view |
| `GET /ip-library/export` | 导出当前查询结果 CSV（流式，复用 `_iter_csv` 分块模式） | view |
| `POST /ip-library/import` | 异步导入（见上节） | edit |
| `GET /ip-library/batches`、`GET /ip-library/batches/{id}` | 批次历史 / 单批次进度（轮询用） | view |

**性能要点**：
- IP 点查：4 表 GiST 各 1-5ms，合计 <100ms
- 查询结果分页：结果集通常小（关键词命中数千行内），btree 排序 + LIMIT/OFFSET <300ms；**UI 不暴露 76 万行深翻页，深分页问题从设计上消除**
- 覆盖 IP 数等统计随导入完成时计算并缓存在 meta（数据静态，无需实时聚合）

## 四、前端方案（概览 + 查询，无全量列表）

- **`frontend/src/api/ipLibrary.js`**：request 封装 meta/lookup/records/batches；`importCsv`（XHR 上传→返回 batch_id→轮询 batches/{id}）；`exportCsv`（fetch blob 下载）
- **`frontend/src/pages/IpLibrary.jsx`**：
  - **概览区**：4 库统计卡片（网段数、覆盖 IP 数、最近导入时间，源自 meta）
  - **查询区（页面主体）**：单一搜索框智能识别输入类型——单 IP / CIDR 网段 / 关键词（运营商、持有者、国家、省市）；高级筛选（库/国家/运营商 CompactSelect）可折叠；`Enter` 或按钮触发
  - **结果区**：命中网段列表（按库着色 Badge），动态列（按库 schema），仅结果分页（50/页）；IP 精确命中置顶高亮
  - **导入 Modal**（选库 + full/incremental + 文件 + 进度条 parsing→importing→done，轮询驱动）+ **批次历史 Drawer**（状态/耗时/行数统计）
  - 复用 ui.jsx 现有组件：PageContainer/PageHeader/Card/Badge/DataTable/Pagination/CompactSelect/LoadingState/EmptyState + Dialog.jsx Modal/Drawer
  - 服务端分页，单页 DOM 恒定，交互 <16ms 无卡顿

### 入口与权限注册（完整链路已核验）

- **路由** [App.jsx](file:///d:/trae%20project/soar-src/frontend/src/App.jsx#L165-L169)：`/ip-library` + `RequirePermission perm={['ip_library','view']}`
- **菜单** [AppShell.jsx L54-71](file:///d:/trae%20project/soar-src/frontend/src/components/AppShell.jsx#L54-L71)：资源管理 items 加独立项 `{ to: '/ip-library', icon: Globe, label: 'IP地址库', perm: ['ip_library','view'] }`（与「资产管理」「材料管理」平级）+ 面包屑映射 `'/ip-library': ['资源管理', 'IP地址库']`
- **权限** [permissions.py](file:///d:/trae%20project/soar-src/backend/app/core/permissions.py)：
  - `PERMISSION_MODULES["ip_library"] = ["view", "edit"]`（新顶级模块，**不**从 asset 继承——独立菜单语义）
  - `MODULE_LABELS["ip_library"] = "IP地址库"`；`ACTION_LABELS` 已有 view/edit 无需改
  - `DEFAULT_ROLES`：analyst 加 `ip_library: ["view","edit"]`、viewer 加 `["view"]`（种子角色自动获得；存量自定义角色由管理员在角色管理中授权，权限页面动态读取 PERMISSION_MODULES 自动展示新模块）
- **路由聚合** [api/v1/__init__.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/__init__.py) include_router

## 五、性能指标承诺

| 指标 | 目标 |
|---|---|
| IP 点查 lookup（4 表 GiST UNION） | < 100ms |
| 条件查询分页（关键词/网段/筛选） | < 300ms |
| 76 万行全量导入（后台异步，不阻塞用户） | < 90s（解析 5-10s + 380 批 upsert） |
| 概览统计 meta（缓存值） | < 50ms |
| 前端交互 | 每页固定 50 行结果，无卡顿 |
| 存储体积 | 92.5 万行 + 索引 < 1GB |

## 六、实施文件清单

**新建**：
1. `backend/app/models/ip_library.py`（4 数据表工厂 + IpLibraryImportBatch）
2. `backend/app/api/v1/ip_library.py`（meta/lookup/records/export/import/batches 六端点）
3. `backend/app/tasks/ip_library_tasks.py`（Celery 异步导入任务）
4. `frontend/src/api/ipLibrary.js`
5. `frontend/src/pages/IpLibrary.jsx`

**小改**：
6. `backend/app/models/__init__.py`（模型注册）
7. `backend/app/api/v1/__init__.py`（include_router）
8. `backend/app/main.py`（create_all 前建 pg_trgm 扩展）
9. `backend/app/core/permissions.py`（PERMISSION_MODULES / MODULE_LABELS / DEFAULT_ROLES）
10. `frontend/src/App.jsx`（路由）
11. `frontend/src/components/AppShell.jsx`（菜单项 + 面包屑）

**实施顺序**：模型+注册 → main.py 扩展 → Celery 任务 → 后端 API → 权限 → 前端 client → 页面 → 菜单/路由。

## 七、验证步骤

1. 启动 postgres/redis/celery worker 与后端，确认建表日志；psql 验证 4 表索引齐备、`pg_extension` 含 pg_trgm
2. `curl -F` 上传 4 份真实 CSV：接口应立即返回 batch_id；轮询 batches/{id} 观察进度至 success，核对 inserted/live_count 与 CSV 行数一致、duration_ms < 90s
3. 幂等验证：overseas 同文件重复 full 导入 → live_count 不变
4. `EXPLAIN ANALYZE` 确认 lookup 走 GiST；`time curl` 验证点查 <100ms、关键词查询 <300ms
5. 边界验证：抽 CSV 网段的首/末 IP 调 lookup，确认含 ip_start、不含 ip_end（右开语义）
6. 前端 `npm run dev`：概览卡片数字正确；IP/CIDR/关键词三种输入均正确识别并返回结果；导入中关页面再打开批次历史仍能看到最终状态；admin 外角色验证权限（viewer 可查不可导、analyst 可导入）
7. 审计日志页确认 import/export 已记录
