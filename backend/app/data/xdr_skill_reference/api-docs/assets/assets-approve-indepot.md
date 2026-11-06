# POST /api/xdr/v1/assets/approve/indepot

## 接口概述

本接口用于对处于"待审核"状态的资产执行"审核入库"操作，将资产状态从 `WAIT_APPROVE`（待审核）变更为 `AUTO_IN_DEPOT`（自动入库），并标记入库规则为 `MANUAL_APPROVE`（人工审核入库）。通过本接口，您可以按筛选条件批量入库待审核资产，或在详情页面对单条资产执行入库。入库前会根据系统配置的"入库信息检查项"（`IN_DEPOT_INFO_CHECK`）校验资产名称、主机名、责任人等必填字段，字段缺失的资产会被跳过并在响应文案中提示成功/失败数量。数据源为 MongoDB `assets` 集合（`AssetDao`）与 `asset_configs` 集合（`AssetConfigDao`，读取入库检查配置）。

### 可操作的业务对象信息
- **筛选条件**：继承自 `BASE_FILTER` 的全部资产筛选字段（`assetIds`、`branchId`、`businessId`、`manageStatus`、`classify1Id`、`connectStatus`、`sourceDevice`、`system`、`magnitude`、`tags`、`exposure`、`analysisTags`、`ip`、`ipRanges`、`ipSegment`、`name`、`hostName`、`mac`、`username`、`authAccount`、`assetId`、`excludeIds`、`isAll`、`agentId`、各时间范围字段等）
- **入库模式**：`approveType`（`single` / `single_in_detail` / `bulk`）
- **单条入库目标**：`approveAssetId`（当 `approveType=single_in_detail` 时必填，指定详情页入库的资产 ID）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1ApproveInDepot` |
| 所属业务域 | 资产审核 / 资产审核入库 |
| 接口分类 | 数据写入（批量/单条状态变更 + 入库信息校验） |
| 前置依赖 | 资产必须处于 `manage_status == WAIT_APPROVE` 状态；入库信息检查项配置由 `AssetConfigDao` 读取（`IN_DEPOT_INFO_CHECK`）；`approveType=single_in_detail` 时必须传入 `approveAssetId` |
| 关联接口 | `GET /api/xdr/v1/assets/depot/incheckinfo`（入库信息检查项配置查询） |

## 使用场景

1. **批量入库待审核资产**：管理员在审核队列中筛选出符合要求的待审核资产（如某机构下的核心资产），调用本接口（`approveType=bulk`）批量入库
2. **详情页单条入库**：在资产详情页查看待审核资产详情后，调用本接口（`approveType=single_in_detail`，`approveAssetId=<asset_id>`）对单条资产执行入库，入库前会校验资产字段完整性
3. **列表勾选入库**：在资产列表页勾选多个待审核资产，调用本接口（`approveType=single`，配合 `assetIds`）对勾选资产入库
4. **配合入库检查项配置**：调用 `GET /api/xdr/v1/assets/depot/incheckinfo` 获取入库信息检查项配置（如"服务器类型必须填写资产名称和主机名"），调用本接口时系统会按配置校验，字段缺失的资产会被跳过
5. **入库前预审字段**：确认待审核资产字段完整后再调用本接口入库

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/approve/indepot |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色）；`@trans_ctx_pid_query(PlatformMode.NOTALL)` 限制为非全平台查询（必须指定特定平台） |

> **注**：对外路径 `/api/xdr/v1/assets/approve/indepot` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/approve/indepot`（asm.yaml 第 134-147 行，v1 assets wildcard 通配规则 `^/api/xdr/v1/assets/(.*)
` → `/apps/asset/api/v1/openapi/assets/$1`）。源码位于 v1 模块 `open_api/v1/resources/asset/approve/__init__.py:15` 与 `approve/views.py:37`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.ASSET_APPROVE_IN_DEPOT, custom_validators=ExportAssetValidators)` 校验请求体符合 JSON Schema 约束：
   - 顶层 `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段
   - `approveType` 必填，必须为枚举 `["single", "single_in_detail", "bulk"]`
   - `approveAssetId` 在 schema 中为可选，integer（minimum=1），仅在 `approveType=single_in_detail` 时使用；**注意：schema 可选不等于运行时可选，该模式不传会触发 code=235**
   - 其余字段继承自 `BASE_FILTER`，全部可选
   - `ExportAssetValidators` 自定义校验器链额外执行业务规则校验
   - 校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`，HTTP 400，错误码 1104
2. **登录鉴权 + 操作日志 + 平台上下文**：
   - `@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
   - `@f_operate_log(target=OPEN_API_MODULE, action=APPROVE_IN_DEPOT)` 记录操作审计日志
   - `@trans_ctx_pid_query(PlatformMode.NOTALL, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（NOTALL 模式：不支持查全平台，必须指定特定平台；上下文注入失败抛 `OPENAPI_FAILED_RESPONSE`，对应 `V1_INVALID_PARAMETER`，message=`Message.System.Cascade.FindRefuse`）
3. **业务函数 `business.v1_approve_in_depot(data)` 调用**（源码 `approve/business.py:27`）：
   1. **`transform_params(data)`**：将请求体 camelCase 字段名转换为 snake_case（`approveType` → `approve_type`、`approveAssetId` → `approve_asset_id`、`branchId` → `branch_id` 等）；处理 `page`/`pageSize`/`updateTimeRange`/`firstTimeRange`/`lastTimeRange`/`assetIds` 等特殊字段映射
   2. **`approve_in_depot(params)` 调用**（源码 `common/business/approve.py:202`）：
      - **基础过滤器**：`filter_ = {'manage_status': ManageStatus.WAIT_APPROVE}` —— 强制限定操作范围为待审核资产，调用方传入的 `manageStatus` 字段会被覆盖
      - **读取入库信息检查配置**：`in_depot_check_info = AssetConfigDao.read_config(AssetConfigModel.ConfigType.IN_DEPOT_INFO_CHECK)` 从 `asset_configs` 集合读取配置，配置按资产类型（`server`/`terminal`/`other`）分组，每组含 `is_open`（是否启用检查）与 `list`（检查项列表，如 `['name', 'host_name', 'users']`）；若配置不存在返回 `{}`
      - **分支 A：详情页单条入库（`approve_type == SINGLE_IN_DETAIL`））**：
        - 构造过滤器 `filter_.update({'asset_id': data['approve_asset_id']})` 限定到指定资产
        - 调用 `_get_single_asset_info(filter_)` 查询资产基本信息（`asset_id`/`branch_id`/`host_name`/`user`/`adapter_users`/`classify1_id`/`classify_id`/`name`/`ip`）
        - 若资产不存在（已被入库或忽略），抛 `FrontendError(ERROR.DEFAULT_ERROR, msg=Message.ApproveCheck.AssetStatusChange.message())` —— 文案"资产状态已发生变更，请刷新重试"
        - 调用 `_check_in_depot_info(asset, in_depot_check_info)` 校验入库必填字段：
          - 根据资产 `classify1_id` 映射到 `ASSET_CLASSIFY_EN_ID_DICT` 中的资产类型（`server`/`terminal`/`other`），不在映射表中默认为 `OTHER`
          - 取该类型的检查项配置 `classify_conf`，若 `is_open=true` 则取 `list`，否则为空列表
          - 逐项校验：`name` 在检查项中且资产无名称 → 抛 `Message.ApproveCheck.AssetName`（"已开启入库信息检查，请填写资产名称"）；`host_name` 在检查项中且资产无主机名 → 抛 `Message.ApproveCheck.HostName`（"已开启入库信息检查，请填写主机名"）；`users` 在检查项中且资产无责任人（含 `adapter_users` 中无 `name` 的）→ 抛 `Message.ApproveCheck.Owner`（"已开启入库信息检查，请选择责任人"）
          - **注**：资产类型目前插入资产后默认包含，且未知也算有效资产类型，故不校验 `classify_id` 必填
        - 调用 `_bulk_in_depot(filter_, in_depot_check_info)` 执行入库更新（见下），返回 `matched_count`
        - 若 `matched_count == 0`（资产字段不满足入库检查项），抛 `FrontendError(ERROR.DEFAULT_ERROR, msg=Message.ApproveCheck.AssetStatusChange.message())`
        - **返回 `None`**：业务层 `v1_approve_in_depot` 判断 `ret is None`，使用默认文案 `Message.Asset.Enter.Success.message(1)`（i18n key `message.asset.enter.success.1`，"1个资产入库成功"）
      - **分支 B：列表勾选/批量入库（`approve_type == SINGLE` 或 `BULK`））**：
        - 调用 `_get_approve_asset_filters(data, {'asset_id': 1}, BATCH_ASSET_LIMIT + 1)` 构造 `Query` 查询，`$project` 仅取 `asset_id`，`$limit` 为 `BATCH_ASSET_LIMIT + 1`（10001，多取 1 条用于判断是否超限）
        - **强制 search_type**：`_get_approve_asset_filters` 内部 `data['search_type'] = SearchType.WAIT_APPROVE`，调用方传入的 `searchType` 会被覆盖
        - 解析筛选条件失败：若 `Query.handled()` 返回 False，抛 `FrontendError(ERROR.SYSTEM_BUSY)`
        - 收集 `asset_ids = [asset['asset_id'] for asset in asset_filters.fetch_all()]`
        - **空结果**：若 `len(asset_ids) == 0`，抛 `FrontendError(ERROR.DEFAULT_ERROR, msg=Message.ApproveCheck.AssetStatus.message())` —— 文案"请检查资产是否存在及资产状态"
        - **超限截断**：若 `len(asset_ids) > BATCH_ASSET_LIMIT`（10000），截取前 10000 条，生成提示文案 `msg = Message.Asset.Enter.MaxEnter.message(BATCH_ASSET_LIMIT)`（i18n key `message.asset.enter.max_enter.{limit}`，"最多允许{limit}个资产同时入库"）
        - 构造过滤器 `filter_['asset_id'] = {'$in': asset_ids}` 限定到待入库资产
        - 调用 `_bulk_in_depot(filter_, in_depot_check_info)` 执行入库更新，返回 `success_num`（成功匹配数）
        - 计算 `failed_num = len(asset_ids) - success_num`
        - **构造结果文案**：
          - 若 `success_num > 0 and failed_num == 0`：`ret = 0`，`message = Message.Asset.Enter.Success.message(success_num)`（i18n key `message.asset.enter.success.{success_num}`，"{success_num}个资产入库成功"）
          - 否则：`ret = 1`，`message = Message.Asset.Enter.FieldLoss.message(success_num, failed_num)`（i18n key `message.asset.enter.field_loss.{success_num}{failed_num}`，"{success_num}个资产入库成功，{failed_num}个资产字段有缺失，请补充后再入库"）
        - 若存在 `msg`（超限提示），通过 `Symbol.Colon.field().join([msg, message])` 拼接两段文案
        - **返回**：`{"message": message, "code": ret}`
   3. **业务层文案处理**（`business.v1_approve_in_depot`）：
      - 若 `ret is None`（详情页单条入库成功）：使用默认文案 `Message.Asset.Enter.Success.message(1)`
      - 否则（批量入库）：使用 `ret["message"]`
   4. **异常转换**：业务过程中抛出的 `FrontendError` 会被捕获并转换为 `V1OpenAPIError(ERROR.V1_UNKNOWN, message=err.get_description())`（HTTP 400，错误码 1103）
4. **响应外壳**：`v1_open_api_output(message=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认成功值（`"Success"`），`message` 为入库结果文案，`data` 省略（空）。

### `_bulk_in_depot` 入库更新逻辑（源码 `common/business/approve.py:131`）

1. **构造入库检查项过滤条件**：
   - 遍历 `AssetClassifyEn.ALL_ITEM`（`server`/`terminal`/`other`），对每个类型：
     - 若 `in_depot_check_info.get(classify, {}).get('is_open')` 为真，调用 `get_filter(exist_item)` 构造属性存在过滤条件（`device.name`/`device.hostname` 非空，`user.0` 存在或 `adapter_users` 含有效 `name`）
     - 否则只按 `classify1_id` 过滤
   - 若任何类型启用了检查项（`exist_check_info=true`），将 `filter_['$or'] = filter_or` 加入过滤器，确保只更新满足检查项的资产
2. **执行批量更新**：`AssetDao.coll.update_many(filter_, {'$set': {'approve_time': cur_time, 'update_time': cur_time, 'manage_status': ManageStatus.AUTO_IN_DEPOT, 'in_depot_rule_id': InDepotRuleId.MANUAL_APPROVE}, "$currentDate": {"push_time": True}})`
   - `manage_status` 从 `WAIT_APPROVE`（4）变更为 `AUTO_IN_DEPOT`（0）
   - `in_depot_rule_id` 设为 `MANUAL_APPROVE`（0，人工审核入库）
   - `approve_time` 与 `update_time` 设为当前秒级时间戳
   - `push_time` 通过 `$currentDate` 自动更新
3. **返回**：`.matched_count`（实际匹配并更新的资产数）

### 数据转换逻辑

- **字段名转换**：API 入参用驼峰（`approveType`、`approveAssetId`、`branchId`、`classify1Id` 等），MongoDB 查询用下划线（`approve_type`、`approve_asset_id`、`branch_id`、`classify1_id` 等），转换在 `transform_params` 中完成
- **特殊字段映射**：
  - `page` → `start`（`page - 1`）
  - `pageSize` → `limit`
  - `assetIds` → `ids`
  - `updateTimeRange`/`updateStartTimestamp`/`updateEndTimestamp` → `update_time` 时间范围对象
  - `firstTimeRange`/`lastTimeRange` → 对应时间范围对象
- **`classify1_id` → 资产类型映射**：`ASSET_CLASSIFY_EN_ID_DICT` 将 `Classify1Id.SERVER` 映射为 `AssetClassifyEn.SERVER`，`Classify1Id.TERMINAL` 映射为 `AssetClassifyEn.TERMINAL`，其他值默认为 `AssetClassifyEn.OTHER`
- **响应文案参数化**：`Message.Asset.Enter.Success.message(success_num)` 接收成功数量参数，生成带数量的国际化文案

### 默认行为

- `manage_status` 强制为 `ManageStatus.WAIT_APPROVE`，调用方传入的 `manageStatus` 字段会被覆盖
- `search_type` 强制为 `SearchType.WAIT_APPROVE`，调用方传入的 `searchType` 字段会被覆盖
- 详情页单条入库（`approve_type=single_in_detail`）成功后返回默认文案 `Message.Asset.Enter.Success.message(1)`
- 批量入库单次最多 10000 条资产（`BATCH_ASSET_LIMIT = 10000`），超限自动截断到前 10000 条并附带提示文案
- 入库检查项未启用（`is_open=false`）时，对应资产类型不做必填校验，所有匹配资产均会入库
- 响应 `data` 为空，`message` 包含入库结果文案

### 特殊规则

- **仅支持入库待审核资产**：`manage_status` 被强制设为 `WAIT_APPROVE`，其他状态的资产（在库/退库）即使匹配筛选条件也不会被入库
- **`approveType` 三种模式**：
  - `single`：列表页单条/勾选入库，走批量逻辑（分支 B），与 `bulk` 行为一致
  - `single_in_detail`：详情页单条入库，走单条逻辑（分支 A），必须传入 `approveAssetId`，会执行严格的字段校验
  - `bulk`：批量入库，走批量逻辑（分支 B）
- **入库信息检查项配置**：`AssetConfigDao.read_config(IN_DEPOT_INFO_CHECK)` 按资产类型（`server`/`terminal`/`other`）分组配置，`is_open=true` 时启用检查；检查项 `list` 支持 `name`/`host_name`/`users`，资产类型（`classify_id`）目前不校验（未知类型也算有效）
- **批量入库部分成功**：批量场景下字段缺失的资产会被跳过（不匹配 `$or` 条件），响应文案区分"全部成功"与"部分成功"两种情况
- **NOTALL 平台模式**：`@trans_ctx_pid_query(PlatformMode.NOTALL)` 要求必须指定特定平台 ID，不支持全平台入库；上下文注入失败返回 `OPENAPI_FAILED_RESPONSE`
- **入库规则标记**：入库后 `in_depot_rule_id` 设为 `MANUAL_APPROVE`（0），与自动入库（采集自动入库）区分
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **响应文案可能拼接多段**：超限场景下 `message` 字段格式为 `<超限提示>:<入库结果文案>`，调用方需要按 `:` 分隔符解析或仅作为展示文案
- **`code` 字段双重含义**：业务层返回 `ret`（0=全部成功，1=部分失败）作为 `code`，但 `v1_open_api_output` 默认 `code="Success"`，业务 `code` 不会覆盖响应外壳的 `code`；调用方应通过 `message` 文案判断是否部分失败

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数（接口特有）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| approveType | string | 是 | 无 | enum：`["single", "single_in_detail", "bulk"]`（入库模式，详见枚举值说明） | "bulk" |
| approveAssetId | integer | 条件必填 | 无 | minimum=1；仅在 `approveType=single_in_detail` 时使用，指定详情页入库的资产 ID；**`approveType=single_in_detail` 时不传 -> HTTP 200 + code=235 系统繁忙（非 400）** | 100001 |

> **条件必填说明**：`approveAssetId` 仅对 `approveType=single_in_detail` 必填，其他 `approveType` 取值下传该字段无效。`approveType=single_in_detail` 时不传 -> HTTP 200 + code=235 系统繁忙（**非 400**）：业务函数 `approve.py:211-216` 在该分支裸下标取 `data['approve_asset_id']`，键缺失 -> KeyError -> 被中间层处理为 `code=235`「系统繁忙」。

#### BASE_FILTER 继承参数（可选筛选条件）

> 完整字段定义见源码 `open_api/v1/resources/asset/params.py` 中的 `BASE_FILTER`。下表仅列出常用筛选字段，全部字段均为可选。

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetIds | array | 否 | 无 | 待入库资产 ID 列表，元素为 integer（minimum=1）；与筛选条件可组合使用 | [100001, 100002] |
| branchId | string/integer | 否 | 无 | anyOf：字符串 `"all"` 或 integer（minimum=-1，-1 表示全部机构） | 100 |
| businessId | integer | 否 | 无 | 业务组 ID | 1 |
| manageStatus | string | 否 | 无 | enum：`["all", "wait_approve", "in_depot", "out_depot"]`；**注意**：本接口会被强制覆盖为 `wait_approve` | "wait_approve" |
| classify1Id | array/integer/object | 否 | 无 | anyOf：array（maxItems=1000，元素为 integer 或 string）或 integer（minimum=0）或 `{op: "in"/"nin", val: array}` 对象 | 1 |
| connectStatus | array/object | 否 | 无 | 资产在线状态：`{op:"in"/"nin", val: array}` 或 array；元素为 `"all"`/`"0"`~`"6"`/`"101"`（字符串）或 0-6/101（整数） | [0, 1] |
| sourceDevice | object | 否 | 无 | 来源设备筛选 | `{"op": "in", "val": [...]}` |
| system | array/string/object | 否 | 无 | 操作系统筛选（maxLength=64） | "Linux" |
| magnitude | string/object | 否 | 无 | anyOf：字符串 enum `["all", "core", "normal"]` 或 `{op:"=", val: enum}` 对象 | "core" |
| tags | object | 否 | 无 | 标签筛选 `{op:"in"/"nin", val: array<string>}` 或 params.TAG | `{"op":"in", "val":["数据库"]}` |
| exposure | string/integer/object | 否 | 无 | 互联网暴露面 anyOf：string enum `["all", "yes", "no", "unknown"]` 或 integer 0-3 | "yes" |
| analysisTags | object | 否 | 无 | 未知资产标签筛选 | `{"op": "in", "val": [...]}` |
| isAll | boolean | 否 | 无 | 是否查询全部（忽略分页） | false |
| excludeIds | array | 否 | 无 | 排除资产 ID 列表，元素为 integer（minimum=1） | [100003] |
| ipSegment | string | 否 | 无 | minLength=0，maxLength=16，pattern=`IP_SEGMENT_REGEX` | "10.1.1" |
| ipRanges | array | 否 | 无 | maxItems=1000，元素为 string（pattern=`IP_RANGE_REG`） | ["10.1.1.0/24"] |
| ip | string/object | 否 | 无 | anyOf：string（minLength=0，maxLength=95，pattern=`SEARCH_REGEX`）或 `{op:"="/"like", val: string}` 对象 | "10.1.1.100" |
| assetId | integer/object | 否 | 无 | anyOf：integer（minimum=0）或 `{op:"=", val: integer}` 对象 | 100001 |
| hostName | string/object | 否 | 无 | anyOf：string（maxLength=95，pattern=`COMMON_SPECIAL_CHAR`）或 `{op:"="/"like"/"!=", val: string}` 对象 | "db-server-01" |
| name | string/object | 否 | 无 | 资产名称 anyOf：string 或 `{op:"="/"!="/"like", val: string}` 对象 | "核心数据库" |
| mac | string/object | 否 | 无 | MAC 地址 anyOf：string 或 `{op:"="/"!=", val: string}` 对象 | "AA:BB:CC:DD:EE:FF" |
| username | string/object | 否 | 无 | 责任人 anyOf：string 或 `{op:"="/"!="/"like", val: string}` 对象 | "张三" |
| authAccount | string/object | 否 | 无 | 认证账号 anyOf：string 或 `{op:"="/"!="/"like", val: string}` 对象 | "admin" |
| updateTimeRange | string | 否 | 无 | minLength=2，maxLength=8（如 `"7d"`）；`"custom"` 配合 `updateStartTimestamp`/`updateEndTimestamp` | "7d" |
| updateStartTimestamp | integer | 否 | 无 | minimum=0 | 1716297600 |
| updateEndTimestamp | integer | 否 | 无 | minimum=0 | 1716384000 |
| firstTimeRange | string | 否 | 无 | 同 `updateTimeRange`，针对首次发现时间 | "30d" |
| firstStartTimestamp | integer | 否 | 无 | minimum=0 | 1716297600 |
| firstEndTimestamp | integer | 否 | 无 | minimum=0 | 1716384000 |
| lastTimeRange | string | 否 | 无 | 同 `updateTimeRange`，针对最后发现时间 | "7d" |
| lastStartTimestamp | integer | 否 | 无 | minimum=0 | 1716297600 |
| lastEndTimestamp | integer | 否 | 无 | minimum=0 | 1716384000 |
| searchType | string | 否 | 无 | enum：`["all", "current", "history", "wait_approve"]`；**注意**：本接口业务层强制覆盖为 `wait_approve`，调用方传入无效 | "wait_approve" |
| agentId | string | 否 | 无 | Agent ID | "agent-001" |

#### approveType 枚举值说明

| 值 | 含义 | 业务影响 |
|----|------|----------|
| single | 列表页单条/勾选入库 | 走批量逻辑（分支 B），与 `bulk` 行为一致；筛选条件匹配的资产会被入库 |
| single_in_detail | 详情页单条入库 | 走单条逻辑（分支 A），必须传入 `approveAssetId`；会执行严格的字段校验，字段缺失直接抛错而非跳过 |
| bulk | 批量入库 | 走批量逻辑（分支 B），筛选条件匹配的资产会被入库，字段缺失的资产会被跳过 |

> 注：枚举值定义见源码 `asset_web/app/common/constants.py:318` `class ApproveType`。

#### 入库信息检查项（系统配置）

入库信息检查项由 `AssetConfigDao.read_config(IN_DEPOT_INFO_CHECK)` 读取，按资产类型分组：

| 资产类型 | 对应 `classify1_id` | 检查项（启用时） | 校验逻辑 |
|----------|---------------------|------------------|----------|
| server（服务器） | `Classify1Id.SERVER` | `name`/`host_name`/`users`（按配置） | 资产名称、主机名非空；责任人列表非空或 `adapter_users` 含有效 `name` |
| terminal（终端） | `Classify1Id.TERMINAL` | `name`/`host_name`/`users`（按配置） | 同上 |
| other（其他） | 不在上述映射中的 `classify1_id` | `name`/`host_name`/`users`（按配置） | 同上 |

> 注：检查项配置可通过 `GET /api/xdr/v1/assets/depot/incheckinfo` 接口查询；若某类型 `is_open=false`，则该类型资产不做必填校验。资产类型（`classify_id`）目前不校验（未知类型也算有效）。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（`v1_open_api_output` 默认值） |
| message | string | 国际化文案 key，入库结果文案（见下） |
| data | null | 成功时 data 字段省略/为空 |

### message 文案说明

| 场景 | message 文案 | i18n key | 含义 |
|------|--------------|----------|------|
| 详情页单条入库成功 | `message.asset.enter.success.1` | `Message.Asset.Enter.Success.message(1)` | "1个资产入库成功" |
| 批量入库全部成功 | `message.asset.enter.success.{success_num}` | `Message.Asset.Enter.Success.message(success_num)` | "{success_num}个资产入库成功" |
| 批量入库部分失败 | `message.asset.enter.field_loss.{success_num}{failed_num}` | `Message.Asset.Enter.FieldLoss.message(success_num, failed_num)` | "{success_num}个资产入库成功，{failed_num}个资产字段有缺失，请补充后再入库" |
| 批量入库超限（部分截断） | `message.asset.enter.max_enter.{limit}:message.asset.enter.success.{success_num}` | `Message.Asset.Enter.MaxEnter.message(limit)` + `Message.Asset.Enter.Success.message(success_num)` | "最多允许{limit}个资产同时入库:{success_num}个资产入库成功" |

### data 字段说明

本接口成功响应不含 `data` 字段（`v1_open_api_output(message=...)` 未传 `data` 参数，默认为 `None`）。

### 响应示例

详情页单条入库成功：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.1",
  "data": null
}
```

批量入库全部成功（500 条）：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.500",
  "data": null
}
```

