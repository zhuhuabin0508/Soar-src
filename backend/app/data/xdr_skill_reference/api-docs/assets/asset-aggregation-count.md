# POST /api/xdr/v1/asset/aggregation/count

## 接口概述

本接口用于按资产组（branch）聚合统计资产数量，返回每个资产组下的资产总数，并支持按平台、子组展开、排序方式过滤。通过本接口，您可以获取以下内容：

### 可查询的资产组资产数信息
- **资产组维度聚合**：每个资产组的资产数量 `total`、资产组 ID `branchId`、资产组名 `branchName`、资产组全名 `branchFullName`、平台 ID `platformId`
- **子组聚合**：`ignoreSubBranch=false` 时，将子组资产数合并到顶层资产组，返回顶层资产组的累计资产数
- **入库状态过滤**：通过 `searchType` 过滤当前入库 / 历史退库 / 待审核资产
- **核心资产过滤**：通过 `magnitude` 过滤普通资产 / 核心资产 / 全部
- **平台过滤**：通过 `platformFilter` 指定平台与资产组范围

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `AssetAggCount`（注册于 `view/asset/openapi_v2.py:23`，定义于 `view/asset/rest_views.py:178`） |
| 所属业务域 | 资产统计 / 资产组聚合 |
| 接口分类 | 数据查询（MongoDB 聚合管道，无写入） |
| 前置依赖 | 无（可直接调用）；若传入 `branchIds`，建议为系统中已存在的资产组 ID |
| 关联接口 | `POST /api/xdr/v1/branches/total`（资产组总数）、`POST /api/xdr/v1/assets/aggregation/classify1Id`（按一级分类聚合） |

## 使用场景

1. **资产组资产数量大盘**：在大屏或资产组管理页面展示每个资产组下的资产数量分布
2. **核心资产分布统计**：通过 `magnitude="core"` 统计各资产组下核心资产数量，用于核心资产覆盖率分析
3. **入库资产分布**：通过 `searchType="current"` 仅统计已入库资产，过滤掉退库与待审核资产
4. **跨平台资产统计**：通过 `platformFilter` 指定多个平台 ID + 资产组 ID，统计跨平台资产分布
5. **子组聚合统计**：默认 `ignoreSubBranch=false`，将子组资产数累加到顶层资产组，便于按顶层组织维度统计

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/asset/aggregation/count |
| Content-Type | application/json |
| 权限要求 | `superAdmin` 或 `assetQuery` 策略角色（`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`） |

