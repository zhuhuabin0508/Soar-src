# POST /api/xdr/v1/assets/aggregation/classify1Id

## 接口概述

本接口用于按资产一级分类（`device.classify1_id`）聚合统计资产数量，返回每个一级分类下的资产数量，并支持按资产组、业务组、入库状态、资产重要性、平台过滤。通过本接口，您可以获取以下内容：

### 可查询的一级分类资产数信息
- **一级分类维度聚合**：每个一级分类的资产数量 `count`、一级分类 ID `classify1Id`、一级分类名称 `name`、平台 ID `platformId`
- **资产组过滤**：通过 `branchIds` 限定聚合范围到指定资产组（含子组）
- **业务组过滤**：通过 `businessIds` 限定聚合范围到指定业务组
- **入库状态过滤**：通过 `searchTypes`（复数）组合多个入库状态
- **资产重要性过滤**：通过 `magnitudes`（复数）组合普通/核心资产
- **平台过滤**：通过 `platformFilter` 指定平台范围
- **Top N 限制**：通过 `limit` 限制返回的分类数量

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `AssetAggClassifyId`（注册于 `view/asset/openapi_v2.py:25`，定义于 `view/asset/rest_views.py:222`） |
| 所属业务域 | 资产统计 / 一级分类聚合 |
| 接口分类 | 数据查询（MongoDB 聚合管道，无写入） |
| 前置依赖 | 无（可直接调用）；若传入 `branchIds`/`businessIds`，建议为系统中已存在的 ID |
| 关联接口 | `POST /api/xdr/v1/asset/aggregation/count`（按资产组聚合）、`POST /api/xdr/v1/assets/aggregation`（通用聚合） |

## 使用场景

1. **资产一级分类分布大盘**：在大屏展示各一级分类下资产数量分布（如服务器、网络设备、终端等分类的资产数）
2. **核心资产分类分析**：通过 `magnitudes=["core"]` 统计各一级分类下的核心资产数，用于核心资产分布分析
3. **资产组下分类分布**：通过 `branchIds=[100]` 限定到指定资产组，统计该组内各分类的资产数
4. **业务组下分类分布**：通过 `businessIds=[1001]` 限定到指定业务组，统计该业务组内各分类的资产数
5. **跨平台分类统计**：通过 `platformFilter` 指定多个平台，统计跨平台的分类分布
6. **Top N 分类**：通过 `limit=5` 仅返回资产数最多的 5 个分类，用于精简展示

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/aggregation/classify1Id |
| Content-Type | application/json |
| 权限要求 | `superAdmin` 或 `assetQuery` 策略角色（`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`） |

