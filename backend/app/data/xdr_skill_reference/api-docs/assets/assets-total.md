# POST /api/xdr/v1/assets/total

## 接口概述

本接口用于按条件统计 XDR 资产库中的资产总数。通过本接口，您可以获取匹配筛选条件的资产数量，用于分页列表的总数展示、批量删除/编辑前的数量确认、资产盘点等场景。与 `POST /api/xdr/v1/assets/list` 共享 `GET_ASSET_PARAMS` schema，但仅返回 `{total: int}`，不返回资产详情。

### 可统计的资产范围
- **筛选条件**：与 `POST /list` 完全一致（BASE_FILTER + AKSK_SAAS_EXCLUDE_PARAMS + IS_CLOUD_AKSK_REQUEST + 分页/排序参数）
- **统计结果**：仅返回 `total`（integer），不返回资产详情数组
- **多平台合并**：支持 `platformFilter` 多平台级联查询，`total` 为各平台数量的累加和

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1AssetsTotal` |
| 所属业务域 | 资产管理 / 资产数量统计 |
| 接口分类 | 数据查询（聚合统计，无写入） |
| 前置依赖 | 若传入 `branchId`/`branchIds`，机构 ID 应存在；若传入 `platformFilter`，需配合级联查询上下文 |
| 关联接口 | `POST /api/xdr/v1/assets/list`（同一 schema 查询详情列表）、`DELETE /api/xdr/v1/assets/list`（删除前统计）、`PUT /api/xdr/v1/assets/list`（编辑前统计） |

## 使用场景

1. **分页列表总数**：与 `POST /list` 配合，前端展示"共 N 条"分页总数
2. **删除前数量确认**：调用 `DELETE /list` 前先统计待删除数量，避免误删
3. **编辑前数量确认**：调用 `PUT /list` 批量编辑前统计匹配数量，确认未超 `BATCH_EDIT_LIMIT=1000`
4. **资产盘点统计**：按机构/业务组/分类等条件统计资产数量，用于资产盘点报表
5. **核心资产数量监控**：通过 `magnitude=core` 统计核心资产数量，用于安全运营监控
6. **多平台资产汇总**：通过 `platformFilter` 统计多个平台的资产总数

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/total |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/total` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/total`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/__init__.py:41` → `views.py:92`，业务函数 `business.get_assets_total`（`business.py:425`）。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.GET_ASSET_PARAMS, custom_validators=GetAssetValidators)` 校验请求体，与 `POST /list` 共享同一 schema（`additionalProperties=false`）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`。
3. **平台级查询上下文**：通过 `platform_filter(data)(business.get_assets_total)()` 包装业务函数。若请求体含 `platformFilter`，则对每个 `platformFilter` 元素中的 `platformId` 调用 `cascade_query_init` 初始化级联上下文，并对每个平台分别执行业务函数后合并结果（int 类型做累加 `resp += rslt`）；无 `platformFilter` 时直接以原请求体调用一次。
4. **业务函数 `business.get_assets_total(data)` 调用**（源码 `business.py:425`）：
   1. **`transform_params(data)`**：将驼峰字段名转换为下划线（与 `POST /list` 同源），解析时间范围类参数。MSS 云图调用时 `exclusiveBranchId` 覆盖 `branchId`。
   2. **构造 `Query(params)`**：基于 `asset_common.query_handlers.asset.asset_q.Query`，`PROCESS_LINKS` 中各 Handler 顺序处理筛选字段（与 `POST /list` 同源）。若 `query.handled()` 返回 False（任一 Handler 抛错），抛 `V1OpenAPIError(ERROR.V1_UNKNOWN, message=query.err_msg)`（HTTP 400，code=1103）。
   3. **执行 count 查询**：`total = list(query.count)`，`Query.count` 属性（源码 `asset_q.py:47`）特殊优化：
      - **若 pipeline 仅含 `$match` 阶段**：使用 MongoDB `db_command` 的 `count` 命令直接统计（性能优于聚合管道），并注入 `region_id` 数据权限过滤：
        - `get_ctx_data_regions() != "all"` 时，注入 `{"region_id": {"$in": get_ctx_data_regions()}}`
        - `get_ctx_data_regions() == "all"` 时，`filters["$and"]` 为空（不过滤）
        - 将 baseline 中所有 `$match` 阶段追加到 `filters["$and"]`，执行 `db_command({count: coll_name, query: filters, readConcern: {level: "available"}})`，返回 `[{"count": res.get("n", 0)}]`
      - **若 pipeline 含其他阶段**（如 `$group`/`$project`）：使用聚合管道 `$count` 阶段统计，`self.fetch(after=[{"$count": "count"}])`
   4. **解析 count 结果**：
      - `total` 为空列表 → `total = len(total) = 0`
      - `total[0]` 为 dict → `total = total[0].get("count")`
      - `total[0]` 非 dict → 抛 `V1OpenAPIError(ERROR.SYSTEM_BUSY)`（HTTP 500，code=1235）
   5. **返回**：`total`（integer）。
