# POST /api/xdr/v1/assets/business/list

## 接口概述

本接口用于查询业务组（business group）树形列表，返回当前平台的业务组树结构、业务组数量、业务系统数量。通过本接口，您可以获取以下内容：

### 可查询的业务组信息
- **业务组树结构**：以树形结构返回业务组（含业务系统与业务组两类节点），每个节点含 `businessId`、`businessName`、`type`、`children`（子节点）
- **业务组与业务系统计数**：`groupCount`（业务组数量）、`businessCount`（业务系统数量）
- **"全部组"虚拟节点**：`needAll=true` 且无 `search` 时，在树顶部插入"全部组"虚拟节点（`businessId=0`）
- **搜索过滤**：通过 `search` 关键字模糊匹配业务组名称

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `BusinessTree`（注册于 `view/business/openapi_v2.py:17`，定义于 `view/business/views.py:316`） |
| 所属业务域 | 业务组管理 / 业务组树查询 |
| 接口分类 | 数据查询（MongoDB find + 树构造，无写入） |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `POST /api/xdr/v1/branches/total`（资产组总数）、`POST /api/xdr/v1/asset/aggregation/count`（按资产组聚合资产数） |

## 使用场景

1. **业务组管理页树形展示**：在业务组管理页面以树形结构展示当前平台的所有业务组与业务系统
2. **业务组选择器**：在资产编辑、查询等场景下作为业务组选择器的数据源，用户可选择业务组归属
3. **业务组搜索**：通过 `search` 关键字模糊匹配业务组名称，快速定位业务组
4. **"全部组"虚拟节点展示**：`needAll=true` 时在树顶部插入"全部组"节点，用于业务组选择器的"全部"选项
5. **业务组与业务系统计数**：`groupCount` 与 `businessCount` 用于业务组管理页的统计展示
6. **配合资产查询接口**：业务组树作为资产查询的过滤条件来源，与 `POST /api/xdr/v1/assets/list` 等接口配合使用

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/business/list |
| Content-Type | application/json |
| 权限要求 | `superAdmin` 或 `assetQuery` 或 `assetGroupQuery` 策略角色（`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery") || hasPolicies("assetGroupQuery")')`） |

