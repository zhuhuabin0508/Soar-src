# POST /api/xdr/v1/branches/list

## 接口概述

本接口用于按筛选条件查询资产组（branch）列表（扁平结构，非树形）。通过本接口，您可以获取以下信息：

### 可查询的资产组信息
- **资产组标识**：branchId、name、parentId、tag、tags、classifyId、branchType
- **资产组管理属性**：regionId、sortId、platformId、needAll、needNotConfig、isPrivate
- **资产组筛选条件**：search（模糊搜索关键字）、branchIds（精确 ID 过滤）、includeIp（按归属 IP 反查资产组）、branchManagers（按资产组管理员过滤）
- **跨平台筛选**：platformFilter（级联平台过滤，支持按平台 ID 列表批量查询并合并结果）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1BranchList` |
| 所属业务域 | 资产管理 / 资产组查询 |
| 接口分类 | 数据查询（列表查询，无写入） |
| 前置依赖 | 无（可直接调用）；若传入 `branchIds`、`includeIp`、`branchManagers` 等条件，结果会按这些条件过滤 |
| 关联接口 | `GET /api/xdr/v1/branches`（资产组树查询） |

## 使用场景

1. **资产组列表展示**：在 OpenAPI 侧获取资产组的扁平列表，用于第三方系统同步资产组元数据
2. **按 ID 精确查询资产组**：传入 `branchIds` 数组批量查询指定资产组的详细信息
3. **按 IP 反查资产组**：传入 `includeIp`，查询该 IP 可能归属的资产组列表（用于资产新增/编辑时为前端推荐资产组）
4. **按资产组管理员过滤**：传入 `branchManagers` 列表查询某管理员负责的资产组
5. **跨级联平台聚合查询**：传入 `platformFilter` 数组，接口会逐平台执行查询并合并结果（`platform_filter` 装饰器）

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/branches/list |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/branches/list` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/branches/list`（asm.yaml 第 182-191 行）。源码位于 v1 模块 `open_api/v1/resources/branch/views.py:27`（`V1BranchList.post`）。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.POST_BRANCH_REQ)` 校验请求体符合 JSON Schema 约束（详见"请求参数"段）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`，返回 OpenAPI 外壳错误响应。
2. **登录鉴权**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`。注意：本接口未使用 `@trans_ctx_pid_query`，平台上下文由 `platformFilter` 内部循环驱动。
3. **跨平台过滤分发**：`platform_filter(data)(business.get_asset_branches_list)()` 装饰器逻辑（源码 `asset_common/auth/cascade.py:220`）：
   - 读取 `data["platformFilter"]`，若为空则直接调用 `business.get_asset_branches_list(data)` 一次
   - 若 `platformFilter` 非空：对其中每个 `pf` 调用 `cascade_query_init([pf["platformId"]])` 切换平台上下文，再调用 `business.get_asset_branches_list(pf, ...)`，最终将各平台返回结果合并：
     - `dict` 类型结果用 `resp.update(rslt)` 合并
     - `list` 类型结果用 `resp.extend(rslt)` 合并
     - `int` 类型结果累加
