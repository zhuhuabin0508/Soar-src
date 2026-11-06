# POST /api/xdr/v1/assets/fingerprints/list

## 接口概述

本接口用于根据资产 ID 列表批量查询资产指纹（清单）信息，支持按指纹类型（开放端口、应用软件、数据库、Web 服务、Web 框架、Web 应用、Web 站点、账号、进程、运行服务、网络连接、启动项、注册表、计划任务、开放共享等 16 类）筛选返回。通过本接口，您可以获取以下内容：

### 可查询的指纹信息（16 类，由 16 个 DAO 提供）
- **网络端口**：`portsOpend` → `AssetPortDao`（含端口、协议、暴露状态、关联进程）
- **应用软件**：`software` → `AssetSoftwareDao`（含名称、版本、厂商、安装路径、关联进程数）
- **数据库**：`database` → `AssetSoftwareDao`（按 `classify1_id=DATABASE_CLASSIFY1_ID` 过滤，含端口/协议关联）
- **Web 服务**：`webService` → `AssetSoftwareDao`（按 `classify_id=WEB_SERVER_CLASSIFY_ID` 过滤）
- **Web 框架**：`webFrame` → `AssetWebFrameDao`（含名称、版本、语言、类型、路径）
- **Web 应用**：`webApp` → `AssetWebAppDao`（含名称、版本、类型、域名、根文档路径、虚拟路径、插件数）
- **Web 站点**： `webSite` → `AssetWebSiteDao`（含域名、协议、端口、IP、负责人、cmd、备案）
- **账号**：`account` → `AssetAccountDao`（含名称、状态、UID/GID、管理员/Root/Sudo 权限标志、shell、密码更新/过期时间）
- **进程**：`process` → `AssetProcessDao`（含名称、版本、PID、状态、CPU/内存、命令行、启动时间、父进程、MD5）
- **运行服务**：`service` → `AssetServiceDao`（含名称、状态、负责人、启动类型、执行路径、启动时间、描述）
- **网络连接**：`connection` → `AssetConnectionDao`（含本端/远端地址端口、进程、协议）
- **启动项**：`bootItem` → `AssetBootItemDao`（含名称、发布者、负责人、状态、注册表键）
- **注册表**：`registry` → `AssetRegeditDao`（含键、值名、值类型、值数据）
- **计划任务**：`scheduledTask` → `AssetCrontabDao`（含名称、命令、负责人、状态、执行时间、创建时间）
- **开放共享**：`share` → `AssetShareDao`（含名称、状态、路径、描述）