> **注**：对外路径 `/api/xdr/v1/asset/aggregation/count` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v2/asset/aggregation/count`（asm.yaml 第 519-528 行）。**本接口为 v2 内部接口经网关暴露为 v1 对外接口**。源码位于 v2 模块 `view/asset/openapi_v2.py:23` 注册，`view/asset/rest_views.py:178` 定义。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.AGGREGATION_COUNT_REQ)` 校验请求体，所有字段可选（无 `required`）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权 + 策略校验**：`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')` 校验登录态与策略角色，鉴权失败返回 `ACCESS_DENY_RESPONSE`。
3. **平台级联查询初始化**：`v1_open_api_validate` 装饰器内部调用 `cascade_query_init(data.pop("platform_ids", None) or data.pop("platformIDs", None) or [get_ctx_platform_id()])`，默认查询本平台，传入 `platform_ids`/`platformIDs` 可跨平台查询。
4. **业务函数 `business.get_aggregation_count(req)` 调用**（源码 `view/asset/business.py:1388`），由 `platform_filter(data)(business.get_aggregation_count)()` 包装（支持多平台结果聚合）：
   1. **构建基础过滤条件 `filters`**（`build_filter_aggregation_count`，源码 `business.py:1477`）：
      - `filters = {"belong_host": 0}`（排除"归属主机"资产）。
      - **入库状态过滤**：解析 `searchType`，通过 `SearchTypeHandler.get_filter` 注入 `manage_status` 过滤：
        - `SearchType.ALL`（"all"）或未传 → 不过滤
        - `SearchType.HISTORY`（"history"）→ `manage_status $in ManageStatus.OUT_DEPOT_LIST`
        - `SearchType.WAIT_APPROVE`（"wait_approve"）→ `manage_status = ManageStatus.WAIT_APPROVE`
        - `SearchType.CURRENT`（"current"）→ `manage_status $in ManageStatus.IN_DEPOT_LIST`
      - **核心资产过滤**：若 `magnitude` 非空且不等于 `"all"`，注入 `filters["device.magnitude"] = MAGNITUDE_EN_DICT[magnitude]`（`"normal"` → `MAGNITUDE.NORMAL`=5，`"core"` → `MAGNITUDE.CORE`=7）。
   2. **获取资产组 ID 列表**：`agg_branch_ids = list(set(req.get("branchIds", [])))`（去重）。
   3. **加载资产组全名映射**：`BranchDao.get_branch_full_name(id_as_key=True, need_unclassed_id=True, cache=False)`，返回 `{f"{platform_id}_{branch_id}": full_name}` 字典（如 `"1_100": "上海分公司/政府组"`）。
   4. **获取平台 ID 查询上下文**：`platform_ids = get_ctx_platform_id_query()`，由步骤 3 的 `cascade_query_init` 决定。
   5. **资产组资产数统计**（按 `ignoreSubBranch` 分支）：
      - **`ignoreSubBranch=false`（默认，含子组）**：
        - 调用 `BranchDao.get_sub_branch_with_platform_ids(agg_branch_ids, platform_ids)` 获取所有子组 ID 集合 `all_sub_branch_ids` 与父子映射 `sub_branch_mapping`。
        - 若 `agg_branch_ids` 非空，注入 `filters["branch_id"] = {"$in": all_sub_branch_ids}`。
        - 调用 `AssetDao.get_branch_asset_count(filters=filters)` 在 `assets` 集合上按 `(platform_id, branch_id)` 聚合，返回 `{platform_id: {branch_id: total}}` 字典。
        - 调用 `merge_sub_branch_count(branch_id_count_mapping, sub_branch_mapping)` 将子组资产数合并到顶层资产组（顶层资产组 `total` = 其所有子组 `total` 之和）。
      - **`ignoreSubBranch=true`（不含子组）**：
        - 若 `agg_branch_ids` 非空，注入 `filters["branch_id"] = {"$in": agg_branch_ids}`。
        - 调用 `AssetDao.get_branch_asset_count(filters=filters)` 获取每个资产组自身的资产数（不含子组）。
        - **补充漏掉的资产组**：对于在 `agg_branch_ids` 中但聚合结果为空（资产组下无资产）的资产组，补 `total=0`，确保每个请求的资产组都出现在结果中。
   6. **构造结果 `branch_asset_count`**：遍历 `branch_id_count_mapping`，对每个 `(platform_id, branch_id, total)`：
      - 跳过 `platform_id` 不在 `platform_ids` 中的项。
      - 跳过 `pid_bid_2_name` 中不存在的项（资产组已删除）。
      - 构造元素：`{"branchId": branch_id, "branchName": full_name.split("/")[-1], "branchFullName": full_name, "platformId": platform_id, "total": total}`。
   7. **结果排序**：默认按 `total` 降序；`total` 相同时按 `platformId`、`branchId` 升序。若 `sort="ASC"`，则按 `total` 升序。
5. **响应外壳**：`v1_open_api_output(data={"item": asset_count_info})` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`data` 含 `item` 数组。

### 数据转换逻辑

- **`searchType` → `manage_status` 转换**：通过 `SearchTypeHandler.get_filter` 将字符串枚举映射为 MongoDB `manage_status` 过滤条件（`$in` 或单值匹配）
- **`magnitude` → `device.magnitude` 转换**：通过 `MAGNITUDE_EN_DICT` 将 `"normal"`/`"core"` 映射为数据库枚举值 5/7
- **`branchIds` → 子组展开**：`BranchDao.get_sub_branch_with_platform_ids` 通过 `$graphLookup` 递归查询子组，将 `branchIds` 展开为所有后代资产组 ID 集合
- **资产组全名富化**：`BranchDao.get_branch_full_name` 返回的全名格式为 `"父组/子组"`，`branchName` 取最后一段（`split("/")[-1]`），`branchFullName` 保留完整路径
- **`AssetDao.get_branch_asset_count` 内部聚合**：通过 `AssetDao.get_count_by_aggregate` 执行 `$match → $group{_id:{branch_id, platform_id}, total:$sum:1} → $project{branchId, platformId, total}`，应用 `data_filter=RWFlag.RW` 与默认 `platform_filter=RWCTX`