5. **响应外壳**：`v1_open_api_output(data={"total": total})` —— OpenAPI 外壳 `{code: "Success", data: {total: <int>}}`，`message` 字段省略。

### 数据转换逻辑

- **字段名转换**：API 入参驼峰（`branchId`、`assetIds`、`classify1Id`、`updateTimeRange`）→ MongoDB 文档下划线（`branch_id`、`ids`、`classify1_id`、`update_time`），与 `POST /list` 同源
- **DAO 层过滤转换**：与 `POST /list` 同源，通过 `PROCESS_LINKS` 中各 Handler 构造 `$match` 阶段（详见 `POST /list` 文档的"数据转换逻辑"）
- **count 优化**：当 pipeline 仅含 `$match` 时，使用 `db_command` 的 `count` 命令而非聚合管道，性能更优；并额外注入 `region_id` 数据权限过滤
- **`platformFilter` 累加合并**：`platform_filter` 对每个平台分别执行 `get_assets_total`，`int` 类型做 `resp += rslt` 累加，最终 `total` 为各平台数量之和

### 默认行为

- `page`/`pageSize` 缺省 → 不影响 count（count 不依赖分页参数，但 schema 允许传入）
- `searchType` 缺省 → 不做状态过滤，**Query 类警告：不含 `search_type` 时统计全部资产**（含历史/退库资产）
- `orderCol`/`orderType` 缺省 → 不影响 count（count 不依赖排序）
- `needCustom` 缺省 → False（不影响 count）
- `region_id` 数据权限：`get_ctx_data_regions() != "all"` 时自动注入地域过滤，限制统计范围为用户可见地域

### 特殊规则

- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **`platformFilter` 累加语义**：与 `POST /list` 的 `extend` 合并不同，`/total` 的 `platformFilter` 对各平台 `total` 做 `+=` 累加，最终结果是各平台数量的准确总和
- **count 优化触发条件**：仅当 pipeline 仅含 `$match` 阶段时触发 `db_command` 优化；若筛选条件触发了 `$group`/`$project` 等阶段，回退到聚合管道 `$count`
- **`region_id` 数据权限**：count 优化路径会注入 `region_id` 过滤；聚合管道路径不显式注入（依赖 Handler 链处理）
- **`isCloudAkSk=true`（MSS 云图调用）**：`exclusiveBranchId` 覆盖 `branchId`，并清除 `companyId`/`branchType`/`platformId`/`branch_ids` 等字段
- **`GetAssetValidators` 自定义校验器**：与 `POST /list` 同源，做 `OrderTypeValidator`、`TagsValidator`、`Classify1IdValidator`、`TimeRangeStampValidator`、`BranchIdValidator`、`BranchIdsValidator`、`IpSegmentValidator`、`SearchTypeValidator` 等业务规则校验

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| page | integer | 否 | 1 | minimum=1，页码（不影响 count） | 1 |
| pageSize | integer | 否 | 25 | minimum=1，maximum=2000（不影响 count） | 20 |
| searchType | string | 否 | 无（统计全部） | enum：`all`/`current`/`history`/`wait_approve` | "current" |
| orderCol | string | 否 | "update_time" | enum：`update_time`/`first_time`（不影响 count） | "update_time" |
| orderType | string | 否 | "DESC" | enum：`ASC`/`DESC`（不影响 count） | "DESC" |
| branchId | string\|integer | 否 | 无 | string 枚举 `"all"` 或 integer minimum=-1 | 100 |
| branchIds | array | 否 | 无 | maxItems=10000，元素为 integer minimum=-1 | [100, 101] |
| businessId | integer | 否 | 无 | minimum=-1，业务组 ID | 1 |
| businessIds | array | 否 | 无 | maxItems=10000，元素为 integer minimum=-1 | [1, 2] |
| manageStatus | string | 否 | 无 | enum：`all`/`wait_approve`/`in_depot`/`out_depot` | "in_depot" |
| classify1Id | integer\|array\|object | 否 | 无 | anyOf：integer / array / object `{op: in/nin, val: array}` | 1 |
| connectStatus | array\|object | 否 | 无 | anyOf：array 或 object `{op: in/nin, val: array}` | ["0", "1"] |
| sourceDevice | object | 否 | 无 | SOURCE_DEVICE 配置 | 无 |
| system | array\|object\|string | 否 | 无 | anyOf：object/array/string maxLength=64 | "Linux" |
| magnitude | string\|object | 否 | 无 | anyOf：string enum `all`/`core`/`normal` 或 object | "core" |
| tags | array\|object | 否 | 无 | anyOf：object `{op: in/nin, val: array}` 或 params.TAG | ["数据库"] |
| exposure | string\|integer\|object | 否 | 无 | anyOf：object/string enum/integer 0-3 | "yes" |
| analysisTags | object | 否 | 无 | ANALYSIS_TAGS 配置 | 无 |
| isAll | boolean | 否 | 无 | 是否查询全部 | false |
| excludeIds | array | 否 | 无 | 元素为 integer minimum=1 | [200] |
| assetIds | array | 否 | 无 | 元素 integer minimum=1 | [101, 102] |
| ipSegment | string | 否 | 无 | minLength=0，maxLength=16，pattern=`IP_SEGMENT_REGEX` | "10.1" |
| ipRanges | array | 否 | 无 | maxItems=1000，元素为 string pattern=`IP_RANGE_REG` | ["10.1.1.0/24"] |
| ip | string\|object | 否 | 无 | anyOf：string pattern=`SEARCH_REGEX` 或 object `{op: =/like, val: string}` | "10.1.1.100" |
| assetId | object\|integer | 否 | 无 | anyOf：object `{op: "=", val: integer}` 或 params.ASSET_ID | 101 |
| hostName | string\|object | 否 | 无 | anyOf：string 或 object `{op: =/like/!=, val: string}` | "db-server-01" |
| name | string\|object | 否 | 无 | anyOf：string 或 object `{op: =/!=/like, val: string}` | "核心数据库" |
| mac | string\|object | 否 | 无 | anyOf：string 或 object `{op: =/!=, val: string}` | "AA:BB:CC:DD:EE:FF" |
| username | string\|object | 否 | 无 | anyOf：string 或 object `{op: =/!=/like, val: string}` | "张三" |
| authAccount | string\|object | 否 | 无 | anyOf：string 或 object `{op: =/!=/like, val: string}` | "root" |
| updateTimeRange | string | 否 | 无 | minLength=2，maxLength=8 | "7d" |
| updateStartTimestamp | integer | 否 | 无 | minimum=0 | 1700000000 |
| updateEndTimestamp | integer | 否 | 无 | minimum=0 | 1700086400 |
| firstTimeRange | string | 否 | 无 | minLength=2，maxLength=8 | "30d" |
| firstStartTimestamp | integer | 否 | 无 | minimum=0 | 1700000000 |
| firstEndTimestamp | integer | 否 | 无 | minimum=0 | 1700086400 |
| lastTimeRange | string | 否 | 无 | minLength=2，maxLength=8 | "7d" |
| lastStartTimestamp | integer | 否 | 无 | minimum=0 | 1700000000 |
| lastEndTimestamp | integer | 否 | 无 | minimum=0 | 1700086400 |
| needCustom | boolean | 否 | false | 不影响 count | false |
| exclusiveBranchId | integer | 否 | 无 | minimum=-1，MSS 云图调用时覆盖 `branchId` | 100 |
| platformFilter | array | 否 | 无 | 多平台级联查询，元素为 object `{platformId, assetIds, branchIds, searchType, ...}` | [{"platformId": "10001"}] |
| companyId | string | 否 | 无 | pattern=`^[1-9][0-9]{7,8}$`，AKSK SaaS 额外字段（不处理） | "10000001" |
| branchType | integer | 否 | 无 | AKSK SaaS 额外字段（不处理） | 1 |
| platformId | string | 否 | 无 | pattern=`^[1-9][0-9]{6,8}$`，AKSK SaaS 额外字段（不处理） | "1000001" |
| isCloudAkSk | boolean | 否 | 无 | 标识 MSS 通过云图调用 | true |
| agentId | object | 否 | 无 | AGENT_ID 配置 | 无 |

