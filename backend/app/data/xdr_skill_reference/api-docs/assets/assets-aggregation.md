# POST /api/xdr/v1/assets/aggregation

## 接口概述

本接口用于按指定时间字段、分组键、聚合函数对资产进行通用聚合统计，返回聚合后的分组结果。通过本接口，您可以获取以下内容：

### 可查询的聚合信息
- **时间维度聚合**：按 `interval`（如 `1d`）对资产按时间字段（`create_time`/`update_time`/`first_seen`/`last_seen`/`push_time`/`manual_time`）分桶，每组附加 `item` 子项
- **字段维度聚合**：按 `aggBy` 指定的资产字段（如 `device.classify1_id`、`branch_id` 等）分组
- **聚合函数支持**：`count`（计数）、`sum`（求和）等 MongoDB 聚合表达式（由 `aggFuncs.func` 指定）
- **过滤条件**：通过 `filterParam.classify1Id`（一级分类数组）、`filterParam.searchType`（资产入库状态）缩小聚合范围

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `Aggregation` |
| 所属业务域 | 资产统计 / 资产通用聚合 |
| 接口分类 | 数据查询（MongoDB 聚合管道，无写入） |
| 前置依赖 | 无（可直接调用）；若传入 `filterParam.classify1Id`，建议为有效一级分类 ID |
| 关联接口 | `POST /api/xdr/v1/assets/aggregation/branch/classify1Id`（按机构 + 一级分类聚合）、`POST /api/xdr/v1/assets/total`（资产总数） |

## 使用场景

1. **资产时间趋势分析**：按 `interval="1d"` 对 `last_seen` 字段分桶，统计每日活跃资产数量趋势
2. **资产按一级分类分布**：通过 `aggBy=["device.classify1_id"]` + `aggFuncs=[{name:"count", func:"count"}]` 统计各一级分类下资产数量
3. **资产按机构分布**：通过 `aggBy=["branch_id"]` 统计各机构下资产数量分布
4. **结合过滤条件统计**：通过 `filterParam.classify1Id=[1,2]` 与 `filterParam.searchType="current"` 限定当前入库且分类为 1/2 的资产，再做时间趋势聚合
5. **配合大屏展示**：本接口是前端大屏"资产趋势/分布"组件的后端支撑，可结合 `branch/classify1Id` 接口联合展示

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/aggregation |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/aggregation` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/aggregation`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/views.py:259`（`Aggregation` 类）。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.AGGREGATION_INFO)` 校验请求体，必填 `startTimestamp`、`endTimestamp`、`aggBy`、`aggFuncs`、`timeField`。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`。**注意**：本接口未使用 `@trans_ctx_pid_query` 装饰器，平台过滤由 `AssetDao` 层的 `platform_filter` 默认行为（`RWCTX`）隐式注入。
3. **业务函数 `business.aggregation_device_classify(req_data)` 调用**（源码 `open_api/v1/resources/asset/business.py:1167`）：
   1. **时间范围合法性校验**：若 `startTimestamp > endTimestamp`，抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER, message="startTimestamp > endTimestamp?")`。
   2. **构建 MongoDB 过滤条件 `filters`**：
      - 若 `filterParam.classify1Id` 非空，注入 `filters["device.classify1_id"] = {"$in": classify1_ids}`。
      - 解析 `filterParam.searchType` 映射到 `manage_status` 列表：
        - `SearchType.ALL`（"all"）→ `ManageStatus.ALL`（不过滤）
        - `SearchType.HISTORY`（"history"）→ `ManageStatus.OUT_DEPOT_LIST`（已退库）
        - `SearchType.WAIT_APPROVE`（"wait_approve"）→ `[ManageStatus.WAIT_APPROVE]`（待审核）
        - `SearchType.CURRENT`（"current"）→ `ManageStatus.IN_DEPOT_LIST`（已入库）
        - 默认（未传或未知）→ `ManageStatus.ALL`（不过滤）
      - 若 `manage_statuss` 非空，注入 `filters["manage_status"] = {"$in": manage_statuss}`。
      - 用构建好的 `filters` **覆盖** `req_data["filterParam"]`（注意：调用方传入的 `filterParam` 子字段除 `classify1Id`/`searchType` 外的其他字段会被丢弃）。
   3. **调用 `BaseAgg(AssetDao, req_data).aggregate()`**（源码 `business.py:1114-1164`）：
      - **`parse_match()`**：构造 `$match` 阶段：
        - 若 `timeField` 非空，注入 `matchs[timeField] = {"$gte": startTimestamp, "$lte": endTimestamp}`。
        - 合并 `req_data["filterParam"]`（即上一步构建的 `filters`）到 `matchs`。
      - **`parse_groups()`**：构造 `$group` 阶段：
        - 若 `interval` 非空，**断言 `interval == "1d"`**（其他值会触发 `AssertionError`），将 `timeField` 字段（10 位秒级时间戳）通过 `$toDate` + `$multiply` 转为日期，按 `%Y-%m-%d` 格式化（时区取 `timeZone` 或 `XDRTime.time_zone()`），分组键为 `date`。
        - 遍历 `aggBy` 列表（schema 限制 `maxItems=1`，即最多 1 个分组键），每个键 `k` 注入 `groups[k] = f"${k}"`。
        - 分组键中 `.` 统一替换为 `_`（MongoDB `$group` 的 `_id` 子键不允许点号）。
        - 构造聚合表达式 `aggs = {x["name"]: {f"${x['func']}": x.get('param') or 1}}`，其中 `func="count"` 时使用 `$sum`，其他 `func` 值直接作为 MongoDB 聚合操作符（如 `sum`/`avg`/`max`/`min`）。
        - 返回 `[{"$group": {"_id": groups, **aggs}}] + group2(...)`。
      - **`group2(k, groups, aggs)`**：若启用了 `interval`（`k="date"`），追加第二层 `$group`：以 `date` 为外层 `_id`，将其他分组键与聚合结果打包为 `item` 数组；否则返回空列表（单层聚合）。
      - **`aggregate()`**：执行 `AssetDao.coll.aggregate([parse_match(), *parse_groups()], allowDiskUse=True)`，返回游标。
   4. **结果构造**：
      - `data = {"meta": [{"name": "date", "type": "String"}, {"name": "item", "type": "Array"}], "item": [dict(d, **d.pop('_id')) for d in data]}`
      - 将 MongoDB 聚合结果的 `_id` 字段展开到顶层，`meta` 固定描述返回结构。
