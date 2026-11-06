# POST /api/xdr/v1/assets/statistics/branch/tag

## 接口概述

本接口用于按标签（tag）统计各机构下资产数量 Top N，返回机构资产数量排行榜。数据来源 `Asset` 集合，通过 MongoDB 聚合管道 `$match` → `$group` → `$sort` → `$limit` 实现按机构分组的资产计数。

### 可查询的统计数据
- **机构资产数量排行**：按指定标签过滤后，统计每个机构的资产数量，按数量降序返回 Top N
- **机构名称**：返回机构 ID 与名称的对应关系
- **最近更新时间**：返回该机构下资产最近一次更新时间

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1BranchTag` |
| 所属业务域 | 资产统计 / 机构资产数量排行 |
| 接口分类 | 数据查询（聚合统计，无写入） |
| 前置依赖 | `tag` 应为系统中已存在的标签（缺省时使用"暴露面"标签） |
| 关联接口 | `POST /api/xdr/v1/assets/statistics/inventory`（清单聚合）、`POST /api/xdr/v1/assets/statistics/change/trend`（趋势分析） |

## 使用场景

1. **机构资产排行**：统计各机构资产数量，识别资产规模较大的机构
2. **按标签过滤统计**：传入特定标签（如"暴露面"），统计具有该标签的资产在各机构的分布
3. **资产盘点报告**：生成机构维度的资产盘点报告
4. **安全大盘展示**：用于安全大盘展示机构资产规模排行
5. **运维重点识别**：识别资产数量多的机构，作为运维重点

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/statistics/branch/tag |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/statistics/branch/tag` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/statistics/branch/tag`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/statistics/views.py:31`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.WEB_BRANCH_TAG)` 校验请求体，所有字段可选。校验失败抛 `V1_INVALID_PARAMETER`（HTTP 400）。
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，`@trans_ctx_pid_query(PlatformMode.SELF)` 注入平台级查询上下文（SELF 模式）。
3. **业务函数 `business.get_branch_tag(data)` 调用**（源码 `statistics/business.py:39`）：
   1. **默认值注入**：`top` 默认 10，`tag` 默认 `Identity.Tag.ExposedSurface.translate()`（暴露面标签的国际化文案）。
   2. **过滤条件构造**：
      - `$and: [{tag: {$in: [tag]}}, {belong_host: 0}]` —— 必须包含指定标签且为主资产（`belong_host == 0`）
      - 调用 `AssetDao.get_using_asset_filter(filters)` 注入 `manage_status $in ManageStatus.IN_DEPOT_LIST`，过滤入库状态资产
      - 可选追加 `branch_id $in branchIds` 过滤机构范围
   3. **机构名称映射**：调用 `BranchDao.get_id_name_map()` 查询 `Branch` 集合，构造 `{branch_id: name}` 映射表。
   4. **MongoDB 聚合管道执行**（在 `AssetDao.coll` 上）：
      - `$match`：应用过滤条件（tag、belong_host、manage_status、branch_id）
      - `$group`：按 `branch_id` 分组，`$sum: 1` 统计资产数量，`$max: update_time` 取最大更新时间
      - `$sort`：按 `sum` 降序
      - `$limit top`：限制返回条数
      - `allowDiskUse=True`：允许大数据集使用磁盘排序
   5. **结果构造**：将聚合结果转换为 `[{branchId, branchName, assetNum, updateTime}]` 列表：
      - `branchName` 来自第 3 步的机构名称映射
      - `updateTime` 乘以 1000 转毫秒级
   6. **返回**：列表直接作为 `data` 返回
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`。

### 数据转换逻辑

- **`tag` 默认值**：未传入时默认为 `Identity.Tag.ExposedSurface.translate()`（暴露面标签），调用方不传 `tag` 时只统计暴露面资产
- **`updateTime` 单位转换**：MongoDB 中 `update_time` 为秒级 10 位时间戳，响应中乘以 1000 转为毫秒级 13 位时间戳
- **`belong_host == 0` 过滤**：仅查询主资产，不包含网侧资产
- **`manage_status` 过滤**：仅统计入库状态（`IN_DEPOT_LIST`）的资产，出库/审批中的资产不计入

### 默认行为

- `top` 缺省 → 10
- `tag` 缺省 → `Identity.Tag.ExposedSurface.translate()`（暴露面标签）
- `branchIds` 缺省 → 不做机构范围过滤
- 聚合结果按资产数量降序排列

### 特殊规则

