# POST /api/xdr/v1/branches/total

## 接口概述

本接口用于查询资产组（branch）总数，可选择是否包含子孙资产组、是否包含未归类组。通过本接口，您可以获取以下内容：

### 可查询的资产组总数信息
- **全量资产组总数**：未传 `branchIds` 时返回当前平台所有使用中的资产组总数
- **指定资产组及其子孙总数**：传入 `branchIds` 时返回这些资产组及其所有子孙组的数量
- **未归类组计数控制**：通过 `needUncategorizedBranch` 控制是否将"未归类组"计入总数

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `BranchTotal`（注册于 `view/branch/openapi_v2.py:16`，定义于 `view/branch/views.py:303`） |
| 所属业务域 | 资产组管理 / 资产组总数统计 |
| 接口分类 | 数据查询（MongoDB count + `$graphLookup`，无写入） |
| 前置依赖 | 无（可直接调用）；若传入 `branchIds`，建议为系统中已存在的资产组 ID |
| 关联接口 | `POST /api/xdr/v1/branches/list`（资产组列表）、`POST /api/xdr/v1/asset/aggregation/count`（按资产组聚合资产数） |

## 使用场景

1. **资产组管理页总数展示**：在资产组管理页面顶部展示当前平台资产组总数
2. **批量操作前数量校验**：批量删除/移动资产组前，调用本接口确认目标资产组及其子孙组数量，避免误操作
3. **未归类组展示控制**：通过 `needUncategorizedBranch` 控制是否将"未归类组"计入总数，用于不同场景的统计口径
4. **指定资产组子树规模评估**：传入 `branchIds=[100]` 评估某顶层资产组下的子树规模，用于组织架构分析
5. **跨平台资产组总数统计**：通过 `platformFilter` 指定多个平台，统计跨平台资产组总数

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/branches/total |
| Content-Type | application/json |
| 权限要求 | `superAdmin` 或 `assetQuery` 策略角色（`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`） |

> **注**：对外路径 `/api/xdr/v1/branches/total` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v2/branches/total`（asm.yaml 第 508-517 行）。**本接口为 v2 内部接口经网关暴露为 v1 对外接口**。源码位于 v2 模块 `view/branch/openapi_v2.py:16` 注册，`view/branch/views.py:303` 定义。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.POST_BRANCH_TOTAL_REQ)` 校验请求体，所有字段可选（无 `required`），且 `additionalProperties=false`（请求体不允许出现 schema 中未声明的字段）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权 + 策略校验**：`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')` 校验登录态与策略角色，鉴权失败返回 `ACCESS_DENY_RESPONSE`。
3. **平台级联查询初始化**：`v1_open_api_validate` 装饰器内部调用 `cascade_query_init(data.pop("platform_ids", None) or data.pop("platformIDs", None) or [get_ctx_platform_id()])`，默认查询本平台。
4. **业务函数 `platform_filter(data)(get_asset_branches_total)()` 调用**（源码 `view/branch/business/general.py:284`）：
   1. **解析参数**：
      - `branch_ids = data.get("branchIds", [])`（资产组 ID 列表）。
      - `need_uncategorized_branch = data.get("needUncategorizedBranch", False)`（是否包含未归类组）。
      - `self_pid = get_ctx_platform_id()`（当前平台 ID）。
      - `query = get_ctx_platform_id_query()`（平台 ID 查询上下文，由步骤 3 的 `cascade_query_init` 决定）。
   2. **未归类组计数**（条件：`need_uncategorized_branch and len(query) == 1 and self_pid == query[0]`）：
      - 仅当**单平台查询**且为本平台时，`total += 1`（未归类组每个平台仅 1 个，ID 为 `UNCLASS_GROUP_ID=-1`）。
      - 跨平台查询时不在此步骤加未归类组（因每个平台单独处理）。
   3. **资产组总数统计**（按 `branch_ids` 是否为空分支）：
      - **`branch_ids` 为空（全量统计）**：
        - 调用 `BranchDao.get_using_branch_filter()` 获取"使用中"资产组的过滤条件（排除已删除资产组）。
        - 调用 `BranchDao.get_branch_total(filters)` 执行 `count_documents(filter=filters)`，返回符合条件的资产组总数。
        - 若 `not need_uncategorized_branch and total > 0`，`total -= 1`（扣除未归类组，因 `get_using_branch_filter` 包含未归类组）。
      - **`branch_ids` 非空（指定资产组子树）**：
        - 调用 `BranchDao.get_sub_branch(branch_ids, include_uncategorized_branch=False)` 获取 `branch_ids` 及其所有子孙组 ID 集合 `sub_branch_ids`（不含未归类组）。
        - `total += len(set(sub_branch_ids))`（取集合长度，避免重复计数）。
5. **响应外壳**：`v1_open_api_output(data={"total": total})` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`data` 含 `total` 整数。