4. **业务函数 `get_asset_branches_list(data)` 调用**（源码 `branch/business.py:83`）：
   1. **参数重命名**：`data['searchIds'] = data.pop('branchIds', [])` —— 将请求体的 `branchIds` 转换为内部使用的 `searchIds`
   2. **驼峰转下划线**：`transform_params(data)` 将 `classify1Id` → `classify_1_id`、`needAll` → `need_all`、`branchIds` → `branch_ids` 等驼峰字段名转换为下划线
   3. **调用 `get_branch_list(params, all_branch=False)`**（源码 `common/business/branch.py:312`）：
      - **`includeIp` 合法性校验**：若传入 `includeIp`，调用 `ip_util.is_valid_ip` 校验，非法抛 `FrontendError(ERROR.DEFAULT_ERROR, msg=Message.Ip.PleaseInputValidIp)`
      - **资产组查询**：通过 `BranchDao.get_branchs_by_filter` 查询启用状态的资产组（`get_using_branch_filter`），投影仅取必要字段（`branch_id`、`name`、`parent_id`、`tag`、`judgment`、`dev_ids_status`、`user`、`region_id`、`sort_id`、`platform_id`、`branch_type`），`data_filter=RWFlag.OFF` 绕过平台级读写过滤
      - **机构树构建**：`BranchDao.get_branch_tree(convert_judgment=True, managed_first=True, branchs=branchs, need_sort=True, del_sort_id=True)` 构建机构树
      - **权限/视角过滤**：根据 `get_ctx_data_regions()` 用户视角 region 列表过滤机构树（子组符合条件会保留父组，`sign_filter_parent=True`）
      - **参数过滤**：`filter_branch_tree_by_params(branch_tree, params)` 按 `search`/`searchIds`/`tags`/`classifyId`/`needNotConfig` 等参数过滤
      - **`includeIp` 反查分支**：若传入 `includeIp`，调用 `filter_branch_tree_by_ip_range` 反查归属资产组，再与权限过滤结果取交集
      - **结果格式化**：`deal_ret_format` 处理返回结构，部分权限用户会返回 `outer_layer` 不可编辑资产组信息
   4. **字段名映射**：`transform_branches_data_key(branch_tree)` 将响应字段名转换为对外驼峰格式：
      - `id` → `branchId`
      - `name` → `branchName`
      - `tag` → `branchTags`
   5. **下划线转驼峰**：`transform_output(branch_tree)` 将所有字段名从下划线转换为驼峰
   6. **异常转换**：业务过程中抛出的 `FrontendError` 被捕获并转换为 `V1OpenAPIError(ERROR.V1_UNKNOWN, message=err.get_description())`
