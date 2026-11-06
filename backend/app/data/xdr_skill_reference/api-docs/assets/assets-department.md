# GET /api/xdr/v1/assets/department

## 接口概述

本接口用于查询 XDR 资产管理系统中可用的机构（部门）树结构。通过本接口，您可以获取当前登录用户可见地域内的所有机构节点（含父子层级、节点 ID、节点名称、是否叶子节点等），用于资产新增、责任人归属等场景下拉选机构 ID。

### 可查询的机构信息
- **机构节点基础信息**：id（机构 ID）、depName（机构名称）、pGid（父机构 ID）、pName（父机构名称）、leaf（是否叶子节点）
- **机构树层级**：children 数组，递归构建的子机构列表
- **未分配机构节点**：当传入 `getUndistributed` 时，列表头部插入一个"未分配部门"虚拟节点，ID 为根部门 ID（`ROOT_DEPARTMENT_ID = 1`）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1Department` |
| 所属业务域 | 组织架构 / 机构树查询 |
| 接口分类 | 数据查询（无写入，纯读 MongoDB `AssetSystemGroup` 集合） |
| 前置依赖 | 无（可直接调用）；调用 `POST /api/xdr/v1/assets` 前建议先调用本接口获取有效 `branchId` |
| 关联接口 | `POST /api/xdr/v1/assets`（资产新增，使用 `branchId`） |

## 使用场景

1. **资产新增前获取有效机构 ID**：调用 `POST /api/xdr/v1/assets` 前先调用本接口，从机构树中选取有效的 `branchId`，避免传入不存在的机构 ID 触发 `Message.Branch.Operation.Select` 错误
2. **资产归属机构选择**：在新增资产（`POST /api/xdr/v1/assets`）或修改资产所属机构前，调用本接口获取可选机构列表
3. **机构层级展示**：在前端或第三方系统中展示组织架构树形结构，支持父子层级展开
4. **排除指定机构**：通过 `excludeGid` 参数排除某个机构节点（连同其子树）以查看其他机构结构
5. **未分配机构场景**：通过 `getUndistributed=1` 在返回列表头部插入"未分配部门"虚拟节点，便于资产/责任人选择"未分配"归属

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/department |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression="")` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/department` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/department`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/department/views.py:25`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.GET_DEPARTMENT_REQ)` 校验 query 参数。所有参数均为可选字符串，且 `getUndistributed`/`excludeGid` 必须满足正则 `[0-9]+$`（纯数字结尾），`viewRegionId` 必须满足 `maxLength=24`。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`，返回 HTTP 400。
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，`@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（SELF 模式：仅限本平台）。
3. **业务函数 `business.get_department(data)` 调用**（源码 `department/business.py:20`）：
   1. **数据类型转换 `transform_department_data_type(data)`**：将 query 字符串 `getUndistributed`、`excludeGid` 转换为 int 类型，便于后续业务层判断与传参。
   2. **参数驼峰转下划线 `transform_params(data)`**：将 camelCase 字段名转为 snake_case，例如 `getUndistributed` → `get_undistributed`、`excludeGid` → `exclude_gid`、`viewRegionId` → `view_region_id`。
   3. **机构树查询 `get_department_tree(params)` 调用**（源码 `common/business/department.py:83`）：
      - **`get_tree_map(exclude_gid)`**：调用 `AssetSystemGroupDao.get_dep_list(exclude_gid)` 查询 MongoDB `AssetSystemGroup` 集合，过滤 `delete_time` 不存在或为 0 的机构，排除 `exclude_gid` 节点及其子树。返回字段含 `sys_group_id`、`name`、`parent_id`。
      - **`build_dep_tree(dep_list)`**：以 `id` 为 key 构建 `dep_map`，遍历每个节点建立父子关系：将子节点挂到父节点的 `children` 列表，叶子节点标记 `leaf=True`，从父节点拷贝 `p_name`；只收集 `p_gid == 1`（根部门 ID）的节点作为顶层返回。
      - **未分配机构处理**：若 `req.get('get_undistributed')` 为真值，在 `dep_tree_list` 头部插入 `{dep_name: "未分配部门"（i18n key）, children: [], id: ROOT_DEPARTMENT_ID(=1)}` 节点。
   4. **响应转换 `transform_output(...)`**：将 snake_case 字段递归转换为 camelCase，例如 `dep_name` → `depName`、`p_gid` → `pGid`、`p_name` → `pName`、`children` 元素内部字段同样转换。
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 默认为 `None`（成功时不返回 message 字段），`data` 为机构树数组。

### 数据转换逻辑