> **注**：对外路径 `/api/xdr/v1/assets/aggregation/classify1Id` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v2/asset/aggregation/classify1Id`（asm.yaml 第 497-506 行）。**本接口为 v2 内部接口经网关暴露为 v1 对外接口**。源码位于 v2 模块 `view/asset/openapi_v2.py:25` 注册，`view/asset/rest_views.py:222` 定义。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.AGGREGATION_CLASSIFY1_ID_REQ)` 校验请求体，所有字段可选（无 `required`）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权 + 策略校验**：`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')` 校验登录态与策略角色，鉴权失败返回 `ACCESS_DENY_RESPONSE`。
3. **平台级联查询初始化**：`v1_open_api_validate` 装饰器内部调用 `cascade_query_init(data.pop("platform_ids", None) or data.pop("platformIDs", None) or [get_ctx_platform_id()])`，默认查询本平台。
4. **业务函数 `platform_filter(data, transform_func)(business.get_aggregation_classify1_id)()` 调用**（源码 `view/asset/business.py:1541`）：
   - 由于使用 `transform_func` 跨平台合并模式，每个平台的查询结果通过 `transform_func` 累加到 `res`（`res["total"] += rslt["total"]; res["item"].extend(rslt["item"])`）。
   1. **参数转换**：`params = transform_params(params)`（驼峰转下划线，`branchIds` → `branch_ids`、`businessIds` → `business_ids`、`searchTypes` → `search_types`、`magnitudes` 保持不变等）。
   2. **构建 MongoDB 过滤条件 `match_filter`**：
      - `match_filter = {"belong_host": 0}`（排除"归属主机"资产）。
      - **资产组过滤**：`BranchIdsHandler.get_filter(params.get("branch_ids", []), True)` 注入 `branch_id $in` 过滤（`True` 表示含子组，会通过 `BranchDao.get_sub_branch` 展开子组）。
      - **业务组过滤**：`BusinessIdHandler.get_filter(params.get("business_ids", []), True)` 注入业务组过滤（含子组）。
      - **入库状态过滤**：`SearchTypeHandler.get_search_types_filter(params.get("search_types", []))` 将 `search_types` 列表合并为 `manage_status $in` 过滤。
      - **资产重要性过滤**：`MagnitudeHandler.get_magnitudes_filter(params.get("magnitudes", []))` 注入 `device.magnitude` 过滤：
        - 空列表或含 `"all"` 或同时含 `"core"` 与 `"normal"` → 不过滤
        - 仅 `"core"` → `device.magnitude $gte CORE_ASSET`（7）
        - 仅 `"normal"` → `$or: [{device.magnitude $exists:0}, {device.magnitude $lte NORMAL_ASSET}]`（5）
   3. **执行聚合 `AssetDao.get_count_by_aggregate`**（源码 `business.py:1566`）：
      - `match` = 上述 `match_filter`
      - `project` = `{}`（无中间投影）
      - `group` = `{"_id": {"c1_id": "$device.classify1_id", "pid": "$platform_id"}, "count": {"$sum": 1}}`（按一级分类 + 平台分组）
      - `last_project` = `{"count": 1, "classify1_id": "$_id.c1_id", "platform_id": "$_id.pid", "_id": 0}`（重命名输出字段）
      - `sort` = `{"count": -1, "platform_id": 1, "classify1_id": 1}`（按 count 降序，平台升序，分类升序）
      - `limit` = `params.get("limit")`（可选 Top N 限制）
      - `platform_filter` = `PlatformFlag.RWCTX`（按上下文平台过滤）
   4. **结果富化**：
      - 遍历聚合结果 `classify1_id_count`，调用 `MetaData.AssetClassify.get_classify1_name_by_id(classify1_id)` 富化 `name` 字段（一级分类名称）。
      - 累加 `total = sum(data["count"] for data in classify1_id_count)`。
      - 调用 `transform_output(classify1_id_count)` 将字段名转为驼峰（`classify1_id` → `classify1Id`、`platform_id` → `platformId`）。
   5. **返回**：`{"total": total, "item": classify1_id_count}`。
   - 跨平台结果通过 `transform_func` 累加到外层 `res`，最终 `res = {"total": <所有平台 total 之和>, "item": <所有平台 item 拼接>}`。