### 默认行为

- 所有字段均可选，全部缺省时统计本平台所有资产组（含子组）的资产数
- `ignoreSubBranch` 缺省 → `false`（含子组聚合）
- `sort` 缺省 → `"DESC"`（按资产数降序）
- `searchType` 缺省 → 不过滤 `manage_status`
- `magnitude` 缺省或 `"all"` → 不过滤 `device.magnitude`
- `branchIds` 缺省或空 → 不限定资产组范围（统计所有资产组）
- `platformFilter` 缺省 → 仅查询本平台（`cascade_query_init` 默认 `[get_ctx_platform_id()]`）
- 资产组下无资产时，`ignoreSubBranch=true` 场景下补 `total=0`；`ignoreSubBranch=false` 场景下若该组及其子组均无资产，则该组不出现在结果中

### 特殊规则

- **`belong_host=0` 硬过滤**：所有分支都注入 `filters["belong_host"] = 0`，排除"归属主机"类型的资产（如主机下挂的虚拟资产）
- **资产组已删除则跳过**：若 `branch_id` 在 `pid_bid_2_name` 中找不到（资产组已删除），结果中跳过该资产组
- **跨平台过滤**：`platform_filter(data)` 包装器将请求分发到各平台执行，结果合并；`platform_ids` 控制查询平台范围
- **资产组全名 cache=False**：`get_branch_full_name` 不使用缓存，每次实时查询资产组树，确保资产组重命名后结果及时更新
- **`ignoreSubBranch=false` 时无 `total=0` 补充**：与 `true` 分支不同，`false` 分支不会为无资产的顶层资产组补 `total=0`，若顶层组及其所有子组都无资产，则该组不出现在结果中
- **schema 未声明 `additionalProperties=false`**：请求体允许出现 schema 中未声明的字段（被忽略）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| branchIds | array | 否 | 无 | maxItems=10000；元素为 integer，minimum=-1；资产组 ID 列表，未传则统计所有资产组 | [100, 101] |
| searchType | string | 否 | 无 | enum：`["all", "current", "history", "wait_approve"]`；资产入库状态过滤 | "current" |
| magnitude | string | 否 | 无 | enum：`["normal", "core", "all"]`；资产重要性过滤 | "core" |
| sort | string | 否 | "DESC" | enum：`["ASC", "DESC"]`；按资产数排序方式 | "DESC" |
| ignoreSubBranch | boolean | 否 | false | 是否忽略子组（false=将子组资产数合并到顶层组，true=仅统计资产组自身） | false |
| platformFilter | array | 否 | 无 | 平台过滤数组，元素为对象，详见 platformFilter 元素结构 | [{"platformId":"1","branchIds":[100]}] |

#### searchType 枚举值说明

| 值 | 含义 | 对应 manage_status 过滤 |
|----|------|------------------------|
| all | 全部资产 | 不过滤 |
| current | 当前资产（已入库） | `manage_status $in ManageStatus.IN_DEPOT_LIST` |
| history | 历史资产（已退库） | `manage_status $in ManageStatus.OUT_DEPOT_LIST` |
| wait_approve | 待审核资产 | `manage_status = ManageStatus.WAIT_APPROVE` |

#### magnitude 枚举值说明

| 值 | 含义 | 数据库映射值 | 业务影响 |
|----|------|--------------|----------|
| all | 全部资产 | 不过滤 | 统计所有资产 |
| normal | 普通资产 | 5（MAGNITUDE.NORMAL） | 仅统计普通资产 |
| core | 核心资产 | 7（MAGNITUDE.CORE） | 仅统计核心资产 |

#### sort 枚举值说明

| 值 | 含义 |
|----|------|
| ASC | 按资产数升序（数量少的在前） |
| DESC | 按资产数降序（数量多的在前，默认） |