批量入库部分失败（800 成功，200 字段缺失）：
```json
{
  "code": "Success",
  "message": "message.asset.enter.field_loss.800200",
  "data": null
}
```

## 调用示例

### 示例1：详情页单条入库（approveType=single_in_detail）

> **注**：本示例的 `approveType=single_in_detail` 组合必须同时传入 `approveAssetId`；下面示例已带该字段。若遗漏 `approveAssetId`，不会返回 400，而是 **HTTP 200 + code=235 系统繁忙**（业务函数裸下标取键 → KeyError → 吞成 235）。

**请求示例**：
```json
{
  "approveType": "single_in_detail",
  "approveAssetId": 100001
}
```

**响应示例**（成功入库 1 条）：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.1",
  "data": null
}
```

### 示例2：批量入库（approveType=bulk，按机构筛选）

**请求示例**：
```json
{
  "approveType": "bulk",
  "branchId": 100
}
```

**响应示例**（500 条资产全部入库成功）：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.500",
  "data": null
}
```

### 示例3：批量入库部分失败（字段缺失）

**请求示例**：
```json
{
  "approveType": "bulk",
  "branchId": 100,
  "classify1Id": 1
}
```

**响应示例**（800 成功，200 字段缺失被跳过）：
```json
{
  "code": "Success",
  "message": "message.asset.enter.field_loss.800200",
  "data": null
}
```