4. **响应外壳**：`v1_open_api_output(data=data)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 缺省（不返回 message 字段），`data` 为上述聚合结果。

### 数据转换逻辑

- **`aggBy` 分组键点号替换**：`aggBy` 中如 `"device.classify1_id"` 在 `$group._id` 中会被替换为 `device_classify1_id`（`groups = {k.replace('.', '_'): v for k, v in groups.items()}`），响应字段名也带下划线，调用方需注意映射
- **`timeField` 时间戳转换**：MongoDB 中 `create_time`/`update_time`/`first_seen`/`last_seen`/`push_time`/`manual_time` 均为 10 位秒级时间戳，`$match` 阶段直接与 `startTimestamp`/`endTimestamp`（同单位）比较；若启用 `interval`，通过 `{$multiply: [$timeField, 1000]}` 转为毫秒再 `$toDate` 转为 BSON Date 用于 `$dateToString`
- **`aggFuncs.func="count"` 特殊处理**：`count` 不在 MongoDB 聚合操作符中，代码内将其映射为 `$sum`（`f'${"sum" if x["func"] == "count" else x["func"]}'`），等价于 `$sum: 1`
- **`filterParam` 覆盖**：业务层用构建的 `filters` 覆盖 `req_data["filterParam"]`，调用方在 `filterParam` 中传入的除 `classify1Id`/`searchType` 外的字段（如自定义过滤键）会被丢弃

### 默认行为

- `timeZone` 缺省 → 使用 `XDRTime.time_zone()`（系统配置的时区）
- `interval` 缺省 → 不做时间分桶，单层 `$group`，响应 `item` 中每个元素直接含分组键 + 聚合值
- `filterParam` 缺省 → `filters` 仅含 `manage_status` 过滤（默认 `ALL` 即不过滤）
- `filterParam.classify1Id` 缺省 → 不按一级分类过滤
- `filterParam.searchType` 缺省或未知值 → 默认 `ALL`（不过滤 `manage_status`）
- 聚合管道使用 `allowDiskUse=True`，大数据集允许使用磁盘临时文件

### 特殊规则

- **`aggBy` 与 `aggFuncs` 数组长度限制为 1**：schema 中 `maxItems=1`，即单次请求只支持 1 个分组键 + 1 个聚合函数，多组需求需多次调用
- **`interval` 仅支持 `"1d"`**：代码硬断言 `assert self.data.get('interval') == '1d'`，传入 `"1m"`/`"1H"`/`"1M"` 会触发 `AssertionError`（被中间件转换为 `V1_SYSTEM_ERROR`，HTTP 500）
- **`aggBy`/`aggFuncs[].name`/`aggFuncs[].func` 字段名约束**：受 `GROUP_FULL_NAME_NULL_REGEX` 正则约束（限制特殊字符），且 `maxLength=64`
- **`timeField` 必须为枚举值**：`["create_time", "update_time", "first_seen", "last_seen", "push_time", "manual_time"]`，其他值 schema 拒绝
- **`startTimestamp` 必须 `<= endTimestamp`**：业务层二次校验，违反抛 `V1_INVALID_PARAMETER`
- **schema 未声明 `additionalProperties=false`**：请求体允许出现 schema 中未声明的字段（被忽略）
- **`timeZone` 必须为合法时区**：schema 使用 `pytz.all_timezones` 枚举，非法时区名会被拒绝
- **聚合管道直接操作 `AssetDao.coll`**：不经过 `get_count_by_aggregate` 的 `platform_filter` 包装，平台过滤依赖 MongoDB 集合层的注入机制

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | integer | 是 | 无 | minimum=1000000000，maximum=9999999999（10 位秒级时间戳）；必须 `<= endTimestamp` | 1724428800 |
| endTimestamp | integer | 是 | 无 | minimum=1000000000，maximum=9999999999（10 位秒级时间戳） | 1724515200 |
| timeField | string | 是 | 无 | enum：`create_time`/`update_time`/`first_seen`/`last_seen`/`push_time`/`manual_time`（资产时间字段，决定 `$match` 与 `interval` 分桶的字段） | "last_seen" |
| timeZone | string | 否 | 系统时区 | enum：`pytz.all_timezones`（如 "Asia/Shanghai"、"UTC"）；仅在 `interval` 启用时影响 `$dateToString` 的时区 | "Asia/Shanghai" |
| interval | string | 否 | 无 | enum：`["1m", "1H", "1d", "1M"]`；**运行时仅支持 `"1d"`**，其他值会触发 `AssertionError` | "1d" |
| aggBy | array | 是 | 无 | maxItems=1；元素为字符串，maxLength=64，pattern=`GROUP_FULL_NAME_NULL_REGEX`（资产字段名，如 `"device.classify1_id"`、`"branch_id"`） | ["device.classify1_id"] |
| aggFuncs | array | 是 | 无 | maxItems=1；元素为聚合函数对象，详见 aggFuncs 元素结构 | [{"name":"count","func":"count"}] |
| filterParam | object | 否 | 无 | 过滤参数对象，详见 filterParam 元素结构 | {"classify1Id":[1,2],"searchType":"current"} |

#### timeField 枚举值说明

| 值 | 含义 | 说明 |
|----|------|------|
| create_time | 资产创建时间 | 资产首次入库时间 |
| update_time | 资产更新时间 | 资产最近一次更新时间 |
| first_seen | 首次发现时间 | 资产首次被发现的时间 |
| last_seen | 最近发现时间 | 资产最近被发现的时间 |
| push_time | 推送时间 | 资产最近推送到下游的时间 |
| manual_time | 手动操作时间 | 资产最近一次手动操作时间 |

#### interval 枚举值说明

| 值 | 含义 | 运行时是否支持 |
|----|------|--------------|
| 1m | 每分钟 | 否（触发 AssertionError） |
| 1H | 每小时 | 否（触发 AssertionError） |
| 1d | 每天 | **是**（运行时唯一支持） |
| 1M | 每月 | 否（触发 AssertionError） |

#### aggFuncs 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | minLength=1，maxLength=64，pattern=`GROUP_FULL_NAME_NULL_REGEX`（聚合结果字段名，出现在响应 `item` 元素的键中） | "count" |
| func | string | 是 | minLength=1，maxLength=64，pattern=`GROUP_FULL_NAME_NULL_REGEX`（聚合函数名；`"count"` 会被映射为 MongoDB `$sum`，其他值如 `"sum"`/`"avg"`/`"max"`/`"min"` 直接作为 MongoDB 聚合操作符） | "count" |
| param | string | 否 | maxLength=64，pattern=`GROUP_FULL_NAME_NULL_REGEX`（聚合函数参数；`func="count"` 时被忽略，固定 `$sum: 1`；`func="sum"` 等需要时作为字段名） | "device.magnitude" |

#### filterParam 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| classify1Id | array | 否 | maxItems=10（schema 声明）；元素类型未约束（业务层用 `$in` 匹配 `device.classify1_id`）；建议传 integer 一级分类 ID 列表 | [1, 2] |
| searchType | string | 否 | 见 searchType 枚举值说明 | "current" |

#### searchType 枚举值说明

| 值 | 含义 | 对应 manage_status 过滤 |
|----|------|------------------------|
| all | 全部资产 | 不过滤 |
| current | 当前资产（已入库） | `manage_status $in ManageStatus.IN_DEPOT_LIST` |
| history | 历史资产（已退库） | `manage_status $in ManageStatus.OUT_DEPOT_LIST` |
| wait_approve | 待审核资产 | `manage_status = ManageStatus.WAIT_APPROVE` |

> 注：未传 `searchType` 或传未知值时，业务层默认走 `ALL` 分支（不过滤 `manage_status`）。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（默认值） |
| message | string | 国际化文案 key；成功时缺省（不返回该字段） |
| data | object | 聚合结果，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| meta | array | 元信息列表，固定为 `[{"name": "date", "type": "String"}, {"name": "item", "type": "Array"}]`，描述返回结构 |
| item | array | 聚合结果列表，元素结构见下 |

#### item 数组元素结构

每个元素是 MongoDB 聚合管道 `$group` 结果的展开，将 `_id` 字段平铺到顶层。结构因是否启用 `interval` 而异：

**未启用 `interval`（单层聚合）**：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `<aggBy[0] 转义后>` | 字段对应类型 | 分组键值（如 `device_classify1_id`，由 `aggBy` 中点号替换为下划线得到） |
| `<aggFuncs[0].name>` | integer/number | 聚合结果值（如 `count`，整数） |

**启用 `interval="1d"`（双层聚合）**：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| date | string | 日期字符串，格式 `%Y-%m-%d`（如 "2024-08-25"） |
| item | array | 该日期下的子分组列表，每个元素含 `aggBy` 分组键 + `aggFuncs` 聚合值 |

### 响应示例

**未启用 interval 的响应**（按一级分类聚合资产数）：

```json
{
  "code": "Success",
  "data": {
    "meta": [
      {"name": "date", "type": "String"},
      {"name": "item", "type": "Array"}
    ],
    "item": [
      {"device_classify1_id": 1, "count": 156},
      {"device_classify1_id": 2, "count": 89},
      {"device_classify1_id": 3, "count": 45}
    ]
  }
}
```

**启用 interval="1d" 的响应**（按日期 + 一级分类聚合）：

```json
{
  "code": "Success",
  "data": {
    "meta": [
      {"name": "date", "type": "String"},
      {"name": "item", "type": "Array"}
    ],
    "item": [
      {
        "date": "2024-08-24",
        "item": [
          {"device_classify1_id": 1, "count": 12},
          {"device_classify1_id": 2, "count": 8}
        ]
      },
      {
        "date": "2024-08-25",
        "item": [
          {"device_classify1_id": 1, "count": 15},
          {"device_classify1_id": 2, "count": 10}
        ]
      }
    ]
  }
}
```

## 调用示例

### 示例1：按一级分类聚合当前入库资产数（无时间分桶）

**请求示例**：
```json
{
  "startTimestamp": 1724428800,
  "endTimestamp": 1724515200,
  "timeField": "last_seen",
  "aggBy": ["device.classify1_id"],
  "aggFuncs": [{"name": "count", "func": "count"}],
  "filterParam": {
    "classify1Id": [1, 2, 3],
    "searchType": "current"
  }
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "meta": [
      {"name": "date", "type": "String"},
      {"name": "item", "type": "Array"}
    ],
    "item": [
      {"device_classify1_id": 1, "count": 156},
      {"device_classify1_id": 2, "count": 89},
      {"device_classify1_id": 3, "count": 45}
    ]
  }
}
```

### 示例2：按日期分桶统计每日资产发现趋势（interval="1d"）

**请求示例**：
```json
{
  "startTimestamp": 1724428800,
  "endTimestamp": 1724515200,
  "timeField": "first_seen",
  "interval": "1d",
  "timeZone": "Asia/Shanghai",
  "aggBy": ["device.classify1_id"],
  "aggFuncs": [{"name": "count", "func": "count"}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "meta": [
      {"name": "date", "type": "String"},
      {"name": "item", "type": "Array"}
    ],
    "item": [
      {
        "date": "2024-08-24",
        "item": [
          {"device_classify1_id": 1, "count": 12}
        ]
      },
      {
        "date": "2024-08-25",
        "item": [
          {"device_classify1_id": 1, "count": 15}
        ]
      }
    ]
  }
}
```

### 示例3：按机构聚合所有资产数量

**请求示例**：
```json
{
  "startTimestamp": 1000000000,
  "endTimestamp": 9999999999,
  "timeField": "create_time",
  "aggBy": ["branch_id"],
  "aggFuncs": [{"name": "count", "func": "count"}],
  "filterParam": {
    "searchType": "all"
  }
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "meta": [
      {"name": "date", "type": "String"},
      {"name": "item", "type": "Array"}
    ],
    "item": [
      {"branch_id": 100, "count": 256},
      {"branch_id": 101, "count": 178}
    ]
  }
}
```

### 示例4：错误示例——startTimestamp 大于 endTimestamp

**请求示例**：
```json
{
  "startTimestamp": 1724515200,
  "endTimestamp": 1724428800,
  "timeField": "last_seen",
  "aggBy": ["device.classify1_id"],
  "aggFuncs": [{"name": "count", "func": "count"}]
}
```

**错误响应示例**（HTTP 400，业务层校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "startTimestamp > endTimestamp?",
  "data": null
}
```