#### platformFilter 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| platformId | string | 否 | 平台 ID | "1" |
| assetIds | array | 否 | 元素为 integer；资产 ID 过滤（本接口业务层未使用） | [1001] |
| branchIds | array | 否 | maxItems=10000，元素为 integer minimum=-1；资产组 ID 过滤 | [100, 101] |
| searchType | string | 否 | enum：`["all", "current", "history", "wait_approve"]`；平台级入库状态过滤 | "current" |
| needUncategorizedBranch | boolean | 否 | 是否包含未归类组（本接口业务层未使用） | false |
| magnitude | string | 否 | enum：`["normal", "core", "all"]`；平台级核心资产过滤 | "core" |
| needIpRange | boolean | 否 | 是否需要 IP 段（本接口业务层未使用） | false |

> 注：`platformFilter` 中的 `assetIds`/`searchType`/`needUncategorizedBranch`/`magnitude`/`needIpRange` 字段在 schema 中声明但本接口业务层未直接消费，实际过滤以顶层 `branchIds`/`searchType`/`magnitude` 为准；`platformFilter.branchIds` 由 `platform_filter` 包装器处理。

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
| item | array | 资产组资产数列表，元素结构见下 |

#### item 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| branchId | integer | 资产组 ID |
| branchName | string | 资产组短名（全名按 "/" 分割后取最后一段） |
| branchFullName | string | 资产组全名（如 "上海分公司/政府组"） |
| platformId | string | 平台 ID |
| total | integer | 该资产组下资产数量（`ignoreSubBranch=false` 时含子组累计，`true` 时仅自身） |

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "branchId": 100,
        "branchName": "政府组",
        "branchFullName": "上海分公司/政府组",
        "platformId": "1",
        "total": 256
      },
      {
        "branchId": 101,
        "branchName": "金融组",
        "branchFullName": "上海分公司/金融组",
        "platformId": "1",
        "total": 178
      }
    ]
  }
}
```

## 调用示例

### 示例1：统计所有资产组的当前入库资产数（含子组）

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
    "item": [
      {
        "branchId": 100,
        "branchName": "政府组",
        "branchFullName": "上海分公司/政府组",
        "platformId": "1",
        "total": 256
      },
      {
        "branchId": 101,
        "branchName": "金融组",
        "branchFullName": "上海分公司/金融组",
        "platformId": "1",
        "total": 178
      },
      {
        "branchId": 102,
        "branchName": "教育组",
        "branchFullName": "上海分公司/教育组",
        "platformId": "1",
        "total": 89
      }
    ]
  }
}
```

### 示例2：统计指定资产组的核心资产数（不含子组，升序）

**请求示例**：
```json
{
  "branchIds": [100, 101, 102],
  "searchType": "current",
  "magnitude": "core",
  "sort": "ASC",
  "ignoreSubBranch": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "branchId": 102,
        "branchName": "教育组",
        "branchFullName": "上海分公司/教育组",
        "platformId": "1",
        "total": 5
      },
      {
        "branchId": 101,
        "branchName": "金融组",
        "branchFullName": "上海分公司/金融组",
        "platformId": "1",
        "total": 12
      },
      {
        "branchId": 100,
        "branchName": "政府组",
        "branchFullName": "上海分公司/政府组",
        "platformId": "1",
        "total": 28
      }
    ]
  }
}
```

### 示例3：跨平台统计资产组资产数

**请求示例**：
```json
{
  "platformFilter": [
    {"platformId": "1", "branchIds": [100]},
    {"platformId": "2", "branchIds": [200]}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "branchId": 100,
        "branchName": "政府组",
        "branchFullName": "上海分公司/政府组",
        "platformId": "1",
        "total": 256
      },
      {
        "branchId": 200,
        "branchName": "研发组",
        "branchFullName": "北京分公司/研发组",
        "platformId": "2",
        "total": 145
      }
    ]
  }
}
```

### 示例4：错误示例——searchType 传非法值

**请求示例**（`searchType="unknown"`，schema 校验失败）：
```json
{
  "searchType": "unknown"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'searchType: not in enum'>",
  "data": null
}
```

### 示例5：错误示例——鉴权失败（无 superAdmin/assetQuery 策略）