### 示例4：列表勾选入库（approveType=single，配合 assetIds）

**请求示例**：
```json
{
  "approveType": "single",
  "assetIds": [100001, 100002, 100003]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.3",
  "data": null
}
```

### 示例5：按 IP 段 + 标签组合批量入库

**请求示例**：
```json
{
  "approveType": "bulk",
  "ipRanges": ["10.1.1.0/24"],
  "tags": {"op": "in", "val": ["数据库"]},
  "magnitude": "core"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "message.asset.enter.success.15",
  "data": null
}
```

### 示例6：错误示例——缺少必填字段 approveType

**请求示例**（缺少 `approveType`）：
```json
{
  "branchId": 100
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'approveType: required'>",
  "data": null
}
```

### 示例7：错误示例——approveType 枚举非法

**请求示例**（`approveType` 传 `"auto"`，不在枚举内）：
```json
{
  "approveType": "auto"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'approveType: not in enum'>",
  "data": null
}
```

### 示例8：错误示例——详情页入库字段缺失（资产名称）

**请求示例**（`approveType=single_in_detail`，资产未填写名称，且服务器类型启用了名称检查项）：
```json
{
  "approveType": "single_in_detail",
  "approveAssetId": 100001
}
```

**错误响应示例**（HTTP 400，业务层校验失败，`FrontendError` 转换为 `V1_UNKNOWN`）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "message.approve_check.asset_name",
  "data": null
}
```

### 示例9：错误示例——资产状态已变更（详情页入库找不到资产）

**请求示例**（`approveAssetId` 对应资产已被入库或忽略）：
```json
{
  "approveType": "single_in_detail",
  "approveAssetId": 100001
}
```

**错误响应示例**（HTTP 400，业务层校验失败）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "message.approve_check.asset_status_change",
  "data": null
}
```