### 数据转换逻辑

- **`branchIds` → 子孙组展开**：`BranchDao.get_sub_branch(branch_ids, include_uncategorized_branch=False)` 通过 `$graphLookup` 递归查询 `branch_ids` 的所有后代资产组（`maxDepth=BranchModel.MAX_LAYER`），返回所有后代组 ID 集合
- **`get_using_branch_filter`**：返回"使用中"资产组的过滤条件（排除已逻辑删除的资产组），包含未归类组（`branch_id=-1`）
- **`get_branch_total`**：直接调用 MongoDB `count_documents(filter=filters)`，未使用聚合管道，性能优于聚合
- **`platform_filter(data)` 包装**：跨平台查询时，`platform_filter` 将请求分发到各平台执行，结果合并；但本接口的 `total` 是单次调用的累加结果（跨平台场景下 `cascade_query_init` 设置 `query` 为多平台 ID，但步骤 2.ii 的未归类组计数仅在单平台时触发）

### 默认行为

- 所有字段均可选，全部缺省时返回本平台所有"使用中"资产组总数（扣除未归类组）
- `branchIds` 缺省或空 → 全量统计当前平台所有资产组
- `needUncategorizedBranch` 缺省 → `false`（不包含未归类组，从全量统计中扣除 1）
- `platformFilter` 缺省 → 仅查询本平台
- `branchIds` 非空时，`needUncategorizedBranch` 仅影响是否在 `get_sub_branch` 中包含未归类组（`include_uncategorized_branch=False` 固定不含），实际不影响 `branchIds` 非空场景的计数

### 特殊规则

- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段（`branchIds`/`needUncategorizedBranch`/`platformFilter` 之外的字段会被拒绝）
- **未归类组 ID 为 -1**：`UNCLASS_GROUP_ID = -1`，每个平台仅 1 个未归类组
- **未归类组计数仅在单平台场景生效**：跨平台查询时（`len(query) > 1`），步骤 2.ii 不执行，未归类组不计入总数
- **`branchIds` 非空时 `include_uncategorized_branch=False`**：`get_sub_branch` 调用时固定排除未归类组，即使 `needUncategorizedBranch=true`，`branchIds` 非空场景下未归类组也不计入
- **`branchIds` 非空时 `needUncategorized_branch` 实际无效**：因 `get_sub_branch(include_uncategorized_branch=False)` 固定排除，`needUncategorizedBranch` 仅在全量统计（`branchIds` 为空）场景下生效
- **`get_using_branch_filter` 含未归类组**：全量统计时 `count_documents` 包含未归类组，故 `needUncategorizedBranch=false` 时需 `total -= 1` 扣除

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| branchIds | array | 否 | 无 | maxItems=10000；元素为 integer，minimum=-1；资产组 ID 列表，传入后返回这些资产组及其子孙组总数 | [100, 101] |
| needUncategorizedBranch | boolean | 否 | false | 是否包含未归类组（仅在全量统计即 `branchIds` 为空时生效） | true |
| platformFilter | array | 否 | 无 | 平台过滤数组，元素为对象，详见 platformFilter 元素结构 | [{"platformId":"1"}] |

#### platformFilter 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| platformId | string | 否 | 平台 ID | "1" |
| assetIds | array | 否 | 元素为 integer；资产 ID 过滤（本接口业务层未使用） | [1001] |
| branchIds | array | 否 | maxItems=10000，元素为 integer minimum=-1；资产组 ID 过滤（本接口业务层未直接消费，以顶层 `branchIds` 为准） | [100] |
| searchType | string | 否 | enum：`["all", "current", "history", "wait_approve"]`；入库状态过滤（本接口业务层未使用） | "current" |
| needUncategorizedBranch | boolean | 否 | 是否包含未归类组（本接口业务层未直接消费，以顶层 `needUncategorizedBranch` 为准） | false |
| magnitude | string | 否 | enum：`["normal", "core", "all"]`；核心资产过滤（本接口业务层未使用） | "all" |
| needIpRange | boolean | 否 | 是否需要 IP 段（本接口业务层未使用） | false |

> 注：`platformFilter` 中除 `platformId` 外的字段在本接口业务层未直接消费，实际过滤以顶层 `branchIds`/`needUncategorizedBranch` 为准；`platformFilter` 主要用于 `cascade_query_init` 与 `platform_filter` 包装器控制查询平台范围。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**（**注意：本接口虽为 v2 内部接口，但响应外壳使用 `v1_open_api_output` 而非 `frontend_output`**），结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（默认值） |
| message | string | 国际化文案 key；成功时缺省（不返回该字段） |
| data | object | 资产组总数，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 资产组总数（含/不含子孙组与未归类组，取决于请求参数） |

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "total": 42
  }
}
```

## 调用示例

### 示例1：统计本平台所有资产组总数（不含未归类组）

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 42
  }
}
```