- **`top` 控制返回条数**：未传默认 10，传入则按指定值返回 Top N
- **`tag` 默认为暴露面**：调用方不传 `tag` 时只统计暴露面资产，统计全部资产需传入空标签或其他标签
- **`branchIds` 缩小机构范围**：传入后只统计指定机构的资产，机构 ID 必须存在
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **聚合使用 `allowDiskUse=True`**：大数据集会使用磁盘临时文件

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| top | integer | 否 | 10 | 返回 Top N 条数，建议 1-100 | 20 |
| branchIds | array | 否 | 无 | 元素为 integer，机构 ID 列表；传入后只统计指定机构 | [100, 101] |
| tag | string | 否 | "暴露面"（Identity.Tag.ExposedSurface.translate()） | 资产标签，需为系统中已存在的标签 | "exposed_surface" |

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值 |
| message | string | 国际化文案 key，成功时为 `"message.open_api.success.default"` |
| data | array | 机构资产数量排行列表，元素结构见下 |

### data 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| branchId | integer | 机构 ID |
| branchName | string | 机构名称（来自 `Branch` 集合 `name` 字段） |
| assetNum | integer | 该机构下符合标签过滤条件的资产数量 |
| updateTime | integer | 该机构下资产最近一次更新时间（毫秒级 13 位时间戳） |

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "branchId": 100,
      "branchName": "总部",
      "assetNum": 156,
      "updateTime": 1724515200000
    },
    {
      "branchId": 101,
      "branchName": "分公司A",
      "assetNum": 98,
      "updateTime": 1724428800000
    },
    {
      "branchId": 102,
      "branchName": "分公司B",
      "assetNum": 45,
      "updateTime": 1724342400000
    }
  ]
}
```

## 调用示例

### 示例1：默认统计暴露面资产 Top 10

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {"branchId": 100, "branchName": "总部", "assetNum": 156, "updateTime": 1724515200000},
    {"branchId": 101, "branchName": "分公司A", "assetNum": 98, "updateTime": 1724428800000}
  ]
}
```

### 示例2：按自定义标签统计 Top 20

**请求示例**：
```json
{
  "top": 20,
  "tag": "core_asset"
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {"branchId": 100, "branchName": "总部", "assetNum": 45, "updateTime": 1724515200000},
    {"branchId": 101, "branchName": "分公司A", "assetNum": 28, "updateTime": 1724428800000}
  ]
}
```

### 示例3：按机构范围统计

**请求示例**：
```json
{
  "top": 5,
  "branchIds": [100, 101, 102]
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {"branchId": 100, "branchName": "总部", "assetNum": 156, "updateTime": 1724515200000},
    {"branchId": 101, "branchName": "分公司A", "assetNum": 98, "updateTime": 1724428800000},
    {"branchId": 102, "branchName": "分公司B", "assetNum": 45, "updateTime": 1724342400000}
  ]
}
```

### 示例4：错误示例——参数类型错误

**请求示例**（`top` 传字符串）：
```json
{
  "top": "ten"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'top: must be integer'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `top` 必须为 integer 类型，建议 1-100，过大响应体影响传输
- `branchIds` 元素必须为 integer 类型
- `tag` 必须为 string 类型，建议使用系统中已存在的标签
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `tag` 与 `branchIds` 可组合使用：先按标签过滤，再按机构范围缩小
- `top` 控制返回条数，与 `branchIds` 长度无关（`branchIds` 长度可大于 `top`）

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据

### 性能建议

- `top` 建议不超过 100，过大响应体影响传输
- `branchIds` 传入可缩小查询范围，减少聚合管道数据量
- 聚合使用 `allowDiskUse=True`，大数据集可能耗时较长

### 数据一致性说明

- **`assetNum` 是符合条件的资产数**：按 `tag`、`belong_host=0`、`manage_status $in IN_DEPOT_LIST`、`branchIds`（可选）过滤后的资产数量
- **`updateTime` 是毫秒级**：MongoDB 中 `update_time` 为秒级，响应中 *1000 转毫秒
- **`branchName` 来自 `Branch` 集合**：若机构已删除，`branchName` 可能为空或显示历史名称
- **`tag` 默认暴露面**：调用方不传 `tag` 时只统计暴露面资产，不是全部资产
- **`belong_host == 0` 过滤**：仅统计主资产，不包含网侧资产

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `top: must be integer`、`branchIds: must be array`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常 | 联系运维检查服务状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 聚合管道异常或 `Branch` 集合查询失败 | 联系运维检查 MongoDB 连接 |

## 最佳实践

1. **`tag` 显式传入**：默认暴露面标签不一定符合业务需求，建议显式传入期望的标签
2. **`top` 合理设置**：建议 10-100，过大响应体影响传输性能
3. **`branchIds` 缩小范围**：机构较多时传入 `branchIds` 提升查询性能
4. **响应 `updateTime` 是毫秒级**：调用方前端展示需 /1000 转秒或保持毫秒
5. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含排行列表
6. **`assetNum` 含义**：是符合标签过滤条件的资产数，不是机构资产总数；如需总数应使用 `POST /api/xdr/v1/assets/total`