### 示例10：错误示例——批量入库无匹配资产

**请求示例**（筛选条件未匹配任何待审核资产）：
```json
{
  "approveType": "bulk",
  "branchId": 100,
  "tags": {"op": "in", "val": ["不存在标签"]}
}
```

**错误响应示例**（HTTP 400，业务层校验失败）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "message.approve_check.asset_status",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `approveType` 必填，必须为枚举 `["single", "single_in_detail", "bulk"]` 中的值
- `approveAssetId` **条件必填**：仅在 `approveType=single_in_detail` 时必须传入，integer（minimum=1）；其他模式下传入无效。`approveType=single_in_detail` 时不传 -> HTTP 200 + code=235 系统繁忙（**非 400**）
- 批量入库单次最多 `BATCH_ASSET_LIMIT = 10000` 条资产，超限自动截断到前 10000 条并附带超限提示文案
- `assetIds`/`excludeIds` 数组元素必须为 integer（minimum=1）
- `classify1Id` 数组形式 maxItems=1000，对象形式 maxItems=10
- `connectStatus` 数组形式 maxItems=1000
- `ipRanges` 数组 maxItems=1000，元素必须满足 `IP_RANGE_REG` 正则
- `tags` 数组元素 minLength=1，maxLength=256，pattern=`TAG_NAME_REGEX`
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `manageStatus` 字段被业务层强制覆盖为 `wait_approve`，调用方传入任何值均无效
- `searchType` 字段同理被强制覆盖为 `wait_approve`
- `approveType=single_in_detail` 时必须传入 `approveAssetId`（**条件必填**），且资产必须存在并处于 `WAIT_APPROVE` 状态；不传 `approveAssetId` 时返回 HTTP 200 + code=235 系统繁忙（**非 400 的 schema 校验错误**）
- `approveType=single` 或 `bulk` 时走批量逻辑，`approveAssetId` 字段无效
- `updateTimeRange="custom"` 时必须配合 `updateStartTimestamp` 与 `updateEndTimestamp`；非 custom 时这两个字段会被忽略
- `firstTimeRange`/`lastTimeRange` 与对应的时间戳字段同理
- 入库信息检查项由系统配置控制，调用方无法通过请求参数绕过；字段缺失的资产在批量模式下会被跳过，在详情页模式下会直接抛错

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403，错误信息 "The current account has no permission to use this function."）
- `@trans_ctx_pid_query(PlatformMode.NOTALL)` 限制为非全平台查询，必须指定特定平台 ID；上下文注入失败返回 `OPENAPI_FAILED_RESPONSE`（HTTP 400，错误码 1104，message=`Message.System.Cascade.FindRefuse`）