- **query 字符串 → int**：`getUndistributed`、`excludeGid` 在 `transform_department_data_type` 中显式转为 int，避免后续业务层因字符串/数字类型不一致导致的判断失败
- **camelCase → snake_case**：`transform_params` 通过正则 `(?<!^)(?=[A-Z])` 在大写字母前插入下划线并转小写，例如 `getUndistributed` → `get_undistributed`、`excludeGid` → `exclude_gid`、`viewRegionId` → `view_region_id`
- **snake_case → camelCase（响应）**：`transform_output` 通过 `underscore_to_camelcase` 将下划线字段名转为驼峰，例如 `dep_name` → `depName`、`p_gid` → `pGid`、`sys_group_id` → `sysGroupId`（但本接口不返回 `sys_group_id`，DAO 返回字段已在 `get_dep_list` 中重命名为 `id`）
- **DAO 字段映射**：DAO 返回 `{sys_group_id, name, parent_id}`，在 `get_dep_list`（business 层）中被映射为 `{id, dep_name, p_gid}`，再经 `transform_output` 转为 `{id, depName, pGid}`

### 默认行为

- 不传 `excludeGid` → 不排除任何机构，返回完整机构树
- 不传 `getUndistributed` → 不在头部插入"未分配部门"虚拟节点
- 不传 `viewRegionId` → 按当前用户默认数据域过滤（受 `@trans_ctx_pid_query` 注入的上下文影响）
- 顶层返回只包含 `p_gid == 1`（根部门）的节点，子节点嵌套在 `children` 数组中

### 特殊规则

- **`excludeGid` 同时排除节点与其子树**：DAO 层过滤条件为 `{'sys_group_id': {'$ne': exclude_gid}, 'parent_id': {'$ne': exclude_gid}}`，即排除该节点本身以及直接挂在该节点下的子节点（深度仅一层，深层子节点会因父节点已被排除而失去挂载点，最终不会出现在树中）
- **根部门固定 ID 为 1**：`ROOT_DEPARTMENT_ID = 1`，`build_dep_tree` 只把 `p_gid == 1` 的节点作为顶层返回
- **未分配部门 ID 与根部门 ID 相同**：`DepartmentName.no_department_id = ROOT_DEPARTMENT_ID = 1`，但语义不同，分别表示"根部门"和"未分配部门"
- **`additionalProperties=false`**：query 参数不允许出现 schema 中未声明的字段，否则 schema 校验失败
- **空树返回空数组**：若用户没有任何机构数据，`build_dep_tree` 返回 `[]`，最终 `data` 为 `[]`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求通常不需要，建议传 application/json |

### 请求体参数（Query String）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| getUndistributed | string | 否 | 无 | pattern=`[0-9]+$`（纯数字结尾）；非 0 表示在返回列表头部插入"未分配部门"虚拟节点 | "1" |
| excludeGid | string | 否 | 无 | pattern=`[0-9]+$`（纯数字结尾）；要排除的机构 ID，同时排除其子树 | "100" |
| viewRegionId | string | 否 | 无 | maxLength=24；数据域 ID，用于按地域过滤可见机构 | "1" |

#### viewRegionId 说明

`viewRegionId` 用于跨地域场景下指定要查询的数据域 ID。传入后业务层会按该地域过滤机构；不传则按当前用户上下文的默认数据域过滤。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"` |
| message | string | 国际化文案 key，成功时省略（`v1_open_api_output` 在 message 为 None 时不输出该字段） |
| data | array | 机构树顶层节点列表，元素结构见下 |

### data 元素结构说明

#### 机构节点信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | integer | 机构 ID（DAO 字段 `sys_group_id`） | 正整数 | 100 |
| depName | string | 机构名称 | 任意字符串 | "研发一部" |
| pGid | integer | 父机构 ID | 正整数，根节点父 ID 为 1 | 1 |
| pName | string/null | 父机构名称；顶层节点为 null | 字符串或 null | "总公司" |
| leaf | boolean/null | 是否叶子节点；非叶子节点为 null 或不存在 | true/null | true |
| children | array | 子机构列表，递归结构同顶层元素；叶子节点无此字段或为空 | 数组 | [{...}] |

> 注：当 `getUndistributed=1` 时，列表第 0 个元素为"未分配部门"虚拟节点，结构为 `{depName: "<未分配部门 i18n 文案>", children: [], id: 1}`。

### 响应示例

```json
{
  "code": "Success",
  "data": [
    {
      "id": 100,
      "depName": "总公司",
      "pGid": 1,
      "pName": null,
      "children": [
        {
          "id": 101,
          "depName": "研发一部",
          "pGid": 100,
          "pName": "总公司",
          "leaf": true
        },
        {
          "id": 102,
          "depName": "研发二部",
          "pGid": 100,
          "pName": "总公司",
          "children": [
            {
              "id": 1021,
              "depName": "前端组",
              "pGid": 102,
              "pName": "研发二部",
              "leaf": true
            }
          ]
        }
      ]
    }
  ]
}
```

## 调用示例