5. **响应外壳**：`v1_open_api_output(data=res)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`data` 含 `total` 与 `item`。

### 数据转换逻辑

- **`branchIds` → 子组展开**：`BranchIdsHandler.get_filter(branch_ids, True)` 内部通过 `BranchDao.get_sub_branch` 递归展开子组，将 `branch_ids` 转换为含所有后代组的 ID 集合，注入 `branch_id $in` 过滤
- **`businessIds` → 子组展开**：`BusinessIdHandler.get_filter(business_ids, True)` 同理展开业务组子节点
- **`searchTypes` → `manage_status` 转换**：`SearchTypeHandler.get_search_types_filter` 将多个 `search_type` 映射为 `manage_status` 列表，合并去重后注入 `$in` 过滤
- **`magnitudes` → `device.magnitude` 转换**：`MagnitudeHandler.get_magnitudes_filter` 将 `["core"]`/`["normal"]` 映射为 `device.magnitude` 范围过滤
- **`classify1_id` → `name` 富化**：`MetaData.AssetClassify.get_classify1_name_by_id` 根据 ID 查询分类元数据，返回中文名（如 1 → "服务器"）
- **字段名驼峰化**：`transform_output` 将 `classify1_id` → `classify1Id`、`platform_id` → `platformId`、`count` 保持不变

### 默认行为

- 所有字段均可选，全部缺省时统计本平台所有资产的一级分类分布
- `branchIds` 缺省或空 → 不限定资产组
- `businessIds` 缺省或空 → 不限定业务组
- `searchTypes` 缺省或空或含 `"all"` → 不过滤 `manage_status`
- `magnitudes` 缺省或空或含 `"all"` 或同时含 `"core"` 与 `"normal"` → 不过滤 `device.magnitude`
- `limit` 缺省 → 不限制返回数量（返回全部分类）
- `platformFilter` 缺省 → 仅查询本平台
- 排序固定为 `count` 降序、`platform_id` 升序、`classify1_id` 升序
- 跨平台查询时，`total` 与 `item` 累加所有平台结果

### 特殊规则

- **`belong_host=0` 硬过滤**：所有分支都注入 `match_filter["belong_host"] = 0`
- **`branchIds`/`businessIds` 含子组**：`BranchIdsHandler`/`BusinessIdHandler` 的第二参数 `True` 表示含子组，会递归展开
- **`magnitudes` 同时含 `core` 与 `normal` 等价于不过滤**：`MagnitudeHandler` 判断若同时含两者则返回空过滤
- **跨平台结果累加**：`platform_filter(data, transform_func)` 模式下，每个平台的查询结果通过 `transform_func` 累加到 `res`，`total` 是所有平台 `total` 之和，`item` 是所有平台 `item` 拼接
- **`name` 字段依赖元数据**：若 `MetaData.AssetClassify` 元数据未配置某 `classify1_id`，`name` 可能为空字符串
- **schema 未声明 `additionalProperties=false`**：请求体允许出现 schema 中未声明的字段（被忽略）
- **聚合使用 `allowDiskUse=True`**：大数据集允许使用磁盘临时文件

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| branchIds | array | 否 | 无 | maxItems=10000；元素为 integer，minimum=-1；资产组 ID 列表（含子组展开） | [100, 101] |
| businessIds | array | 否 | 无 | maxItems=10000；元素为 integer，minimum=-1；业务组 ID 列表（含子组展开） | [1001] |
| searchTypes | array | 否 | 无 | maxItems=4；元素为 string，enum：`["all", "current", "history", "wait_approve"]`；入库状态过滤（复数，可组合） | ["current"] |
| magnitudes | array | 否 | 无 | 元素为 string，enum：`["normal", "core"]`；资产重要性过滤（复数） | ["core"] |
| limit | integer | 否 | 无 | minimum=1，maximum=100；Top N 限制 | 5 |
| platformFilter | array | 否 | 无 | 平台过滤数组，元素为对象，详见 platformFilter 元素结构 | [{"platformId":"1"}] |

#### searchTypes 元素枚举值说明

| 值 | 含义 | 对应 manage_status 过滤 |
|----|------|------------------------|
| all | 全部资产 | 不过滤（含 `all` 时整个 `searchTypes` 不过滤） |
| current | 当前资产（已入库） | `manage_status $in ManageStatus.IN_DEPOT_LIST` |
| history | 历史资产（已退库） | `manage_status $in ManageStatus.OUT_DEPOT_LIST` |
| wait_approve | 待审核资产 | `manage_status = ManageStatus.WAIT_APPROVE` |

> 注：多个 `searchTypes` 合并为 `manage_status $in <合并去重后的状态列表>`。

#### magnitudes 元素枚举值说明

| 值 | 含义 | 数据库映射过滤 |
|----|------|---------------|
| normal | 普通资产 | `$or: [{device.magnitude $exists:0}, {device.magnitude $lte 5}]` |
| core | 核心资产 | `device.magnitude $gte 7` |

> 注：`magnitudes` 为空或含 `"all"` 或同时含 `"core"` 与 `"normal"` 时不过滤；单元素时按上表过滤。

#### platformFilter 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| platformId | string | 否 | 平台 ID | "1" |
| assetIds | array | 否 | 元素为 integer；资产 ID 过滤（本接口业务层未使用） | [1001] |
| branchIds | array | 否 | maxItems=10000，元素为 integer minimum=-1；资产组 ID 过滤 | [100] |
| searchType | string | 否 | enum：`["all", "current", "history", "wait_approve"]`；平台级入库状态过滤（本接口业务层未直接消费，以顶层 `searchTypes` 为准） | "current" |
| needUncategorizedBranch | boolean | 否 | 是否包含未归类组（本接口业务层未使用） | false |
| magnitude | string | 否 | enum：`["normal", "core", "all"]`；平台级核心资产过滤（本接口业务层未直接消费，以顶层 `magnitudes` 为准） | "core" |
| needIpRange | boolean | 否 | 是否需要 IP 段（本接口业务层未使用） | false |

> 注：`platformFilter` 中除 `platformId` 与 `branchIds` 外的字段在本接口业务层未直接消费，实际过滤以顶层 `branchIds`/`businessIds`/`searchTypes`/`magnitudes` 为准。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**（**注意：本接口虽为 v2 内部接口，但响应外壳使用 `v1_open_api_output` 而非 `frontend_output`**），结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（默认值） |
| message | string | 国际化文案 key；成功时缺省（不返回该字段） |
| data | object | 聚合结果，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 所有一级分类的资产数总和（跨平台累加） |
| item | array | 一级分类资产数列表，元素结构见下 |

#### item 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| classify1Id | integer | 一级分类 ID |
| name | string | 一级分类名称（由 `MetaData.AssetClassify.get_classify1_name_by_id` 富化） |
| count | integer | 该分类下资产数量 |
| platformId | string | 平台 ID |

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "total": 567,
    "item": [
      {
        "classify1Id": 1,
        "name": "服务器",
        "count": 256,
        "platformId": "1"
      },
      {
        "classify1Id": 2,
        "name": "网络设备",
        "count": 178,
        "platformId": "1"
      },
      {
        "classify1Id": 3,
        "name": "终端",
        "count": 133,
        "platformId": "1"
      }
    ]
  }
}
```