### 性能建议

- 单次入库资产数上限 10000，超限场景需多次调用本接口或缩小筛选范围
- 批量入库前建议先调用 `POST /api/xdr/v1/assets/list`（`manageStatus=wait_approve`）确认匹配范围
- 详情页入库（`single_in_detail`）会先查询资产再更新，单次调用耗时较短，适合高频单条操作
- 批量入库（`bulk`）涉及 `update_many` 一次更新多条资产，建议错峰执行大批量入库
- 字段缺失的资产在批量模式下会被跳过，建议入库前预审资产字段完整性

### 数据一致性说明

- **响应文案可能拼接多段**：超限场景下 `message` 字段格式为 `<超限提示>:<入库结果文案>`，调用方不应通过解析 `message` 提取精确数量，应仅作为展示文案
- **业务 `code` 不影响响应外壳**：业务层返回 `ret`（0=全部成功，1=部分失败）作为 `code`，但 `v1_open_api_output` 默认 `code="Success"`，业务 `code` 不会覆盖响应外壳的 `code`；调用方应通过 `message` 文案判断是否部分失败（含 `field_loss` 字样的为部分失败）
- **入库规则标记**：入库后 `in_depot_rule_id` 设为 `MANUAL_APPROVE`（0），与自动入库（采集自动入库）区分；`manage_status` 从 `WAIT_APPROVE`（4）变更为 `AUTO_IN_DEPOT`（0）
- **时间字段更新**：`approve_time` 与 `update_time` 设为当前秒级时间戳，`push_time` 通过 `$currentDate` 自动更新
- **批量入库部分成功**：字段缺失的资产不会被入库（不匹配 `$or` 条件），状态保持 `WAIT_APPROVE`，调用方需补充字段后再次调用本接口

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `<schema 校验错误信息>`（如 `approveType: required`、`approveType: not in enum`、`additionalProperties not allowed`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/必填/长度/枚举/正则约束 |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `<Message.System.Cascade.FindRefuse>` | `@trans_ctx_pid_query(PlatformMode.NOTALL)` 平台上下文注入失败（未指定特定平台 ID） | 在请求头或会话中携带有效的平台 ID，确保非全平台查询 |
| V1_UNKNOWN (HTTP 400, code=1103) | `message.approve_check.asset_name`（`Message.ApproveCheck.AssetName`） | 详情页入库时资产未填写名称，且服务器类型启用了名称检查项 | 通过 `PUT /api/xdr/v1/assets/list` 补充资产名称后重试 |
| V1_UNKNOWN (HTTP 400, code=1103) | `message.approve_check.host_name`（`Message.ApproveCheck.HostName`） | 详情页入库时资产未填写主机名，且启用了主机名检查项 | 通过 `PUT /api/xdr/v1/assets/list` 补充主机名后重试 |
| V1_UNKNOWN (HTTP 400, code=1103) | `message.approve_check.owner`（`Message.ApproveCheck.Owner`） | 详情页入库时资产未选择责任人，且启用了责任人检查项 | 通过 `PUT /api/xdr/v1/assets/list` 补充责任人后重试 |
| V1_UNKNOWN (HTTP 400, code=1103) | `message.approve_check.asset_status_change`（`Message.ApproveCheck.AssetStatusChange`） | 详情页入库时资产不存在（已被入库或忽略），或 `_bulk_in_depot` 返回 `matched_count=0` | 确认资产状态后刷新重试 |
| V1_UNKNOWN (HTTP 400, code=1103) | `message.approve_check.asset_status`（`Message.ApproveCheck.AssetStatus`） | 批量入库时筛选条件未匹配任何待审核资产（`asset_ids` 为空） | 检查筛选条件，确认有待审核资产匹配 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<FrontendError 其他描述>` | 业务层抛出其他 `FrontendError` | 按错误信息检查请求参数与资产状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<系统繁忙错误信息>` | `Query.handled()` 返回 False（筛选条件解析失败）或 MongoDB 操作异常 | 检查筛选条件合法性；联系运维检查 MongoDB 连接与服务可用性 |
| SYSTEM_BUSY (HTTP 200, code=235) | `系统繁忙` | `approveType=single_in_detail` 时未传 `approveAssetId`，业务函数裸下标取 `data['approve_asset_id']` 触发 KeyError | 在 `approveType=single_in_detail` 场景下补传 `approveAssetId`（integer，minimum=1）；注意此错误 HTTP 状态码为 **200**，须通过 `code=235` 识别 |
| UNAUTHORIZED (HTTP 403) | `The current account has no permission to use this function.` | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **详情页入库优先使用 single_in_detail**：详情页入库场景使用 `approveType=single_in_detail` + `approveAssetId`，会执行严格的字段校验，字段缺失直接报错便于定位问题；批量场景使用 `bulk` 或 `single`
2. **批量入库前预审字段**：调用本接口前先调用 `POST /api/xdr/v1/assets/list`（`manageStatus=wait_approve`）确认匹配范围与资产字段完整性，避免批量入库时大量资产因字段缺失被跳过
3. **不要依赖 searchType/manageStatus**：本接口业务层强制限定 `search_type=wait_approve`，调用方传入任何 `searchType`/`manageStatus` 都会被覆盖，应专注于其他筛选条件
4. **批量场景分批调用**：单次上限 10000 条，若待审核资产数超 10000，建议按机构/标签等条件分批调用，每批控制在 5000-10000 条以内，避免超限截断导致部分资产未入库
5. **响应 message 仅用于展示**：`message` 字段是国际化文案，可能拼接超限提示与入库结果，或含 `field_loss` 标识部分失败；调用方应仅用于界面展示，不应通过解析 `message` 提取精确数量
6. **NOTALL 平台模式约束**：调用本接口必须在请求上下文中指定特定平台 ID（通过会话/网关透传），不支持全平台入库；若需全平台入库，需按平台分别调用
7. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（`"Success"`），不要通过 `data` 字段判断（成功时 `data` 为空）；通过 `message` 中是否含 `field_loss` 判断是否部分失败