> **注**：对外路径 `/api/xdr/v1/assets/business/list` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v2/business/list`（asm.yaml 第 552-561 行）。**本接口为 v2 内部接口经网关暴露为 v1 对外接口**。源码位于 v2 模块 `view/business/openapi_v2.py:17` 注册，`view/business/views.py:316` 定义。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(BUSINESS_LIST_REQ)` 校验请求体，所有字段可选（无 `required`），且 `additionalProperties=false`（请求体不允许出现 schema 中未声明的字段）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`（HTTP 400，code=1104）。
2. **登录鉴权 + 策略校验**：`@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery") || hasPolicies("assetGroupQuery")')` 校验登录态与策略角色，鉴权失败返回 `ACCESS_DENY_RESPONSE`。
3. **平台级联查询初始化**：`v1_open_api_validate` 装饰器内部调用 `cascade_query_init(data.pop("platformIds", None) or data.pop("platformIDs", None) or [get_ctx_platformId()])`，默认查询本平台。
4. **业务函数 `get_asset_business_list(request_body)` 调用**（源码 `view/business/business.py:969`，被 `@transform_openapi_input_output` 装饰）：
   1. **请求参数驼峰转下划线**：`@transform_openapi_input_output` 装饰器将 `request_body` 的驼峰字段名转为下划线（`needAll` → `need_all`、`search` 保持不变），结果返回时再转回驼峰。
   2. **构建查询过滤条件 `filters`**（`build_business_filter`，源码 `business.py:1010`）：
      - `filters["$and"] = [GROUP_DELETE_TIME_FILTER, get_group_type_filter(BUSINESS_GROUP)]`：固定过滤未删除的业务组（`GROUP_DELETE_TIME_FILTER`）与业务组类型（`BUSINESS_GROUP`）。
      - 若 `params.get("search")` 非空，追加 `{"name": {"$regex": re.escape(search.strip()), "$options": "i"}}`（名称正则模糊匹配，大小写不敏感）。
   3. **查询业务组列表**：
      - `projection = {"_id": 0, "group_id": 1, "name": 1, "parent_id": 1, "platform_id": 1, "type": 1}`（仅查询必要字段）。
      - `AssetGroupDao.get_groups_by_filter(filters, projection, platform_filter=PlatformFlag.RWSELF)` 执行 MongoDB `find`，应用 `platform_filter=RWSELF`（仅查询本平台数据，跨平台由 `platform_filter` 包装器处理）。
      - 返回扁平的业务组列表 `business_list`。
   4. **计算业务组与业务系统数量**：
      - `groupCount = len([b for b in business_list if b["type"] == BusinessORGroup.GROUP])`（type=1 为业务组）。
      - `businessCount = len(business_list) - groupCount`（type=0 为业务系统）。
   5. **构造树形结构**：
      - `AssetGroupDao.get_group_tree(groups=business_list)` 将扁平列表转为树形：
        - 按 `platformId` 分组，每个平台内按 `parent_id` 构建父子关系。
        - `children` 按 `groupId` 升序排序。
        - 根节点（`parent_id` 不在字典中的节点）作为树顶层。
      - 跨平台时通过 `trans_platform_tree` 合并各平台树。
   6. **字段名格式化 `field_name_format`**（递归处理树）：
      - `group["businessName"] = group.pop("name", "")`：`name` 重命名为 `businessName`。
      - `group["business_id"] = group.pop("group_id")`：`group_id` 重命名为 `business_id`（仅在业务函数内部，响应时经 `@transform_openapi_input_output` 统一输出为 camelCase `businessId`）。
      - **未归类组名称更新**：若 `group["type"] == BusinessORGroup.GROUP` 且 `group["businessId"] == AssetGroupDao.UNCLASS_GROUP_ID`（-1），`group["businessName"] = Identity.Branch.UncategorizedBranch.translate()`（本地化的"未归类组"名称）。
   7. **"全部组"虚拟节点插入**（条件：`params.get("need_all") is True and not params.get("search")`）：
      - `p_self_id = get_ctx_platformId()`。
      - 在树顶部插入 `{"businessName": Identity.OrgName.All.translate(), "businessId": 0, "children": business_tree, "type": BusinessORGroup.GROUP, "sortId": f"{p_self_id}_0"}`。
      - `groupCount += 1`（"全部组"虚拟节点计入业务组数量）。
   8. **返回**：`{"businessCount": businessCount, "groupCount": groupCount, "item": business_tree}`。
   - 响应返回时 `@transform_openapi_input_output` 将字段名转回驼峰（`businessName` 保持驼峰、`businessId` 保持驼峰、`groupCount` 保持下划线等）。