**请求示例**：
```json
{
  "searchType": "current"
}
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

- `branchIds` 数组长度限制 10000，元素为 integer，minimum=-1
- `searchType`/`magnitude`/`sort` 必须为枚举值
- `ignoreSubBranch` 为 boolean
- `platformFilter` 数组元素为对象，子字段 `branchIds` 受 `BRANCH_IDS` 约束（maxItems=10000）
- schema 未声明 `additionalProperties=false`，请求体允许出现 schema 中未声明的字段（被忽略）

### 参数依赖关系

- `branchIds` 与 `ignoreSubBranch` 协同：`ignoreSubBranch=false` 时 `branchIds` 展开为含子组的全集，`true` 时仅匹配 `branchIds` 本身
- `searchType` 与 `magnitude` 互不影响，可组合使用（同时过滤入库状态与资产重要性）
- `platformFilter` 与顶层 `branchIds` 协同：`platform_filter` 包装器按 `platformFilter` 分发，顶层 `branchIds` 在业务层统一处理
- `sort` 仅影响最终结果排序，不影响过滤逻辑

### 权限要求

- `@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`，**要求 `superAdmin` 或 `assetQuery` 策略角色**，二者满足其一即可
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- 跨平台查询通过 `platform_ids`/`platformIDs` 参数 + `cascade_query_init` 实现，平台权限由上层 cascade 机制控制

### 性能建议

- `BranchDao.get_branch_full_name(cache=False)` 不使用缓存，每次实时查询资产组树，资产组数量过大时可能耗时，建议在低频场景调用
- `ignoreSubBranch=false` 触发 `$graphLookup` 递归查询子组，资产组层级过深（接近 `MAX_LAYER`）时性能下降，建议配合 `branchIds` 限定顶层组范围
- `AssetDao.get_branch_asset_count` 使用 `allowDiskUse=True`，大数据集可能使用磁盘临时文件
- `branchIds` 建议传入具体资产组 ID 列表，避免全量统计导致响应过大

### 数据一致性说明

- **响应外壳为 `v1_open_api_output`**：本接口虽为 v2 内部接口，但响应使用 `v1_open_api_output({code, message, data})`，调用方通过 `code` 字段判断成功（成功时 `code="Success"`），不要通过 `data` 字段是否为空判断
- **资产组已删除则跳过**：若 `branch_id` 对应资产组已删除，结果中不包含该资产组（不会返回 `total=0`）
- **`ignoreSubBranch` 分支差异**：`false` 分支不会为无资产的顶层组补 `total=0`，`true` 分支会补充（仅当 `branchIds` 非空时）
- **`branchName` vs `branchFullName`**：`branchName` 为全名按 "/" 分割的最后一段，`branchFullName` 为完整路径；若资产组名为空，`branchName` 也为空字符串
- **平台 ID 类型**：响应 `platformId` 为 string 类型（来自 `get_ctx_platform_id()`），与请求 `platformFilter[].platformId` 一致

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `searchType: not in enum`、`magnitude: not in enum`、`sort: not in enum`、`branchIds: must be array`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/枚举/长度约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常（如 `BranchDao.get_branch_full_name` 失败、`AssetDao.get_branch_asset_count` 失败） | 联系运维检查 MongoDB 连接与资产组树缓存 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 聚合管道执行失败、`$graphLookup` 超时 | 缩小 `branchIds` 范围，联系运维检查 MongoDB 索引与连接 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录、登录态失效或无 `superAdmin`/`assetQuery` 策略 | 重新登录或联系管理员授予 `assetQuery` 策略 |

## 最佳实践

1. **`branchIds` 限定范围**：全量统计所有资产组可能响应过大，建议传入具体的 `branchIds` 列表，缩小聚合范围
2. **`ignoreSubBranch` 按场景选择**：大屏展示顶层组分布用 `false`（含子组累计），资产组管理页查看单组资产数用 `true`
3. **`searchType="current"` 配合大盘**：资产分布大盘通常只关心已入库资产，建议固定 `searchType="current"`
4. **`magnitude="core"` 用于核心资产分析**：核心资产覆盖率分析时传 `magnitude="core"`，对比 `all` 与 `core` 的结果可计算覆盖率
5. **跨平台用 `platformFilter`**：跨平台统计时通过 `platformFilter` 指定各平台的 `branchIds`，避免全平台全量查询
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时 `code="Success"`），`data.item` 含资产组资产数列表