#### searchType 枚举值说明

| 值 | 含义 | 统计范围 |
|----|------|---------|
| all | 全部资产 | 当前 + 历史 + 待审核 |
| current | 当前资产 | 在库资产（auto_in_depot/manual_in_depot） |
| history | 历史资产 | 已退库资产（auto_out_depot/manual_out_depot） |
| wait_approve | 待审核资产 | 审批中资产 |

#### manageStatus 枚举值说明

| 值 | 含义 |
|----|------|
| all | 全部 |
| wait_approve | 待审核 |
| in_depot | 在库 |
| out_depot | 退库 |

#### magnitude 枚举值说明

| 值 | 含义 |
|----|------|
| all | 全部 |
| core | 核心资产 |
| normal | 普通资产 |

#### platformFilter 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| platformId | string | 是 | 平台 ID | "10001" |
| assetIds | array | 否 | 元素 integer | [101] |
| branchIds | array | 否 | BRANCH_IDS（maxItems=10000, integer min=-1） | [100] |
| searchType | string | 否 | enum：all/current/history/wait_approve | "current" |
| needUncategorizedBranch | boolean | 否 | 是否包含未分组机构 | false |
| magnitude | string | 否 | MAGNITUDE_INCLUDE_ALL enum | "core" |
| needIpRange | boolean | 否 | 是否需要 IP 段信息 | false |

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 `"Success"`（默认值） |
| message | string | 响应消息，成功时省略 |
| data | object | 统计结果，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 匹配筛选条件的资产总数；`platformFilter` 场景为各平台数量的累加和 |

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "total": 156
  }
}
```

## 调用示例

### 示例1：统计全部在库资产数量

**请求示例**：
```json
{
  "searchType": "current"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 156
  }
}
```

### 示例2：按机构统计核心资产数量

**请求示例**：
```json
{
  "branchId": 100,
  "magnitude": "core",
  "searchType": "current"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 23
  }
}
```

### 示例3：按 IP 段统计资产数量

**请求示例**：
```json
{
  "ipRanges": ["10.1.1.0/24"],
  "searchType": "current"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 45
  }
}
```

### 示例4：多平台级联统计总数

**请求示例**：
```json
{
  "platformFilter": [
    {"platformId": "10001", "branchIds": [100]},
    {"platformId": "10002", "branchIds": [200]}
  ]
}
```

**响应示例**（`total` 为各平台数量的累加和）：
```json
{
  "code": "Success",
  "data": {
    "total": 78
  }
}
```

> 注：`total` 是各平台数量的准确总和（`platform_filter` 对 int 做 `+=` 累加）。

### 示例5：错误示例——参数类型不合法

**请求示例**（`pageSize` 超过 2000）：
```json
{
  "pageSize": 5000
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'pageSize: 5000 is greater than maximum 2000'>",
  "data": null
}
```

### 示例6：错误示例——筛选条件解析失败

**请求示例**（`ip` 格式非法触发 Handler 抛 `ValueError`）：
```json
{
  "ip": "invalid_ip_format"
}
```

**错误响应示例**（HTTP 400，`query.handled()` 返回 False）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "<Handler 抛出的错误信息，如 Message.Ip.Invalid 对应的国际化文案>",
  "data": null
}
```

### 示例7：错误示例——未声明字段

**请求示例**（请求体含未声明字段 `foo`）：
```json
{
  "foo": "bar"
}
```