### 示例1：获取完整机构树

**请求示例**：
```
GET /api/xdr/v1/assets/department
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "id": 100,
      "depName": "总公司",
      "pGid": 1,
      "pName": null,
      "children": [
        {
          "id": 101,
          "depName": "研发一部",
          "pGid": 100,
          "pName": "总公司",
          "leaf": true
        },
        {
          "id": 102,
          "depName": "研发二部",
          "pGid": 100,
          "pName": "总公司",
          "leaf": true
        }
      ]
    }
  ]
}
```

### 示例2：在头部插入未分配部门虚拟节点

**请求示例**：
```
GET /api/xdr/v1/assets/department?getUndistributed=1
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "id": 1,
      "depName": "未分配部门",
      "children": []
    },
    {
      "id": 100,
      "depName": "总公司",
      "pGid": 1,
      "pName": null,
      "children": [
        {
          "id": 101,
          "depName": "研发一部",
          "pGid": 100,
          "pName": "总公司",
          "leaf": true
        }
      ]
    }
  ]
}
```

### 示例3：排除指定机构 ID 及其子树

**请求示例**：
```
GET /api/xdr/v1/assets/department?excludeGid=102
```

**响应示例**：
```json
{
  "code": "Success",
  "data": [
    {
      "id": 100,
      "depName": "总公司",
      "pGid": 1,
      "pName": null,
      "children": [
        {
          "id": 101,
          "depName": "研发一部",
          "pGid": 100,
          "pName": "总公司",
          "leaf": true
        }
      ]
    }
  ]
}
```

### 示例4：错误示例——`getUndistributed` 非数字

**请求示例**：
```
GET /api/xdr/v1/assets/department?getUndistributed=abc
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'getUndistributed: pattern not match'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `getUndistributed`、`excludeGid` 必须满足正则 `[0-9]+$`（以数字结尾），非数字字符串会触发 schema 校验失败
- `viewRegionId` 最大长度 24 字符
- `additionalProperties=false`，query 参数不允许出现 schema 中未声明的字段

### 参数依赖关系

- `excludeGid` 与 `getUndistributed` 互相独立，可同时使用
- `excludeGid` 传入的 ID 必须为系统中已存在的机构 ID，传入不存在的 ID 不会报错，但实际不排除任何节点
- `viewRegionId` 与当前用户的数据域权限共同决定可见机构范围

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 限制查询为本平台数据，跨平台调用会失败

### 性能建议

- `get_dep_list` 一次性从 MongoDB 拉取所有未删除机构后在内存中构建树，机构数量过大（万级以上）时内存与耗时较高，建议通过 `excludeGid` 或数据域权限缩小范围
- 机构树构建为 CPU 密集型操作（双层循环 + 嵌套挂载），大量节点场景下可能耗时较长

### 数据一致性说明

- **响应不含 `sys_group_id` 字段**：DAO 返回的 `sys_group_id` 在业务层重命名为 `id`，调用方应通过 `id` 字段消费机构 ID，不要期望返回 `sys_group_id`
- **响应字段名采用驼峰**：`depName`、`pGid`、`pName`，调用方不应使用下划线命名消费
- **顶层节点判定**：只有 `p_gid == 1` 的节点会出现在顶层，根部门 ID 固定为 1，调用方不应假设其他父 ID 的节点会出现在顶层
- **空树返回空数组**：若用户没有任何可见机构，`data` 为 `[]`，不是 `null`

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `getUndistributed: pattern not match`、`viewRegionId: maxLength exceed`） | 请求参数不符合 JSON Schema 约束 | 按错误信息修正 query 参数，对照"请求参数"段检查类型/正则/长度约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常（DAO 查询失败、机构树构建异常等） | 联系运维检查服务状态与 MongoDB 连接 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | 服务内部异常（如数据库不可用） | 联系运维检查 MongoDB 连接与服务可用性 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **资产新增前先调用本接口**：调用 `POST /api/xdr/v1/assets` 前先调用本接口，从返回的 `id` 字段选取有效 `branchId`，避免传入不存在的机构 ID 触发 `Message.Branch.Operation.Select`
2. **`getUndistributed=1` 用于未分配场景**：在新增责任人或资产时，若需要支持"未分配部门"选项，应传入 `getUndistributed=1` 在返回列表头部获取虚拟节点（`id=1`）
3. **`excludeGid` 用于排除子树**：在切换机构视图或权限隔离场景下，传入 `excludeGid` 排除某个机构子树，避免大量节点拖慢响应
4. **响应字段消费使用驼峰**：`depName`、`pGid`、`pName`、`children`，调用方不应期望下划线命名
5. **缓存机构树**：机构树变更频率较低，调用方可在本地缓存一段时间的机构树，减少对 OpenAPI 的调用
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`code == "Success"` 表示成功，`data` 为机构树数组