5. **响应外壳**：`v1_open_api_output(data=rslt)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 默认不返回。

### 数据转换逻辑

- **请求字段重命名**：`branchIds` → `searchIds`（业务层），`branchIds` → `branch_ids`（DAO 层过滤）
- **驼峰转下划线**：`transform_params` 将 `classify1Id` → `classify_1_id`、`needAll` → `need_all`、`needNotConfig` → `need_not_config`、`isPrivate` → `is_private`、`includeIp` → `include_ip`、`needIpRange` → `need_ip_range`
- **响应字段重命名**：`transform_branches_data_key` 将 `id` → `branchId`、`name` → `branchName`、`tag` → `branchTags`
- **响应字段名转换**：`transform_output` 将所有下划线字段名转换为驼峰（如 `parent_id` → `parentId`、`region_id` → `regionId`、`branch_type` → `branchType`）
- **`tag` 字段归一**：DAO 层查询后若 `branch['tag'] is None` 则置为 `[]`

### 默认行为

- `search` 缺省 → 空字符串，不进行模糊过滤
- `branchIds` 缺省 → 空数组，不进行 ID 过滤
- `tags` 缺省 → 可空数组，不进行标签过滤
- `needAll` 缺省 → `False`，不在结果顶部插入"全部"节点（且 `all_branch=False`，本接口无论如何都不会插入"全部"节点）
- `classifyId` 缺省 → 不按分类过滤
- `includeIp` 缺省 → 不进行 IP 反查
- `isPrivate` 缺省 → 不按"私有资产组"过滤（`is_private` 字段不参与过滤，返回所有资产组）。**注意**：`isPrivate` 不是"管理IP范围"类型过滤，详见参数表与 `references/business-glossary.md`
- `needNotConfig` 缺省 → `False`，不展示"未配置"节点
- `needIpRange` 缺省 → `False`，响应中不返回 `ipRange` 字段
- `branchManagers` 缺省 → 不按管理员过滤
- `platformFilter` 缺省 → 直接调用一次业务函数（使用当前请求平台上下文）

### 特殊规则

- **`includeIp` 校验是硬性约束**：传入 `includeIp` 时会调用 `is_valid_ip` 校验，非法 IP 抛 `FrontendError`，被转换为 `V1_UNKNOWN`
- **子组符合条件会保留父组**：与常见过滤方式不同，子组通过权限/参数过滤时父组会被保留（`sign_filter_parent=True`）
- **`branchIds` 在内部被重命名为 `searchIds`**：调用方传入 `branchIds` 时，业务层将其 pop 并赋值给 `searchIds`，DAO 层据此精确匹配资产组 ID
- **`platformFilter` 是级联聚合**：本接口的 `platform_filter` 装饰器会按 `platformFilter` 数组逐平台调用业务函数并合并结果；每个 `platformFilter` 元素中的 `branchIds`/`assetIds` 等条件会替代顶层条件被传递给业务函数（参数为 `pf` 而非 `data`）
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段（`POST_BRANCH_REQ` 顶层 `additionalProperties=False`）
- **未使用 `@trans_ctx_pid_query`**：与多数 v1 接口不同，本接口的平台上下文由 `platformFilter` 驱动；未传 `platformFilter` 时使用当前请求默认平台

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| search | string | 否 | 无 | maxLength=95，pattern=`COMMON_SPECIAL_CHAR`（`^[^'"\\<>()%&+]+$|^$`，不允许特殊字符） | "核心" |
| branchIds | array | 否 | [] | 元素为 integer，minimum=0；精确匹配资产组 ID 列表 | [100, 101] |
| tags | array | 否 | [] | maxItems=20；元素为 string，minLength=1，maxLength=256，pattern=`TAG_NAME_REGEX`；按标签过滤 | ["生产", "数据库"] |
| needAll | boolean | 否 | false | 是否在结果中保留"全部"节点（本接口 `all_branch=False`，实际不会插入"全部"） | false |
| classifyId | array | 否 | 无 | 元素为 integer，minimum=0；按资产分类 ID 过滤 | [1, 2] |
| includeIp | string | 否 | 无 | pattern=`^[0-9a-zA-Z.:]{1,50}$`；按归属 IP 反查可分配资产组（业务层会 `is_valid_ip` 二次校验） | "10.1.1.100" |
| isPrivate | boolean | 否 | 无 | 是否仅查询私有资产组（`is_private=true` 的资产组，即用户自定义/私有资产组，区别于系统内置资产组）。**注意：`isPrivate` 不是"管理 IP 范围"类型标记**——"管理IP范围"是系统中一条具体资产组的 `name` 字段值（系统内置资产组，通常 `id=1`），不是 `is_private` 字段的语义。若需求是"查询'管理IP范围'资产组"，应使用 `search` 参数按名称查询，详见 `references/business-glossary.md` | true |
| needNotConfig | boolean | 否 | false | 是否展示"未配置"节点 | false |
| needIpRange | boolean | 否 | false | 是否在响应中返回 `ipRange` 字段（资产组 IP 范围） | false |
| branchManagers | array | 否 | [] | maxItems=1000；元素为 string，minLength=0，maxLength=95，pattern=`NAME_REG`；按资产组管理员名称过滤 | ["张三"] |
| platformFilter | array | 否 | [] | 级联平台过滤；元素为对象，详见 platformFilter 元素结构表 | `[{...}]` |

#### platformFilter 元素结构

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| platformId | string | 是 | 无 | 平台 ID；驱动 `cascade_query_init([platformId])` 切换平台上下文 | "platform_001" |
| assetIds | array | 否 | 无 | 元素为 integer；本接口业务函数未直接消费（仅 `branchIds`/`searchType` 等被使用） | [1001] |
| branchIds | array | 否 | 无 | 元素为 integer；在该平台上下文下使用的资产组 ID 过滤条件 | [100, 101] |
| searchType | string | 否 | 无 | enum：`SearchType.ALL`、`SearchType.CURRENT`、`SearchType.HISTORY`、`SearchType.WAIT_APPROVE` | "ALL" |
| needUncategorizedBranch | boolean | 否 | 无 | 是否需要"未归类"资产组 | false |
| magnitude | string | 否 | 无 | 资产重要性过滤（`MAGNITUDE_INCLUDE_ALL` 枚举） | "core" |
| needIpRange | boolean | 否 | 无 | 是否返回 ipRange 字段 | false |

> 注：`platformFilter` 完整 schema 定义见源码 `asset_web/app/common/params.py:656` 中的 `ASSET_PLATFORM_FILTER`。`platform_filter` 装饰器对每个 `pf` 调用业务函数并合并结果。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（`v1_open_api_output` 默认） |
| message | string | 国际化文案 key，成功时不返回（`message=None`） |
| data | array | 资产组列表（扁平结构），元素结构见下 |

> **响应外壳**：本接口使用标准 OpenAPI 外壳 `v1_open_api_output({code, message, data})`。调用方通过 `code` 字段判断成功，成功时 `data` 为资产组列表数组。

### data 数组元素结构

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| branchId | integer | 资产组 ID | 100 |
| branchName | string | 资产组名称（经 `VoTransform.BusinessName` 转换） | "核心业务系统" |
| parentId | integer | 父资产组 ID | 1 |
| branchTags | array | 资产组标签列表（由 `tag` 字段重命名而来） | ["生产"] |
| regionId | integer | 资产组所属区域 ID | 1 |
| platformId | string | 资产组所属平台 ID | "platform_001" |
| branchType | integer | 资产组类型（如 `DEV_BRANCH`、`VPC_BRANCH` 等） | 1 |
| sortId | integer | 排序 ID（部分场景被 `del_sort_id=True` 删除） | 1 |
| children | array | 子资产组列表（递归结构，字段同上） | `[{...}]` |
| ipRange | string | 资产组 IP 范围（仅 `needIpRange=true` 时返回） | "10.1.1.0/24" |

> 注：实际返回字段以业务层 `deal_ret_format` 处理后为准；部分场景下会包含 `outerLayer`/`hide` 等扩展字段（部分权限用户场景）。

### 响应示例

```json
{
  "code": "Success",
  "data": [
    {
      "branchId": 100,
      "branchName": "核心业务系统",
      "parentId": 1,
      "branchTags": ["生产"],
      "regionId": 1,
      "platformId": "platform_001",
      "branchType": 1,
      "children": [
        {
          "branchId": 101,
          "branchName": "数据库服务器组",
          "parentId": 100,
          "branchTags": [],
          "regionId": 1,
          "platformId": "platform_001",
          "branchType": 1
        }
      ]
    }
  ]
}
```

## 调用示例

### 示例1：查询全部资产组（无过滤条件）

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "branchId": 100,
      "branchName": "核心业务系统",
      "parentId": 1,
      "branchTags": [],
      "regionId": 1,
      "platformId": "platform_001",
      "branchType": 1
    },
    {
      "branchId": 101,
      "branchName": "数据库服务器组",
      "parentId": 100,
      "branchTags": [],
      "regionId": 1,
      "platformId": "platform_001",
      "branchType": 1
    }
  ]
}
```

### 示例2：按 ID 精确查询多个资产组

**请求示例**：
```json
{
  "branchIds": [100, 101],
  "needIpRange": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "branchId": 100,
      "branchName": "核心业务系统",
      "parentId": 1,
      "branchTags": ["生产"],
      "regionId": 1,
      "platformId": "platform_001",
      "branchType": 1,
      "ipRange": "10.1.1.0/24"
    }
  ]
}
```

### 示例3：按 IP 反查可分配资产组

**请求示例**：
```json
{
  "includeIp": "10.1.1.100"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "branchId": 100,
      "branchName": "核心业务系统",
      "parentId": 1,
      "branchTags": [],
      "regionId": 1,
      "platformId": "platform_001",
      "branchType": 1
    }
  ]
}
```

### 示例4：跨级联平台聚合查询

**请求示例**：
```json
{
  "platformFilter": [
    {"platformId": "platform_001", "branchIds": [100, 101]},
    {"platformId": "platform_002", "branchIds": [200, 201]}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {"branchId": 100, "branchName": "核心业务系统", "parentId": 1, "platformId": "platform_001", "branchType": 1},
    {"branchId": 101, "branchName": "数据库组", "parentId": 100, "platformId": "platform_001", "branchType": 1},
    {"branchId": 200, "branchName": "外联业务", "parentId": 2, "platformId": "platform_002", "branchType": 1},
    {"branchId": 201, "branchName": "审计组", "parentId": 200, "platformId": "platform_002", "branchType": 1}
  ]
}
```

### 示例5：错误示例——includeIp 格式非法

**请求示例**（`includeIp` 不是合法 IP）：
```json
{
  "includeIp": "999.999.999.999"
}
```

**错误响应示例**（HTTP 400，业务层 `is_valid_ip` 校验失败，`FrontendError` 转换为 `V1_UNKNOWN`）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "<Message.Ip.PleaseInputValidIp 对应的国际化文案>",
  "data": null
}
```