**错误响应示例**（HTTP 400，`additionalProperties=false`）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'Additional properties are not allowed (foo)'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- 与 `POST /list` 共享 `GET_ASSET_PARAMS` schema，所有筛选字段约束同 `POST /list`
- `page`/`pageSize`/`orderCol`/`orderType`/`needCustom` 不影响 count 结果（但 schema 允许传入）
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段
- 字符串字段（`ip`/`name`/`hostName`/`mac`/`username`/`authAccount`）maxLength=95，受正则约束
- `ipRanges` maxItems=1000，`assetIds`/`excludeIds`/`connectStatus`/`system`/`tags` 各有 maxItems 限制

### 参数依赖关系

- `searchType` 与 `manageStatus` 都影响 `manage_status` 过滤，避免重复或冲突传参
- `exclusiveBranchId` 仅在 `isCloudAkSk=true` 时覆盖 `branchId`
- `platformFilter` 与 `branchId`/`branchIds` 互斥语义：`platformFilter` 存在时业务函数被多次调用，顶层 `branchId` 不参与过滤
- `updateStartTimestamp`/`updateEndTimestamp` 仅在 `updateTimeRange=custom` 时生效（`firstTimeRange`/`lastTimeRange` 同理）

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- 数据地域权限：count 优化路径会注入 `region_id` 过滤（`get_ctx_data_regions() != "all"` 时），限制统计范围为用户可见地域
- `platform_filter` 模式下，每个 `platformId` 通过 `cascade_query_init` 初始化级联上下文，需有对应平台的查询权限

### 性能建议

- **count 优化**：当 pipeline 仅含 `$match` 阶段时使用 `db_command` 的 `count` 命令，性能优于聚合管道；建议优先使用纯 `$match` 类筛选条件（避免触发 `$group`/`$project`）
- **`platformFilter` 累加**：与 `POST /list` 的 `extend` 合并不同，`/total` 对各平台 `total` 做 `+=` 累加，结果是准确的各平台数量之和
- **避免无筛选统计**：无筛选条件时统计全部资产，大数据集可能耗时较长，建议通过 `branchId`/`searchType` 缩小范围
- **配合 `/list` 使用**：分页场景应同时调用 `/total` 获取总数与 `/list` 获取详情，避免在 `/list` 中二次统计

### 数据一致性说明

- **`total` 是准确数量**：与 `POST /list` 不同，`/total` 返回的 `total` 是匹配筛选条件的准确资产数量，不是分页后的条数
- **count 优化与聚合管道结果一致**：两种路径返回的 `total` 语义一致，仅性能不同
- **`region_id` 数据权限**：count 优化路径会注入 `region_id` 过滤，统计范围受用户地域权限限制；聚合管道路径依赖 Handler 链处理
- **`platformFilter` 累加语义**：`total` 是各平台数量的准确总和，与 `POST /list` 的 `extend` 合并（分页内独立）不同
- **与 `/list` 的 `total` 差异**：`POST /list` 不返回 `total`，调用方需要总数应使用本接口

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `pageSize: greater than maximum 2000`、`Additional properties are not allowed`、`branchId: not in enum`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<Handler 抛出的业务错误>` | `GetAssetValidators` 自定义校验器失败，或某 Handler 抛 `ValueError`（如 `Message.Ip.Invalid`） | 对照错误信息检查 IP 格式、机构 ID 存在性、时间范围合法性 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<ERROR.SYSTEM_BUSY>` | `total[0]` 非 dict（count 结果格式异常），或 MongoDB 查询失败 | 联系运维检查 MongoDB 连接与索引状态 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **明确传入 `searchType`**：`Query` 类警告"不含 search_type 会返回全部资产"，建议始终传入 `searchType=current` 仅统在库资产，避免误统计历史/退库资产
2. **与 `/list` 配合使用**：分页场景应同时调用 `/total` 获取总数与 `/list` 获取详情，避免在 `/list` 中二次统计
3. **`platformFilter` 累加语义**：与 `/list` 的 `extend` 合并不同，`/total` 的 `total` 是各平台数量的准确总和，可放心使用
4. **count 优化**：优先使用纯 `$match` 类筛选条件（如 `branchId`/`assetIds`/`searchType`），避免触发 `$group`/`$project` 回退到聚合管道
5. **删除/编辑前统计**：调用 `DELETE /list`/`PUT /list` 前先调用本接口统计数量，确认无误后再执行批量操作
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（`"Success"`），`data.total` 为统计结果