### 示例5：错误示例——interval 传入非 1d 值

**请求示例**（`interval="1H"`，运行时触发 `AssertionError`）：
```json
{
  "startTimestamp": 1724428800,
  "endTimestamp": 1724515200,
  "timeField": "last_seen",
  "interval": "1H",
  "aggBy": ["device.classify1_id"],
  "aggFuncs": [{"name": "count", "func": "count"}]
}
```

**错误响应示例**（HTTP 500，`AssertionError` 被中间件转换）：
```json
{
  "code": "V1_SYSTEM_ERROR",
  "message": "<系统错误信息>",
  "data": null
}
```

### 示例6：错误示例——缺少必填字段

**请求示例**（缺少 `aggBy`）：
```json
{
  "startTimestamp": 1724428800,
  "endTimestamp": 1724515200,
  "timeField": "last_seen",
  "aggFuncs": [{"name": "count", "func": "count"}]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'aggBy: required'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `aggBy`、`aggFuncs` 数组长度限制为 1（`maxItems=1`），即单次请求仅支持 1 个分组键 + 1 个聚合函数
- `aggBy` 元素 maxLength=64，受 `GROUP_FULL_NAME_NULL_REGEX` 约束
- `aggFuncs[].name`/`aggFuncs[].func` maxLength=64，受 `GROUP_FULL_NAME_NULL_REGEX` 约束
- `timeField` 必须为 6 个枚举值之一
- `timeZone` 必须为 `pytz.all_timezones` 中的合法时区
- `startTimestamp`/`endTimestamp` 必须为 10 位秒级时间戳（1000000000-9999999999）
- `filterParam.classify1Id` 数组长度限制 10
- `interval` schema enum 允许 4 个值，但运行时仅支持 `"1d"`

### 参数依赖关系

- `startTimestamp` 必须 `<= endTimestamp`（业务层二次校验）
- `interval` 与 `timeField` 协同：`interval` 启用时，`timeField` 决定分桶字段
- `interval` 与 `timeZone` 协同：`timeZone` 仅在 `interval` 启用时生效
- `filterParam.classify1Id` 与 `filterParam.searchType` 互不影响，可组合使用
- `aggFuncs[].param` 仅在 `func != "count"` 时有意义（`count` 固定 `$sum: 1`）

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**（如 `superAdmin`、`assetQuery` 均不要求），仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- 未使用 `@trans_ctx_pid_query`，平台过滤由 MongoDB 集合层的 `platform_id` 注入机制隐式处理（默认 `RWCTX` 上下文平台）

### 性能建议

- 聚合管道使用 `allowDiskUse=True`，大数据集（百万级）可能耗时较长，建议通过 `filterParam.classify1Id`/`searchType` 缩小过滤范围
- `interval="1d"` 会触发双层 `$group`，性能开销大于单层聚合，建议结合较短的 `startTimestamp`/`endTimestamp` 范围使用
- `aggBy` 字段建议选择已建索引的字段（如 `device.classify1_id`、`branch_id`），避免全表扫描
- `timeField` 的 `$match` 范围若跨度过大（如全年），聚合结果可能很大，建议按日/周分批查询

### 数据一致性说明

- **响应字段名带下划线**：`aggBy` 中含点号的字段（如 `device.classify1_id`）在响应中被替换为 `device_classify1_id`，调用方需注意字段名映射
- **`filterParam` 覆盖**：业务层用构建的 `filters` 覆盖调用方传入的 `filterParam`，调用方在 `filterParam` 中传入的除 `classify1Id`/`searchType` 外的字段会被丢弃
- **`meta` 字段固定**：响应 `meta` 固定为 `[{"name": "date", "type": "String"}, {"name": "item", "type": "Array"}]`，无论是否启用 `interval`，调用方不应依赖 `meta` 判断结构
- **时间戳单位**：`startTimestamp`/`endTimestamp` 与 MongoDB 中 `timeField` 均为 10 位秒级时间戳；`interval` 启用时内部通过 `* 1000` 转毫秒再转 BSON Date

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `aggBy: required`、`timeField: not in enum`、`interval: not in enum`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/必填/枚举/正则约束 |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `startTimestamp > endTimestamp?` | 业务层校验 `startTimestamp` 大于 `endTimestamp` | 调整时间范围，确保 `startTimestamp <= endTimestamp` |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | `interval` 传入非 `"1d"` 值触发 `AssertionError`；或 MongoDB 聚合管道执行失败 | 仅使用 `interval="1d"`；联系运维检查 MongoDB 连接与索引 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层其他异常（如 `aggBy` 字段在 MongoDB 中不存在） | 检查 `aggBy` 字段名是否为合法的资产字段 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **`aggBy` 选择已建索引字段**：优先使用 `device.classify1_id`、`branch_id`、`manage_status` 等高频过滤字段，避免全表扫描
2. **`interval` 固定使用 `"1d"`**：当前运行时仅支持 `"1d"`，调用方应硬编码该值，不要根据 schema enum 传其他值
3. **`filterParam` 缩小范围**：通过 `classify1Id` + `searchType` 组合过滤，可显著提升聚合性能
4. **`timeField` 选择高频更新字段**：趋势分析建议用 `last_seen`（资产活跃度），新增趋势建议用 `first_seen`（资产发现）
5. **响应字段名映射**：`aggBy` 含点号的字段在响应中变为下划线，调用方需做字段名映射（如 `device.classify1_id` → `device_classify1_id`）
6. **`aggFuncs[].func="count"` 等价于 `$sum:1`**：无需传 `param`，结果为整数计数；其他聚合函数（`sum`/`avg` 等）需通过 `param` 指定字段名
7. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时 `code="Success"`），`data` 字段含聚合结果