### 示例6：错误示例——schema 校验失败

**请求示例**（`search` 含特殊字符 `<`）：
```json
{
  "search": "test<alert>"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'search: pattern mismatch'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `search` maxLength=95，pattern=`COMMON_SPECIAL_CHAR`，不允许特殊字符 `'`、`"`、`\\`、`<`、`>`、`(`、`)`、`%`、`&`、`+`
- `branchIds` 元素必须为 integer 且 `>= 0`
- `tags` 数组长度限制 0-20，每个元素长度 1-256，pattern=`TAG_NAME_REGEX`
- `classifyId` 元素必须为 integer 且 `>= 0`
- `includeIp` 长度 1-50，pattern=`^[0-9a-zA-Z.:]{1,50}$`，业务层会二次校验合法性
- `branchManagers` 数组长度限制 0-1000，每个元素长度 0-95，pattern=`NAME_REG`
- `platformFilter` 元素的 `searchType` 仅允许 `SearchType.ALL`/`CURRENT`/`HISTORY`/`WAIT_APPROVE`
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `includeIp` 与 `branchIds` 互不冲突，但同时传入时 `includeIp` 反查结果会与 `branchIds` 过滤结果取交集
- `platformFilter` 与顶层条件：当传入 `platformFilter` 时，装饰器按平台逐个调用业务函数，`pf`（而非 `data`）作为业务函数入参，顶层 `branchIds`/`search` 等字段在该模式下不会被使用（除非业务函数内部从 `pf` 之外读取）
- `needIpRange=true` 才会在响应中返回 `ipRange` 字段
- `needNotConfig` 与 `isAll`/`needAll` 等节点插入逻辑相关，本接口 `all_branch=False`，不会插入"全部"节点

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- 业务层通过 `get_ctx_data_regions()` / `get_ctx_user_data_regions()` 进行视角权限过滤，用户只能看到其权限范围内的资产组
- 部分权限用户场景会返回 `outerLayer` 不可编辑资产组信息，调用方应识别并正确处理