### 示例2：统计本平台所有资产组总数（含未归类组）

**请求示例**：
```json
{
  "needUncategorizedBranch": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 43
  }
}
```

### 示例3：统计指定资产组及其子孙组总数

**请求示例**：
```json
{
  "branchIds": [100, 101]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "total": 28
  }
}
```

### 示例4：跨平台统计资产组总数

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
    "total": 87
  }
}
```

### 示例5：错误示例——传入未声明的字段

**请求示例**（`additionalProperties=false`，传入未声明的 `searchType`）：
```json
{
  "searchType": "current"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'Additional properties are not allowed (searchType)'>",
  "data": null
}
```

### 示例6：错误示例——鉴权失败（无 superAdmin/assetQuery 策略）

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

- `branchIds` 数组长度限制 10000，元素为 integer，minimum=-1
- `needUncategorizedBranch` 为 boolean
- `platformFilter` 数组元素为对象，子字段 `branchIds` 受 `BRANCH_IDS` 约束（maxItems=10000）
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段（`branchIds`/`needUncategorizedBranch`/`platformFilter` 之外的字段会被拒绝）

### 参数依赖关系

- `branchIds` 与 `needUncategorizedBranch` 互斥影响：`branchIds` 非空时 `needUncategorizedBranch` 实际无效（`get_sub_branch` 固定 `include_uncategorized_branch=False`）
- `needUncategorizedBranch` 仅在 `branchIds` 为空（全量统计）时生效
- 跨平台查询时（`platformFilter` 含多个平台），未归类组计数仅在单平台场景触发，跨平台时未归类组不计入总数
- `platformFilter` 与顶层 `branchIds` 协同：`platform_filter` 包装器按 `platformFilter` 分发，顶层 `branchIds` 在业务层统一处理

### 权限要求

- `@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery")')`，**要求 `superAdmin` 或 `assetQuery` 策略角色**，二者满足其一即可
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- 跨平台查询通过 `platform_ids`/`platformIDs` 参数 + `cascade_query_init` 实现

### 性能建议

- `BranchDao.get_branch_total` 使用 `count_documents`，性能优于聚合管道，但全量统计仍建议在低频场景调用
- `branchIds` 非空时触发 `$graphLookup` 递归查询子孙组，层级过深（接近 `MAX_LAYER`）时性能下降，建议传入少量顶层组 ID
- 跨平台查询时各平台独立计数，结果合并，性能随平台数线性增长

### 数据一致性说明

- **响应外壳为 `v1_open_api_output`**：本接口虽为 v2 内部接口，但响应使用 `v1_open_api_output({code, message, data})`，调用方通过 `code` 字段判断成功（成功时 `code="Success"`）
- **未归类组 ID 为 -1**：每个平台仅 1 个未归类组，`needUncategorizedBranch=true` 时全量统计会 +1
- **`branchIds` 非空时未归类组不计入**：`get_sub_branch(include_uncategorized_branch=False)` 固定排除，即使 `needUncategorizedBranch=true`
- **跨平台未归类组计数差异**：跨平台查询时未归类组不计入总数（步骤 2.ii 仅单平台触发），与单平台查询结果可能存在 1 的差异
- **已删除资产组不计入**：`get_using_branch_filter` 排除已逻辑删除的资产组，`get_sub_branch` 的 `restrictSearchWithMatch` 也排除已删除组

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `branchIds: must be array`、`needUncategorizedBranch: must be boolean`、`Additional properties are not allowed`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/必填/长度约束；注意 `additionalProperties=false` |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常（如 `BranchDao.get_using_branch_filter` 失败、`BranchDao.get_sub_branch` 失败） | 联系运维检查 MongoDB 连接与资产组树缓存 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | `count_documents` 超时、`$graphLookup` 递归超时 | 缩小 `branchIds` 范围，联系运维检查 MongoDB 索引 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录、登录态失效或无 `superAdmin`/`assetQuery` 策略 | 重新登录或联系管理员授予 `assetQuery` 策略 |

## 最佳实践

1. **全量统计用空请求体**：统计本平台所有资产组总数时传 `{}`，简洁高效
2. **`needUncategorizedBranch` 仅在全量统计时使用**：`branchIds` 非空时该参数无效，避免误用
3. **`branchIds` 用于子树规模评估**：传入顶层资产组 ID 评估子树规模，避免传入过多 ID 导致 `$graphLookup` 性能下降
4. **跨平台用 `platformFilter`**：跨平台统计时通过 `platformFilter` 指定平台，避免全平台查询
5. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时 `code="Success"`），`data.total` 含资产组总数
6. **注意未归类组计数差异**：单平台与跨平台查询时未归类组计数策略不同，调用方在比较总数时需考虑此差异