5. **响应外壳**：`v1_open_api_output(data=data)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`data` 含业务组树与计数。

### 数据转换逻辑

- **请求参数驼峰转下划线**：`@transform_openapi_input_output` 装饰器在调用业务函数前将 `needAll` → `need_all`、`search` 保持不变（无下划线版本）；响应时将下划线字段转回驼峰
- **`groupId` → `businessId` 重命名**：`field_name_format` 将数据库字段 `groupId` 重命名为对外字段 `businessId`
- **`name` → `businessName` 重命名**：`field_name_format` 将数据库字段 `name` 重命名为对外字段 `businessName`
- **未归类组名称本地化**：`groupId == -1` 的节点，`businessName` 被替换为 `Identity.Branch.UncategorizedBranch.translate()`（本地化的"未归类组"）
- **"全部组"虚拟节点**：`businessId=0`、`businessName=Identity.OrgName.All.translate()`（本地化的"全部"），`type=BusinessORGroup.GROUP`，含 `sortId` 排序字段
- **树形构造**：`AssetGroupDao.get_group_tree` 按 `parent_id` 构建父子关系，`children` 按 `groupId` 升序排序
- **平台富化**：`get_group_tree` 内部调用 `render_platform_info` 为每个节点富化平台信息（`platformId`、平台名称等）

### 默认行为

- 所有字段均可选，全部缺省时返回当前平台所有未删除业务组的完整树（不含"全部组"虚拟节点）
- `search` 缺省 → 不做名称过滤，返回所有业务组
- `needAll` 缺省 → `false`，不插入"全部组"虚拟节点
- `needAll=true` 且 `search` 非空 → **不插入"全部组"虚拟节点**（条件为 `need_all is True and not params.get("search")`）
- `platformFilter` 缺省 → 仅查询本平台（`cascade_query_init` 默认 `[get_ctx_platformId()]`）
- 树顶层按 `groupId` 升序排序，`children` 按 `groupId` 升序排序
- 业务组与业务系统通过 `type` 字段区分（`BusinessORGroup.GROUP=1` 业务组，`BusinessORGroup.BUSINESS=0` 业务系统）

### 特殊规则

- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段（`search`/`needAll` 之外的字段会被拒绝）
- **`platform_filter=RWSELF`**：`AssetGroupDao.get_groups_by_filter` 强制只查询本平台数据，跨平台由 `platform_filter` 包装器分别查询后合并
- **未删除业务组过滤**：`GROUP_DELETE_TIME_FILTER` 排除已逻辑删除的业务组
- **业务组类型过滤**：`get_group_type_filter(BUSINESS_GROUP)` 仅查询 `type=BUSINESS_GROUP` 类型的节点
- **"全部组"虚拟节点仅在不搜索时插入**：`needAll=true` 且 `search` 非空时不插入，避免搜索结果中出现"全部组"干扰
- **未归类组名称本地化**：`groupId=-1` 的节点名称被强制替换为本地化的"未归类组"，不返回数据库中的原始名称
- **`needAll=true` 时 `groupCount` 含虚拟节点**：插入"全部组"虚拟节点后 `groupCount += 1`，调用方在统计业务组数量时需考虑此虚拟节点

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 顶层参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| search | string | 否 | 无 | minLength=0，maxLength=95；业务组名称搜索关键字，正则模糊匹配（大小写不敏感） | "研发" |
| needAll | boolean | 否 | false | 是否在树顶部插入"全部组"虚拟节点（仅在不搜索时生效） | true |

> 注：`platformFilter`/`platformIds`/`platformIDs` 等跨平台参数由 `v1_open_api_validate` 装饰器在 `cascade_query_init` 中处理，不显式出现在 `BUSINESS_LIST_REQ` schema 中，但可传入用于跨平台查询。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**（**注意：本接口虽为 v2 内部接口，但响应外壳使用 `v1_open_api_output` 而非 `frontend_output`**），结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（默认值） |
| message | string | 国际化文案 key；成功时缺省（不返回该字段） |
| data | object | 业务组树与计数，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| businessCount | integer | 业务系统数量（type=0 的节点数） |
| groupCount | integer | 业务组数量（type=1 的节点数；`needAll=true` 时含"全部组"虚拟节点） |
| item | array | 业务组树形列表，元素结构见下 |

#### item 数组元素结构（业务组节点）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| businessId | integer | 业务组 ID（数据库 `group_id`，未归类组为 -1，"全部组"虚拟节点为 0） |
| businessName | string | 业务组名称（数据库 `name`；未归类组为本地化的"未归类组"；"全部组"虚拟节点为本地化的"全部"） |
| type | integer | 节点类型：`0`=业务系统（BUSINESS），`1`=业务组（GROUP） |
| children | array | 子节点列表（递归结构，按 `businessId` 升序排序）；无子节点时缺省 |
| platformId | string | 平台 ID（由 `render_platform_info` 富化） |
| sortId | string | 排序 ID（仅"全部组"虚拟节点含此字段，格式 `f"{platformId}_0"`） |
| parentId | integer | 父节点 ID（数据库 `parent_id`；顶层节点为根节点，无父节点时缺省） |
| isSelfPlatform | boolean | 是否本平台节点（由 `render_platform_info` 富化，标识该节点所属平台是否为当前平台） |
| platformName | string | 平台名称（由 `render_platform_info` 富化，与 `platformId` 配套返回） |

> 注：`platformId`/`platformName`/`isSelfPlatform` 等富化字段由 `render_platform_info` 注入，具体字段以实际返回为准；`children` 内的节点结构与此表一致（递归）。
>
> **命名风格**：本接口响应 `data`/`item` 内的所有字段 key 恒为 **camelCase**（如 `businessCount`/`groupId`/`platformId`），不存在 snake_case 形式；调用方应按 camelCase 解析，不要按数据库字段名（`business_count`/`group_id`）取值。

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "businessCount": 5,
    "groupCount": 8,
    "item": [
      {
        "businessId": 1001,
        "businessName": "研发部",
        "type": 1,
        "platformId": "1",
        "children": [
          {
            "businessId": 1002,
            "businessName": "前端组",
            "type": 0,
            "platformId": "1"
          },
          {
            "businessId": 1003,
            "businessName": "后端组",
            "type": 0,
            "platformId": "1"
          }
        ]
      },
      {
        "businessId": -1,
        "businessName": "未归类组",
        "type": 1,
        "platformId": "1"
      }
    ]
  }
}
```