### 性能建议

- `BranchDao.get_branchs_by_filter` 查询启用状态的资产组并构建树，资产组数量过大时建议传入 `branchIds`/`branchManagers` 缩小范围
- `platformFilter` 聚合查询会对每个平台逐个调用业务函数，跨平台数量过多会成倍增加响应时间
- `includeIp` 反查涉及 `filter_branch_tree_by_ip_range`，资产组 IP 范围数量过大时反查耗时较长
- 响应字段较多时建议显式传入 `needIpRange=false` 避免 IP 范围字段增大响应体

### 数据一致性说明

- **响应字段名转换**：`branchId`/`branchName`/`branchTags` 是经过 `transform_branches_data_key` 重命名的，调用方应使用驼峰字段名消费
- **`branchTags` 来源**：响应中 `branchTags` 对应 DAO 层的 `tag` 字段（数组），与请求体 `tags` 过滤参数不是同一字段
- **平台上下文**：未传 `platformFilter` 时使用当前请求默认平台；传入 `platformFilter` 时通过 `cascade_query_init` 切换，每次循环会覆盖前一次的平台上下文
- **`tag` 字段归一**：DAO 层查询后 `tag is None` 会被归一为 `[]`，调用方不应期待 `null`

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `search: pattern mismatch`、`branchIds: must be array`、`additionalProperties not allowed`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/必填/长度/枚举/正则约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<Message.Ip.PleaseInputValidIp>` | `includeIp` 不是合法 IP（`is_valid_ip` 校验失败） | 传入合法 IPv4/IPv6/CIDR 格式 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<其他 FrontendError 文案>` | 业务层其他校验失败（如 `ADD_ASSET_ERROR` 权限不足等） | 检查用户权限/资产组归属，或联系运维 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | `BranchDao` 查询失败 / MongoDB 连接异常 | 联系运维检查服务状态与 MongoDB 连接 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **`branchIds` 精确查询优先**：已知资产组 ID 时优先用 `branchIds` 而非 `search`，性能更优且结果确定
2. **`includeIp` 反查配合资产新增使用**：本接口的 `includeIp` 反查结果用于资产新增/编辑时为前端推荐可分配资产组，调用方应保留该参数仅在该场景使用
3. **`platformFilter` 跨平台聚合需注意性能**：跨多个平台查询会成倍增加耗时，建议按业务需要拆分调用而非一次性聚合所有平台
4. **`needIpRange` 按需开启**：仅在需要展示资产组 IP 范围时传入 `true`，避免响应体过大
5. **响应字段消费注意驼峰**：响应字段统一为驼峰（`branchId`/`branchName`/`parentId` 等），调用方不应使用下划线字段名
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code == "Success"` 判断成功，`data` 字段为数组而非对象，直接迭代即可