数据来源于资产清单子表（`A_Port`、`A_Software`、`A_WebFrame` 等 16 张表），通过各指纹类型对应的 DAO 执行 `find(filters={asset_id: {$in: [...]}, ...}, projection=...)` 查询，业务层按资产 ID 维度聚合为 `{assetId, fingerPrints: [{fingerTab, fingerTabName, data, total}]}` 结构返回。

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1FingerprintList` |
| 所属业务域 | 资产管理 / 资产指纹（清单） |
| 接口分类 | 数据查询（多 DAO 聚合，无写入） |
| 前置依赖 | `assetIds` 必须为系统中已存在的资产 ID；`fingerTabs` 若传必须为 `FINGERPRINT_TAB_LIST` 中已定义的值 |
| 关联接口 | `POST /api/xdr/v1/assets/list`（先查资产列表获取 `assetIds`）、`POST /api/xdr/v1/assets`（资产录入后产生指纹数据） |

## 使用场景

1. **资产详情页指纹展示**：前端资产详情页一次性拉取资产所有指纹信息（`fingerTabs=["all"]` 或不传），分类展示端口、软件、Web 资源、账号、进程等
2. **按类型批量查询指纹**：第三方安全分析系统只需查询某类指纹（如仅查端口 `fingerTabs=["portsOpend"]`），减少响应体大小
3. **资产盘点**：批量传入 `assetIds`（最多 100 个）查询一组资产的指纹分布，用于软件合规、端口暴露、账号分布分析
4. **配合资产列表查询**：调用 `POST /api/xdr/v1/assets/list` 拿到 `assetIds` 后，调用本接口获取资产详细指纹
5. **进程-端口关联分析**：查询 `process` + `portsOpend` 两类指纹，业务层会自动关联端口对应的进程命令行和用户

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/fingerprints/list |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/fingerprints/list` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/fingerprints/list`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/fingerprints/views.py:22`（`V1FingerprintList.post`）。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.GET_ASSET_PARAMS)` 校验请求体符合 JSON Schema 约束：
   - `assetIds` 必填，整数数组，`maxItems=100`，元素 `minimum=1`
   - `fingerTabs` 可选，字符串数组，`maxItems=16`，元素枚举为 `FINGERPRINT_TAB_LIST`
   - `page`/`pageSize` 可选，整数，`minimum=1`，`pageSize` `maximum=100`
   - 含 `AKSK_SAAS_EXCLUDE_PARAMS`、`AKSK_SAAS_EXCLUDE_BRANCH_ID`、`IS_CLOUD_AKSK_REQUEST` 等多租户/AKSK 兼容字段
   - `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段
   - 校验失败抛 `V1_INVALID_PARAMETER`（HTTP 400，code=1104）
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`；`@trans_ctx_pid_query(PlatformMode.NOTALL, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（NOTALL 模式：本平台 + 已授权下级平台）。
3. **业务函数 `business.get_fingerprints_list(data)` 调用**（源码 `fingerprints/business.py:497`）：
   1. **参数预处理 `transform_params(data)`**（源码 `open_api/v1/resources/common.py:32`）：
      - `assetIds` → `ids`：`new_params["ids"] = params.pop("assetIds", [])`
      - `page` → `start`：`new_params["start"] = params.pop("page", 1) - 1`（0 基）
      - `pageSize` → `limit`：`new_params["limit"] = params.pop("pageSize", 5)`
      - 剩余字段经 `transform_hump_params`（驼峰转下划线），如 `fingerTabs` → `finger_tabs`、`isCloudAkSk` → `is_cloud_ak_sk`
   2. **资产 ID 分页**：
      - `start_index = params.get("start", 0) * params.get("limit", 25)` —— 注意此处默认 `limit=25`（不是 schema 默认值 5）
      - `end_index = start_index + params.get("limit", 25)`
      - 仅查询 `asset_ids[start_index:end_index]` 切片范围内的资产指纹（资产 ID 分页，非指纹分页）
   3. **资产 ID 非空校验**：若 `asset_ids` 为空列表，抛 `V1OpenAPIError(ERROR.V1_UNKNOWN, message=Message.Check.NoAssetId.message())`（HTTP 400，code=1103，文案 "请求参数中无资产ID"）
   4. **`finger_tabs` 处理**：
      - 若 `finger_tabs` 含 `"all"` 或为空列表 `[]`：`finger_tabs = constants.FINGERPRINT_TAB_DATABASE.keys()` —— 查询全部 16 类指纹
      - 否则按传入的 `finger_tabs` 查询指定类型指纹
   5. **逐类查询指纹数据**（遍历 `finger_tabs`）：
      - 取 `finger_database = constants.FINGERPRINT_TAB_DATABASE.get(finger_tab)` —— 获取该类型的 DAO 类与投影配置
      - 构造 `db_filters = get_db_filters(finger_tab)`：
        - `software`：`{classify1_id: {$ne: DATABASE_CLASSIFY1_ID}, classify_id: {$ne: WEB_SERVER_CLASSIFY_ID}}`（排除数据库和 Web 服务）
        - `database`：`{classify1_id: DATABASE_CLASSIFY1_ID}`（仅数据库）
        - `webService`：`{classify_id: WEB_SERVER_CLASSIFY_ID}`（仅 Web 服务）
        - 其他 13 类：`{}` 无额外过滤
      - 注入 `db_filters["asset_id"] = {"$in": asset_ids[start_index:end_index]}` —— 按分页后的资产 ID 列表过滤
      - 调用 `get_fingerprints_by_asset_id(finger_db=finger_database["db"], db_filters=db_filters, db_projection=finger_database["projection"])`：
        - 若 `db_projection` 非空：`finger_db.find(filters=db_filters, projection=db_projection)`
        - 若 `db_projection` 为空：`finger_db.find(filters=db_filters)`
      - 结果存入 `fingerprint_data[finger_tab] = data`
   6. **指纹数据加工 `deal_fingerprints_data(fingerprint_data, init_filters)`**（源码 `fingerprints/business.py:435`）：
      - 按 `finger_tab` 分支调用对应的 `transform_*_output` 转换函数（共 16 类转换逻辑）：
        - `portsOpend` → `transform_ports_output`：含进程关联查询（`get_all_processes`），输出端口+协议+暴露+IP+进程名+进程命令+进程用户
        - `software` → `transform_softwares_output`：输出名称+版本+厂商+安装时间+安装路径+负责人+配置路径+进程数
        - `database` → `transform_databases_output`：含端口关联查询（`get_all_ports`），输出数据库名+版本+负责人+配置路径+日志路径+端口+协议+IP
        - `webService` → `transform_web_servers_output`：输出名称+版本+启动用户+执行路径+配置路径
        - `webFrame` → `transform_web_frames_output`：输出名称+版本+语言+类型+路径
        - `webApp` → `transform_web_apps_output`：输出名称+版本+类型+域名+根文档路径+虚拟路径+插件数
        - `webSite` → `transform_web_sites_output`：输出域名+协议+端口+IP+负责人+cmd+备案（固定空字符串）
        - `account` → `transform_accounts_output`：输出名称+状态+类型+UID/GID+管理员/Root/Sudo权限标志+shell+密码更新/过期时间+更新时间
        - `process` → `transform_processes_output`：含父进程关联查询（`get_all_processes`），输出名称+版本+分类ID+PID+状态+负责人+CPU/内存+命令行+启动时间+描述+路径+父进程ID+父进程名+MD5
        - `service` → `transform_services_output`：输出名称+状态+负责人+启动类型+执行路径+启动时间+描述
        - `connection` → `transform_connections_output`：输出本端地址+本端端口+远端地址+远端端口+进程（拼接为 `name (pid: pid)`）+协议
        - `bootItem` → `transform_boot_items_output`：输出名称+发布者+负责人+状态+注册表键
        - `registry` → `transform_registrys_output`：输出键+值名+值类型+值数据（对 `values` 数组展开）
        - `scheduledTask` → `transform_scheduled_tasks_output`：输出名称+命令+负责人+状态+执行时间描述+创建时间
        - `share` → `transform_shares_output`：输出名称+状态+路径+描述
      - 加工时按资产 ID 维度聚合：`{asset_id: {assetId, fingerPrints: [{fingerTab, fingerTabName, data, total}]}}`
      - `fingerTabName` 通过 `Constant.FingerPrint.translate(finger_tab)` 翻译为对应语言文案
   7. **返回**：`list(res.values())` —— 返回资产指纹聚合列表，每个元素为 `{assetId, fingerPrints: [...]}` 结构
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 省略。

### 数据转换逻辑

- **`assetIds` → `ids`**：`transform_params` 完成驼峰转下划线
- **`page` → `start`**：`page - 1`（0 基分页），用于资产 ID 切片
- **`pageSize` → `limit`**：用于资产 ID 切片长度
- **`fingerTabs` → `finger_tabs`**：驼峰转下划线
- **资产 ID 分页**：`asset_ids[start*limit : start*limit + limit]` —— 在 16 个 DAO 查询前先对资产 ID 列表切片，避免一次性查询过多资产
- **`finger_tab` → DAO 选择**：通过 `FINGERPRINT_TAB_DATABASE[finger_tab]["db"]` 选择对应 DAO（共 16 个 DAO，其中 `software`/`database`/`webService` 共用 `AssetSoftwareDao`，通过 `db_filters` 区分）
- **`finger_tab` → 投影配置**：通过 `FINGERPRINT_TAB_DATABASE[finger_tab]["projection"]` 选择对应字段投影，减少响应体大小
- **`finger_tab` → 类型过滤**：`get_db_filters(finger_tab)` 为 `software`/`database`/`webService` 三个共用 `A_Software` 集合的类型补充 `classify1_id`/`classify_id` 过滤条件
- **进程-端口关联**：`transform_ports_output` 和 `transform_processes_output` 会调用 `get_all_processes(db_filters)` 二次查询 `AssetProcessDao`，按 PID 关联进程命令行和用户；`transform_databases_output` 会调用 `get_all_ports(db_filters)` 二次查询 `AssetPortDao`，按 PID 关联数据库端口/协议/IP
- **`fingerTabName` 国际化翻译**：`Constant.FingerPrint.translate(finger_tab)` 通过 `_constant_dict` 映射到 `Field.FingerPrint.*` 国际化字段
- **`exposure` 翻译**：`transform_port_exposure`（源码 `view/asset_detail/business.py:158`）将端口暴露状态值翻译为 `'no'`/其他文案
- **`hasAdminPermission`/`hasRootPermission`/`hasSudoPermission`**：通过 `Constant.IsYes.translate(authority_level == 2/1/5)` 将账号权限等级转布尔文案（如"是"/"否"）
- **`uid`/`gid` 处理**：`uid == "0"` 时置空，`gid == 0` 时置空（避免显示 0 误导）
- **`ip` 字段分隔符转换**：`webSite`/`port` 的 `ips` 字段经 `Symbol.IdeographicComma.field().join(...split(","))` 将英文逗号转为中文逗号（全角）
- **不进行响应字段驼峰转换**：本接口未调用 `transform_output`，响应字段名（`assetId`/`fingerPrints`/`fingerTab`/`fingerTabName`/`data`/`total`）已在 `transform_*_output` 函数中手工构造为驼峰形式

### 默认行为

- 不传 `fingerTabs` → 等价于查询全部 16 类指纹（`finger_tabs == []` 触发 `finger_tabs = FINGERPRINT_TAB_DATABASE.keys()`）
- 不传 `page` → `params.get("start", 0)` 默认 0，从第 0 个资产 ID 开始切片
- 不传 `pageSize` → `params.get("limit", 25)` 默认 25，每页 25 个资产（**注意此默认值与 schema 中 pageSize 的 maximum=100 不冲突，但与 schema 默认值描述不一致**）
- 资产 ID 分页切片前不下标越界保护：若 `start*limit` 超过 `asset_ids` 长度，切片返回空列表，最终响应 `data` 为空数组
- 共用 `A_Software` 集合的 `software`/`database`/`webService` 通过 `db_filters` 互斥过滤，不会返回交叉数据

### 特殊规则

- **`assetIds` 必填且不能为空**：schema 校验 `required=["assetIds"]` 保证非空；业务层二次校验 `if not asset_ids` 抛 `V1_UNKNOWN`（code=1103，文案"请求参数中无资产ID"）
- **`assetIds` 上限 100**：schema `maxItems=100` 限制单次最多查询 100 个资产
- **`fingerTabs` 上限 16**：schema `maxItems=16` 限制单次最多指定 16 类指纹（与 `FINGERPRINT_TAB_DATABASE` 的 16 个 key 一致）
- **资产 ID 分页是切片而非指纹分页**：`page`/`pageSize` 控制的是 `assetIds` 列表的切片范围，不是单个资产内指纹的分页
- **`"all"` 与具体类型互斥**：`fingerTabs` 含 `"all"` 时忽略其他具体类型，查询全部 16 类
- **`AssetSoftwareDao` 复用**：`software`/`database`/`webService` 三类指纹共用 `A_Software` 集合，通过 `classify1_id`/`classify_id` 过滤区分
- **进程/端口/数据库二次关联查询**：`transform_ports_output`/`transform_processes_output`/`transform_databases_output` 会触发额外的 `get_all_processes`/`get_all_ports` 查询，存在 N+1 风险（已在一次查询中聚合所有进程/端口，避免真正的 N+1）
- **`@trans_ctx_pid_query(PlatformMode.NOTALL)`**：查询范围为本平台 + 已授权下级平台，比 SELF 模式范围更大
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **响应数据按资产 ID 聚合**：每个资产 ID 对应一个 `{assetId, fingerPrints: [...]}` 对象，`fingerPrints` 数组按查询的 `finger_tab` 顺序排列

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |
| Authorization | string | 是 | 登录鉴权 Token（由网关层 `@auth_expr` 校验） |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetIds | array | 是 | 无 | 元素为 integer，`minimum=1`，`maxItems=100`，系统中已存在的资产 ID 列表 | [100001, 100002] |
| fingerTabs | array | 否 | []（查全部） | 元素为 string，`maxItems=16`，元素枚举为 `FINGERPRINT_TAB_LIST`；空数组或含 `"all"` 时查全部 16 类 | ["portsOpend", "process"] |
| page | integer | 否 | 无 | 资产 ID 分页页码（1 基），`minimum=1`；用于对 `assetIds` 列表切片 | 1 |
| pageSize | integer | 否 | 25（业务默认） | 资产 ID 分页每页条数，`minimum=1`，`maximum=100` | 25 |

#### AKSK 多租户兼容参数（来自 `AKSK_SAAS_EXCLUDE_PARAMS`/`AKSK_SAAS_EXCLUDE_BRANCH_ID`/`IS_CLOUD_AKSK_REQUEST`）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| companyId | string | 否 | 无 | 正则 `^[1-9][0-9]{7,8}$`，MSS 场景下公司 ID | "1234567890" |
| branchType | integer | 否 | 无 | 分支类型 | 1 |
| platformId | string | 否 | 无 | 正则 `^[1-9][0-9]{6,8}$`，平台 ID | "12345678" |
| branchId | integer | 否 | 无 | 分支 ID（AKSK 校验用） | 100 |
| isCloudAkSk | boolean | 否 | 无 | True 表示 MSS 通过云图调用，会触发 `exclusiveBranchId` 替代 `branchId` 的逻辑 | true |
| exclusiveBranchId | integer | 否 | 无 | MSS 云图调用场景下替代 `branchId` 的分支 ID | 100 |

#### fingerTabs 枚举值说明（16 类）

| 值 | 含义 | 对应 DAO | 集合 | 备注 |
|----|------|---------|------|------|
| all | 全部指纹 | - | - | 占位值，等价于查询全部 16 类 |
| portsOpend | 开放端口 | AssetPortDao | A_Port | 含进程关联查询 |
| software | 应用软件 | AssetSoftwareDao | A_Software | 排除数据库和 Web 服务 |
| database | 数据库 | AssetSoftwareDao | A_Software | `classify1_id=DATABASE_CLASSIFY1_ID` |
| webService | Web 服务 | AssetSoftwareDao | A_Software | `classify_id=WEB_SERVER_CLASSIFY_ID` |
| webFrame | Web 框架 | AssetWebFrameDao | A_WebFrame | - |
| webApp | Web 应用 | AssetWebAppDao | A_WebApp | - |
| webSite | Web 站点 | AssetWebSiteDao | A_WebSite | - |
| account | 账号 | AssetAccountDao | A_Account | - |
| process | 进程 | AssetProcessDao | A_Process | 含父进程关联查询 |
| service | 运行服务 | AssetServiceDao | A_Service | - |
| connection | 网络连接 | AssetConnectionDao | A_Connection | 进程字段拼接为 `name (pid: pid)` |
| bootItem | 启动项 | AssetBootItemDao | A_BootItem | - |
| registry | 注册表 | AssetRegeditDao | A_Regedit | `values` 数组展开 |
| scheduledTask | 计划任务 | AssetCrontabDao | A_Crontab | - |
| share | 开放共享 | AssetShareDao | A_Share | - |

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"` |
| message | string | 国际化文案 key，本接口成功时省略该字段 |
| data | array | 资产指纹聚合列表，元素结构见下；查询资产无指纹数据时为空数组 `[]` |

### data 数组元素结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| assetId | integer | 资产 ID（来自 `asset_id` 字段） | 系统中已存在的资产 ID | 100001 |
| fingerPrints | array | 该资产的指纹分类列表，元素结构见下 | 按 `fingerTabs` 查询的类型聚合 | [...] |

#### fingerPrints 数组元素结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| fingerTab | string | 指纹类型标识（与 `fingerTabs` 入参一致） | `FINGERPRINT_TAB_LIST` 中除 `all` 外的 16 个值 | "portsOpend" |
| fingerTabName | string | 指纹类型展示名（已通过 `Constant.FingerPrint.translate` 国际化翻译） | 翻译后的文案 | "开放端口" |
| data | array | 该类指纹的具体数据列表，元素结构随 `fingerTab` 变化（见下） | 各类型自定义 | [...] |
| total | integer | 该类指纹的条数（`len(data)`） | 整数 | 5 |

#### 各 fingerTab 对应的 data 元素结构

##### portsOpend（开放端口）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| number | integer | 端口号 | 80 |
| protocol | string | 协议 | "TCP" |
| exposure | string | 暴露状态（已翻译） | "no" |
| ip | string | 关联 IP（中文逗号分隔） | "10.1.1.1，10.1.1.2" |
| pid | integer | 关联进程 PID | 1234 |
| process | string | 关联进程名 | "nginx" |
| processCmd | string | 关联进程命令行 | "/usr/sbin/nginx -g 'daemon off;'" |
| processUser | string | 关联进程用户 | "root" |

##### software（应用软件）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 软件名 | "nginx" |
| version | string | 版本 | "1.18.0" |
| vendor | string | 厂商 | "nginx.org" |
| installTime | string | 安装时间 | "2023-01-01" |
| installPath | string | 安装路径 | "/usr/sbin/nginx" |
| manager | string | 负责人 | "root" |
| confPath | string | 配置路径 | "/etc/nginx/nginx.conf" |
| procsNum | integer | 关联进程数 | 2 |

##### database（数据库）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 数据库名 | "MySQL" |
| version | string | 版本 | "8.0" |
| manager | string | 负责人 | "mysql" |
| confPath | string | 配置路径 | "/etc/my.cnf" |
| logPath | string | 日志路径 | "/var/log/mysql" |
| port | integer | 关联端口号 | 3306 |
| protocol | string | 关联协议 | "TCP" |
| ip | string | 关联 IP（中文逗号分隔） | "10.1.1.1" |

##### webService（Web 服务）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "Apache" |
| version | string | 版本 | "2.4.41" |
| bootUser | string | 启动用户 | "apache" |
| exePath | string | 执行路径 | "/usr/sbin/httpd" |
| confPath | string | 配置路径 | "/etc/httpd/conf/httpd.conf" |

##### webFrame（Web 框架）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "Spring" |
| version | string | 版本 | "5.3.0" |
| language | string | 语言 | "Java" |
| type | string | 类型 | "framework" |
| path | string | 路径 | "/opt/app/spring" |

##### webApp（Web 应用）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "myapp" |
| version | string | 版本 | "1.0.0" |
| type | string | 类型 | "java" |
| domain | string | 域名 | "myapp.example.com" |
| rootDocPath | string | 根文档路径 | "/var/www/myapp" |
| virtualPath | string | 虚拟路径 | "/myapp" |
| pluginsNum | integer | 插件数 | 3 |

##### webSite（Web 站点）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| domain | string | 域名 | "www.example.com" |
| protocol | string | 协议 | "HTTPS" |
| port | integer | 端口 | 443 |
| ip | string | IP（中文逗号分隔） | "10.1.1.1" |
| manager | string | 负责人 | "root" |
| cmd | string | 命令 | "/usr/sbin/nginx" |
| record | string | 备案（固定空字符串） | "" |

##### account（账号）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "root" |
| status | string | 状态 | "active" |
| type | integer | 类型 | 0 |
| uid | string | UID（"0" 置空） | "" |
| gid | string | GID（0 置空） | "" |
| hasAdminPermission | string | 管理员权限（是/否） | "是" |
| hasRootPermission | string | Root 权限（是/否） | "是" |
| hasSudoPermission | string | Sudo 权限（是/否） | "否" |
| shell | string | Shell | "/bin/bash" |
| passwdUpdateTime | string | 密码更新时间 | "2023-01-01" |
| passwdExpireTime | string | 密码过期时间 | "2024-01-01" |
| updateTime | string | 更新时间 | "2023-01-01" |

##### process（进程）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "nginx" |
| version | string | 版本 | "1.18.0" |
| classifyId | integer | 分类 ID | 1 |
| pid | integer | PID | 1234 |
| status | string | 状态 | "running" |
| manger | string | 负责人（注意拼写为 `manger`） | "root" |
| cpu | string | CPU 占用 | "1.5%" |
| memory | string | 内存占用 | "20MB" |
| cmd | string | 命令行 | "/usr/sbin/nginx" |
| startTime | string | 启动时间 | "2023-01-01" |
| description | string | 描述 | "nginx web server" |
| path | string | 路径 | "/usr/sbin/nginx" |
| parentId | string | 父进程 PID | "1" |
| parent | string | 父进程名 | "systemd" |
| md5 | string | MD5 | "d41d8cd98f00b204e9800998ecf8427e" |

##### service（运行服务）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "sshd" |
| status | string | 状态 | "active" |
| manager | string | 负责人 | "root" |
| bootType | string | 启动类型 | "systemd" |
| execPath | string | 执行路径 | "/usr/sbin/sshd" |
| bootTime | string | 启动时间 | "2023-01-01" |
| description | string | 描述 | "OpenSSH server" |

##### connection（网络连接）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| localAddr | string | 本端地址 | "10.1.1.1" |
| localPort | integer | 本端端口 | 80 |
| remoteAddr | string | 远端地址 | "10.2.2.2" |
| remotePort | integer | 远端端口 | 54321 |
| process | string | 进程（拼接 `name (pid: pid)`） | "nginx (pid: 1234)" |
| protocol | string | 协议 | "TCP" |

##### bootItem（启动项）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "sshd" |
| publisher | string | 发布者 | "system" |
| manager | string | 负责人 | "root" |
| status | string | 状态 | "enabled" |
| registryKey | string | 注册表键 | "HKLM\SYSTEM\CurrentControlSet\Services\sshd" |

##### registry（注册表）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| key | string | 键 | "HKEY_LOCAL_MACHINE\SOFTWARE\test" |
| name | string | 值名（缺失时翻译为默认名） | "DefaultName" |
| type | string | 值类型（缺失时默认 `REG_SZ`） | "REG_SZ" |
| data | string | 值数据（缺失时翻译为默认数据） | "DefaultData" |

##### scheduledTask（计划任务）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "backup" |
| cmd | string | 命令 | "/opt/backup.sh" |
| manager | string | 负责人 | "root" |
| status | string | 状态 | "ready" |
| execTime | string | 执行时间描述 | "每日 02:00" |
| createTime | string | 创建时间 | "2023-01-01" |

##### share（开放共享）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 名称 | "C$" |
| status | string | 状态 | "ok" |
| path | string | 路径 | "C:\" |
| description | string | 描述 | "Default share" |

### 响应示例

```json
{
  "code": "Success",
  "data": [
    {
      "assetId": 100001,
      "fingerPrints": [
        {
          "fingerTab": "portsOpend",
          "fingerTabName": "开放端口",
          "data": [
            {
              "number": 80,
              "protocol": "TCP",
              "exposure": "no",
              "ip": "10.1.1.1",
              "pid": 1234,
              "process": "nginx",
              "processCmd": "/usr/sbin/nginx -g 'daemon off;'",
              "processUser": "root"
            },
            {
              "number": 443,
              "protocol": "TCP",
              "exposure": "no",
              "ip": "10.1.1.1",
              "pid": 1234,
              "process": "nginx",
              "processCmd": "/usr/sbin/nginx -g 'daemon off;'",
              "processUser": "root"
            }
          ],
          "total": 2
        },
        {
          "fingerTab": "account",
          "fingerTabName": "账号",
          "data": [
            {
              "name": "root",
              "status": "active",
              "type": 0,
              "uid": "",
              "gid": "",
              "hasAdminPermission": "是",
              "hasRootPermission": "是",
              "hasSudoPermission": "否",
              "shell": "/bin/bash",
              "passwdUpdateTime": "2023-01-01",
              "passwdExpireTime": "",
              "updateTime": "2023-01-01"
            }
          ],
          "total": 1
        }
      ]
    },
    {
      "assetId": 100002,
      "fingerPrints": [
        {
          "fingerTab": "portsOpend",
          "fingerTabName": "开放端口",
          "data": [],
          "total": 0
        }
      ]
    }
  ]
}
```

## 调用示例

### 示例1：查询资产的开放端口和进程（指定类型）

**请求示例**：
```json
{
  "assetIds": [100001, 100002],
  "fingerTabs": ["portsOpend", "process"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "assetId": 100001,
      "fingerPrints": [
        {
          "fingerTab": "portsOpend",
          "fingerTabName": "开放端口",
          "data": [
            {
              "number": 80,
              "protocol": "TCP",
              "exposure": "no",
              "ip": "10.1.1.1",
              "pid": 1234,
              "process": "nginx",
              "processCmd": "/usr/sbin/nginx",
              "processUser": "root"
            }
          ],
          "total": 1
        },
        {
          "fingerTab": "process",
          "fingerTabName": "进程",
          "data": [
            {
              "name": "nginx",
              "version": "1.18.0",
              "classifyId": 1,
              "pid": 1234,
              "status": "running",
              "manger": "root",
              "cpu": "1.5%",
              "memory": "20MB",
              "cmd": "/usr/sbin/nginx",
              "startTime": "2023-01-01",
              "description": "nginx web server",
              "path": "/usr/sbin/nginx",
              "parentId": "1",
              "parent": "systemd",
              "md5": "d41d8cd98f00b204e9800998ecf8427e"
            }
          ],
          "total": 1
        }
      ]
    }
  ]
}
```

### 示例2：查询资产全部指纹（fingerTabs=["all"]）

**请求示例**：
```json
{
  "assetIds": [100001],
  "fingerTabs": ["all"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "assetId": 100001,
      "fingerPrints": [
        {"fingerTab": "portsOpend", "fingerTabName": "开放端口", "data": [...], "total": 2},
        {"fingerTab": "software", "fingerTabName": "应用软件", "data": [...], "total": 5},
        {"fingerTab": "database", "fingerTabName": "数据库", "data": [], "total": 0},
        {"fingerTab": "webService", "fingerTabName": "Web 服务", "data": [], "total": 0},
        {"fingerTab": "webFrame", "fingerTabName": "Web 框架", "data": [], "total": 0},
        {"fingerTab": "webApp", "fingerTabName": "Web 应用", "data": [], "total": 0},
        {"fingerTab": "webSite", "fingerTabName": "Web 站点", "data": [], "total": 0},
        {"fingerTab": "account", "fingerTabName": "账号", "data": [...], "total": 3},
        {"fingerTab": "process", "fingerTabName": "进程", "data": [...], "total": 12},
        {"fingerTab": "service", "fingerTabName": "运行服务", "data": [...], "total": 8},
        {"fingerTab": "connection", "fingerTabName": "网络连接", "data": [...], "total": 6},
        {"fingerTab": "bootItem", "fingerTabName": "启动项", "data": [], "total": 0},
        {"fingerTab": "registry", "fingerTabName": "注册表", "data": [], "total": 0},
        {"fingerTab": "scheduledTask", "fingerTabName": "计划任务", "data": [...], "total": 2},
        {"fingerTab": "share", "fingerTabName": "开放共享", "data": [], "total": 0}
      ]
    }
  ]
}
```

### 示例3：分页查询大量资产指纹（page + pageSize）

**请求示例**：
```json
{
  "assetIds": [100001, 100002, 100003, 100004, 100005],
  "fingerTabs": ["portsOpend"],
  "page": 1,
  "pageSize": 2
}
```

**响应示例**（仅返回前 2 个资产 `100001`/`100002` 的指纹）：
```json
{
  "code": "Success",
  "data": [
    {
      "assetId": 100001,
      "fingerPrints": [
        {"fingerTab": "portsOpend", "fingerTabName": "开放端口", "data": [...], "total": 2}
      ]
    },
    {
      "assetId": 100002,
      "fingerPrints": [
        {"fingerTab": "portsOpend", "fingerTabName": "开放端口", "data": [...], "total": 1}
      ]
    }
  ]
}
```

### 示例4：错误示例——缺少必填字段

**请求示例**（缺少 `assetIds`）：
```json
{
  "fingerTabs": ["portsOpend"]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'assetIds: required'>",
  "data": null
}
```

### 示例5：错误示例——assetIds 为空数组

**请求示例**（`assetIds=[]`）：
```json
{
  "assetIds": [],
  "fingerTabs": ["portsOpend"]
}
```

**错误响应示例**（HTTP 400，业务层校验失败）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "请求参数中无资产ID",
  "data": null
}
```

### 示例6：错误示例——fingerTabs 含非法枚举

**请求示例**（`fingerTabs=["unknown"]`）：
```json
{
  "assetIds": [100001],
  "fingerTabs": ["unknown"]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'fingerTabs: not in enum'>",
  "data": null
}
```

### 示例7：错误示例——assetIds 超过 100 个

**请求示例**（`assetIds` 含 101 个元素）：
```json
{
  "assetIds": [1, 2, 3, "...", 101],
  "fingerTabs": ["portsOpend"]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'assetIds: maxItems 100 exceeded'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `assetIds` 必填，整数数组，`maxItems=100`，元素 `minimum=1`，必须为系统中已存在的资产 ID
- `fingerTabs` 可选，字符串数组，`maxItems=16`，元素枚举为 `FINGERPRINT_TAB_LIST`（16 个值 + `"all"`）
- `page`/`pageSize` 可选，整数，`minimum=1`，`pageSize` `maximum=100`
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段
- 业务层 `assetIds` 为空数组时抛 `V1_UNKNOWN`（code=1103，文案"请求参数中无资产ID"）

### 参数依赖关系

- `assetIds` 决定查询的资产范围，必须为系统中已存在的资产 ID
- `fingerTabs` 决定查询的指纹类型，空数组或含 `"all"` 时查询全部 16 类
- `page`/`pageSize` 决定 `assetIds` 的切片范围，与 `fingerTabs` 无关
- 共用 `A_Software` 集合的 `software`/`database`/`webService` 三类指纹通过 `classify1_id`/`classify_id` 过滤互斥

### 权限要求

- `@auth_expr(expression="")` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- `@trans_ctx_pid_query(PlatformMode.NOTALL)` 限制查询为本平台 + 已授权下级平台数据，比 SELF 模式范围更大；调用方传入的 `assetIds` 应在自身可见平台范围内

### 性能建议

- **`assetIds` 上限 100，建议每次不超过 50**：16 个 DAO 串行查询，资产数过多会导致响应时间显著增长
- **按需指定 `fingerTabs`**：若只需查询某类指纹（如仅查端口），传入 `fingerTabs=["portsOpend"]` 可显著减少响应时间和响应体大小
- **`process`/`portsOpend`/`database` 三类指纹会触发二次关联查询**：`get_all_processes`/`get_all_ports` 在一次查询中聚合所有进程/端口，已是优化后的 N+1 规避方案，但仍比无关联查询慢
- **`page`/`pageSize` 分页是资产 ID 切片**：建议 `pageSize` 不超过 25，避免单次查询过多资产导致 16 个 DAO 串行查询超时
- **`fingerTabs=["all"]` 慎用**：会查询全部 16 类指纹，响应体可能很大，建议在确有需求时使用

### 数据一致性说明

- **响应字段已手工构造为驼峰**：本接口未调用 `transform_output`，所有字段名（如 `assetId`/`fingerTab`/`fingerTabName`/`bootUser`/`rootDocPath`/`passwdUpdateTime`）在 `transform_*_output` 函数中手工构造为驼峰形式
- **`process.manger` 字段拼写**：注意进程类型 `data` 中负责人字段拼写为 `manger`（非 `manager`），与其他类型（如 `software.manager`/`database.manager`）不同，调用方应按 `manger` 读取进程负责人
- **`webSite.record` 固定为空字符串**：备案字段在业务层硬编码为 `""`，当前版本不返回真实备案信息
- **`account.uid`/`gid` 的 0 值置空**：`uid == "0"` 和 `gid == 0` 会被置为空字符串，调用方应按空字符串处理
- **`registry` 类型展开 `values` 数组**：一个注册表键的多个 `values` 会被展开为多个元素，每个元素含相同 `key` 但不同 `name`/`type`/`data`
- **资产 ID 分页可能返回空 `data`**：若 `page*pageSize` 超过 `assetIds` 长度，切片为空，响应 `data` 为空数组（不报错）
- **`fingerTabName` 已国际化**：调用方收到的 `fingerTabName` 已按当前语言环境翻译，可直接用于前端展示

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `assetIds: required` | 缺少必填字段 `assetIds` | 在请求体中添加 `assetIds` 数组 |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `assetIds: maxItems 100 exceeded` | `assetIds` 超过 100 个元素 | 分批调用，每批不超过 100 个资产 ID |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `fingerTabs: not in enum` | `fingerTabs` 含非 `FINGERPRINT_TAB_LIST` 的值 | 检查 `fingerTabs` 取值，仅允许 16 个枚举值 + `"all"` |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `pageSize: maximum 100 exceeded` | `pageSize` 超过 100 | 调整 `pageSize` 至 1-100 |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `<additional properties not allowed>` | 请求体含 schema 未声明的字段 | 仅允许 schema 中声明的字段（含 AKSK 兼容字段） |
| V1_UNKNOWN (HTTP 400, code=1103) | `请求参数中无资产ID` | `assetIds` 为空数组（业务层校验） | 传入至少一个有效的 `assetIds` 元素 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<系统错误信息>` | 业务层抛出未知异常（如 DAO 查询失败被中间件捕获） | 联系运维检查 MongoDB 连接与子表集合状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<message.open_api.system_busy>` | MongoDB 查询超时、连接异常等系统级错误 | 重试或联系运维检查 MongoDB 服务可用性 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 Token |

## 最佳实践

1. **按需指定 `fingerTabs`**：仅查询需要的指纹类型，避免 `["all"]` 导致的响应体过大和 16 个 DAO 串行查询超时
2. **`assetIds` 单批不超过 50**：上限 100，但建议 50 以内以保证响应时间，超大批量应分多次调用
3. **`page`/`pageSize` 分页查询大批量资产**：超过 100 个资产时通过 `page`/`pageSize` 分页切片 `assetIds`，避免超限
4. **配合 `assets/list` 获取 `assetIds`**：先调用 `POST /api/xdr/v1/assets/list` 拿到资产 ID 列表，再调用本接口获取指纹详情
5. **识别 `process.manger` 字段拼写差异**：进程类型负责人字段为 `manger`（拼写错误但已成既定事实），与其他类型的 `manager` 不同，调用方按 `manger` 读取
6. **`fingerTabName` 可直接展示**：已国际化翻译，无需调用方二次翻译
7. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时为 `"Success"`），`message` 字段成功时省略，不要依赖 `message` 字段判断成功