**`needAll=true` 时的响应**（顶部插入"全部组"虚拟节点）：

```json
{
  "code": "Success",
  "data": {
    "businessCount": 5,
    "groupCount": 9,
    "item": [
      {
        "businessId": 0,
        "businessName": "全部",
        "type": 1,
        "sortId": "1_0",
        "children": [
          {
            "businessId": 1001,
            "businessName": "研发部",
            "type": 1,
            "platformId": "1",
            "children": [...]
          },
          {
            "businessId": -1,
            "businessName": "未归类组",
            "type": 1,
            "platformId": "1"
          }
        ]
      }
    ]
  }
}
```

## 调用示例

### 示例1：查询当前平台所有业务组树

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "businessCount": 5,
    "groupCount": 8,
    "item": [
      {
        "businessId": 1001,
        "businessName": "研发部",
        "type": 1,
        "platformId": "1",
        "children": [
          {"businessId": 1002, "businessName": "前端组", "type": 0, "platformId": "1"},
          {"businessId": 1003, "businessName": "后端组", "type": 0, "platformId": "1"}
        ]
      },
      {
        "businessId": -1,
        "businessName": "未归类组",
        "type": 1,
        "platformId": "1"
      }
    ]
  }
}
```

### 示例2：查询业务组树（含"全部组"虚拟节点）

**请求示例**：
```json
{
  "needAll": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "businessCount": 5,
    "groupCount": 9,
    "item": [
      {
        "businessId": 0,
        "businessName": "全部",
        "type": 1,
        "sortId": "1_0",
        "children": [
          {
            "businessId": 1001,
            "businessName": "研发部",
            "type": 1,
            "platformId": "1",
            "children": [
              {"businessId": 1002, "businessName": "前端组", "type": 0, "platformId": "1"}
            ]
          }
        ]
      }
    ]
  }
}
```

### 示例3：搜索业务组（"全部组"虚拟节点不插入）

**请求示例**：
```json
{
  "search": "研发",
  "needAll": true
}
```

**响应示例**（`needAll=true` 但 `search` 非空，不插入"全部组"虚拟节点）：
```json
{
  "code": "Success",
  "data": {
    "businessCount": 2,
    "groupCount": 1,
    "item": [
      {
        "businessId": 1001,
        "businessName": "研发部",
        "type": 1,
        "platformId": "1",
        "children": [
          {"businessId": 1002, "businessName": "前端研发组", "type": 0, "platformId": "1"},
          {"businessId": 1003, "businessName": "后端研发组", "type": 0, "platformId": "1"}
        ]
      }
    ]
  }
}
```

### 示例4：跨平台查询业务组树

**请求示例**（通过 `platformIds` 跨平台查询，注意该参数由装饰器处理，不在 schema 中显式声明）：
```json
{
  "platformIds": ["1", "2"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "businessCount": 10,
    "groupCount": 16,
    "item": [
      {
        "businessId": 1001,
        "businessName": "研发部",
        "type": 1,
        "platformId": "1",
        "children": [...]
      },
      {
        "businessId": 2001,
        "businessName": "运维部",
        "type": 1,
        "platformId": "2",
        "children": [...]
      }
    ]
  }
}
```

### 示例5：错误示例——传入未声明的字段

**请求示例**（`additionalProperties=false`，传入未声明的 `branchIds`）：
```json
{
  "branchIds": [100]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'Additional properties are not allowed (branchIds)'>",
  "data": null
}
```

### 示例6：错误示例——鉴权失败（无 superAdmin/assetQuery/assetGroupQuery 策略）

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

- `search` maxLength=95，建议传入简短关键字
- `needAll` 为 boolean
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段（`search`/`needAll` 之外的字段会被拒绝）
- 跨平台参数 `platformIds`/`platformIDs` 由 `v1_open_api_validate` 装饰器处理，不在 schema 中显式声明但可传入

### 参数依赖关系

- `needAll` 与 `search` 互斥影响：`needAll=true` 且 `search` 非空时不插入"全部组"虚拟节点
- `search` 影响 `businessCount` 与 `groupCount`：搜索时仅统计匹配的业务组与业务系统
- 跨平台查询时各平台独立查询，结果合并，`businessCount`/`groupCount` 为所有平台的总和
- `needAll=true` 时 `groupCount` 含"全部组"虚拟节点（`+1`），调用方在统计真实业务组数量时需扣除

### 权限要求

- `@auth_expr(expression='hasPolicies("superAdmin") || hasPolicies("assetQuery") || hasPolicies("assetGroupQuery")')`，**要求 `superAdmin`、`assetQuery` 或 `assetGroupQuery` 策略角色**，三者满足其一即可
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- 跨平台查询通过 `platformIds`/`platformIDs` 参数 + `cascade_query_init` 实现

### 性能建议

- `AssetGroupDao.get_groups_by_filter` 使用 `allow_disk_use=True`，业务组数量过大时可能使用磁盘临时文件
- 业务组树构造在内存中完成，业务组数量过多（万级）时内存与 CPU 开销较大，建议通过 `search` 缩小范围
- 跨平台查询时各平台独立查询，性能随平台数线性增长
- `needAll=true` 时树深度增加 1 层，前端渲染时需考虑性能

### 数据一致性说明

- **响应外壳为 `v1_open_api_output`**：本接口虽为 v2 内部接口，但响应使用 `v1_open_api_output({code, message, data})`，调用方通过 `code` 字段判断成功（成功时 `code="Success"`）
- **字段命名转换**：请求参数驼峰转下划线（业务函数内），响应下划线转驼峰（`@transform_openapi_input_output` 装饰器）；`businessId`/`businessName` 在 `field_name_format` 中已重命名为驼峰，最终响应字段为驼峰
- **未归类组名称本地化**：`businessId=-1` 的节点 `businessName` 被强制替换为本地化的"未归类组"，不返回数据库原始名称（可能为 "default"）
- **"全部组"虚拟节点 `businessId=0`**：与真实业务组 ID（`groupId` 从 `GROUP_ID_START` 开始）不冲突，调用方需特殊处理 `businessId=0` 的节点
- **`needAll=true` 时 `groupCount` 含虚拟节点**：调用方统计真实业务组数量时需 `groupCount - 1`
- **`type` 字段含义**：`0`=业务系统（BUSINESS），`1`=业务组（GROUP）；与部分接口的 `type` 含义可能不同，调用方需以本接口定义为准
- **已删除业务组不返回**：`GROUP_DELETE_TIME_FILTER` 排除已逻辑删除的业务组

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `search: maxLength 95`、`needAll: must be boolean`、`Additional properties are not allowed`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/长度约束；注意 `additionalProperties=false` |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常（如 `AssetGroupDao.get_groups_by_filter` 失败、`get_group_tree` 构造失败） | 联系运维检查 MongoDB 连接与业务组数据完整性 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 查询超时、内存溢出（业务组数量过大） | 通过 `search` 缩小范围，联系运维检查 MongoDB 索引与业务组数据规模 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录、登录态失效或无 `superAdmin`/`assetQuery`/`assetGroupQuery` 策略 | 重新登录或联系管理员授予 `assetQuery` 或 `assetGroupQuery` 策略 |

## 最佳实践

1. **业务组选择器用 `needAll=true`**：业务组选择器场景下传 `needAll=true`，在顶部展示"全部组"虚拟节点，便于用户选择全部业务组
2. **搜索场景不传 `needAll`**：搜索时 `needAll` 实际不生效（不插入虚拟节点），避免无效参数
3. **`search` 关键字简短**：`search` maxLength=95，建议传入简短关键字（如"研发"而非完整业务组名），提升匹配率
4. **`groupCount` 统计注意虚拟节点**：`needAll=true` 时 `groupCount` 含"全部组"虚拟节点，统计真实业务组数量时需 `groupCount - 1`
5. **`businessId=0` 特殊处理**：调用方需特殊处理 `businessId=0` 的"全部组"虚拟节点，避免将其作为真实业务组 ID 用于资产查询
6. **`businessId=-1` 为未归类组**：未归类组名称已被本地化，调用方不应依赖原始名称
7. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时 `code="Success"`），`data.item` 含业务组树