## 调用示例

### 示例1：统计所有资产的一级分类分布

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 567,
    "item": [
      {"classify1Id": 1, "name": "服务器", "count": 256, "platformId": "1"},
      {"classify1Id": 2, "name": "网络设备", "count": 178, "platformId": "1"},
      {"classify1Id": 3, "name": "终端", "count": 133, "platformId": "1"}
    ]
  }
}
```

### 示例2：统计指定资产组下当前入库核心资产的分类分布 Top 5

**请求示例**：
```json
{
  "branchIds": [100, 101],
  "searchTypes": ["current"],
  "magnitudes": ["core"],
  "limit": 5
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 45,
    "item": [
      {"classify1Id": 1, "name": "服务器", "count": 28, "platformId": "1"},
      {"classify1Id": 2, "name": "网络设备", "count": 12, "platformId": "1"},
      {"classify1Id": 3, "name": "终端", "count": 5, "platformId": "1"}
    ]
  }
}
```

### 示例3：跨平台统计分类分布

**请求示例**：
```json
{
  "platformFilter": [
    {"platformId": "1"},
    {"platformId": "2"}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 1024,
    "item": [
      {"classify1Id": 1, "name": "服务器", "count": 256, "platformId": "1"},
      {"classify1Id": 1, "name": "服务器", "count": 245, "platformId": "2"},
      {"classify1Id": 2, "name": "网络设备", "count": 178, "platformId": "1"},
      {"classify1Id": 2, "name": "网络设备", "count": 165, "platformId": "2"}
    ]
  }
}
```

### 示例4：错误示例——searchTypes 传非法值

**请求示例**（`searchTypes=["unknown"]`，schema 校验失败）：
```json
{
  "searchTypes": ["unknown"]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'searchTypes: not in enum'>",
  "data": null
}
```

### 示例5：错误示例——鉴权失败（无 superAdmin/assetQuery 策略）

**请求示例**：
```json
{}
```

**错误响应示例**（HTTP 403，鉴权失败）：
```json
{
  "code": "ACCESS_DENY",
  "message": "<鉴权失败文案>"
}
```

## 注意事项与限制

### 参数限制

- `branchIds`/`businessIds` 数组长度限制 10000，元素为 integer，minimum=-1
- `searchTypes` 数组长度限制 4，元素必须为枚举值
- `magnitudes` 数组元素必须为 `"normal"` 或 `"core"`（schema 未限制 `maxItems`）
- `limit` 必须为 1-100 的整数
- `platformFilter` 数组元素为对象，子字段 `branchIds` 受 `BRANCH_IDS` 约束（maxItems=10000）
- schema 未声明 `additionalProperties=false`，请求体允许出现 schema 中未声明的字段（被忽略）

### 参数依赖关系

- `branchIds` 与 `businessIds` 可组合使用，同时过滤资产组与业务组
- `searchTypes` 与 `magnitudes` 互不影响，可组合使用
- `limit` 仅限制返回的 `item` 数量，不影响 `total` 的计算（`total` 是所有分类的资产数总和，不受 `limit` 影响）
- `platformFilter` 与顶层 `branchIds`/`businessIds` 协同：`platform_filter` 包装器按 `platformFilter` 分发，顶层过滤条件在各平台内分别应用
- 跨平台查询时，相同 `classify1Id` 在不同平台会作为独立 `item` 元素返回（按 `platformId` 区分）

### 权限要求

- `@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`，**要求 `superAdmin` 或 `assetQuery` 策略角色**，二者满足其一即可
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- 跨平台查询通过 `platform_ids`/`platformIDs` 参数 + `cascade_query_init` 实现

### 性能建议

- `AssetDao.get_count_by_aggregate` 使用 `allowDiskUse=True`，大数据集可能耗时，建议通过 `branchIds`/`businessIds` 缩小范围
- `branchIds`/`businessIds` 含子组展开（`$graphLookup` 递归），层级过深时性能下降
- `limit` 建议传入合理值（如 10-20），避免返回过多分类
- 跨平台查询时结果集会随平台数线性增长，建议按需查询

### 数据一致性说明

- **响应外壳为 `v1_open_api_output`**：本接口虽为 v2 内部接口，但响应使用 `v1_open_api_output({code, message, data})`，调用方通过 `code` 字段判断成功（成功时 `code="Success"`）
- **`name` 依赖元数据**：`name` 由 `MetaData.AssetClassify.get_classify1_name_by_id` 富化，若元数据未配置该分类，`name` 为空字符串
- **`total` 不受 `limit` 影响**：`total` 是所有分类的资产数总和，`limit` 仅截断 `item` 数组
- **跨平台 `item` 不合并**：跨平台查询时，相同 `classify1Id` 在不同平台作为独立 `item` 返回（带不同 `platformId`），调用方需自行按 `classify1Id` 聚合
- **`classify1Id=0` 表示未分类**：部分资产可能未设置一级分类，聚合结果中可能出现 `classify1Id=0`、`name` 为空的项

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `searchTypes: not in enum`、`magnitudes: not in enum`、`limit: must be integer`、`branchIds: must be array`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/枚举/长度约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常（如 `MetaData.AssetClassify` 加载失败、`AssetDao.get_count_by_aggregate` 失败） | 联系运维检查 MongoDB 连接与元数据配置 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 聚合管道执行失败、`$graphLookup` 超时 | 缩小 `branchIds`/`businessIds` 范围，联系运维检查 MongoDB 索引 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录、登录态失效或无 `superAdmin`/`assetQuery` 策略 | 重新登录或联系管理员授予 `assetQuery` 策略 |

## 最佳实践

1. **`branchIds` 限定资产组范围**：全量统计可能响应过大，建议传入具体资产组 ID 缩小范围
2. **`searchTypes=["current"]` 配合大盘**：资产分布大盘通常只关心已入库资产，建议固定 `searchTypes=["current"]`
3. **`magnitudes=["core"]` 用于核心资产分析**：核心资产分布分析时传 `magnitudes=["core"]`
4. **`limit` 限制返回数量**：建议传入 `limit=10` 或 `limit=20`，避免返回过多分类导致响应过大
5. **跨平台结果自行聚合**：跨平台查询时相同 `classify1Id` 会有多个 `item`，调用方需按 `classify1Id` 自行累加 `count`
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时 `code="Success"`），`data.total` 与 `data.item` 含聚合结果
