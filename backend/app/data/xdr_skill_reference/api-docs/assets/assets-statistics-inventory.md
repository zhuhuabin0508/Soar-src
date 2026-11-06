# POST /api/xdr/v1/assets/statistics/inventory

## 接口概述

本接口用于按指定资产清单类型（端口、软件、Web 框架、Web 应用、Web 站点、账号、进程等）对资产进行分组聚合统计，返回每组元素的资产数量 Top N。数据来源于资产清单子表（`A_Port`、`A_Software`、`A_WebFrame` 等），通过 MongoDB 聚合管道 `$match` → `$group` → `$sort` → `$limit` 实现。

### 支持的资产清单类型
- **网络端口**：port → `A_Port`
- **软件/数据库/Web 服务**：software / database / web_service → `A_Software`
- **Web 框架**：web_frame → `A_WebFrame`
- **Web 应用**：web_app → `A_WebApp`
- **Web 站点**：web_site → `A_WebSite`
- **账号**：account → `A_Account`
- **进程**：process → `A_Process`
- 其他类型（services、regedits、crontabs、bootitems、softwares 等）详见 `view/inventory/business_abs.py` 中 `TAB_INFOS` 定义

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1Inventory` |
| 所属业务域 | 资产统计 / 资产清单分组聚合 |
| 接口分类 | 数据查询（聚合统计，无写入） |
| 前置依赖 | `type` 必须为 `TAB_INFOS` 中已定义的清单类型；若传入 `branchIds`，机构 ID 应存在 |
| 关联接口 | `POST /api/xdr/v1/assets/total`（资产总数统计）、`POST /api/xdr/v1/assets/statistics/branch/tag`（按机构+标签聚合） |

## 使用场景

1. **端口分布统计**：统计资产上开放端口分布 Top N（如 80、443、22 等高频端口）
2. **软件资产盘点**：统计安装某软件的资产数，用于软件合规性分析
3. **Web 资产清单**：按 Web 框架/应用/站点聚合，了解 Web 资产技术栈分布
4. **账号分布分析**：统计资产账号分布，识别重复账号或默认账号
5. **进程分布分析**：统计资产运行进程分布，用于异常进程识别
6. **按机构过滤统计**：传入 `branchIds` 时，先查 `Asset` 集合获取机构下资产 ID，再聚合子表

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/statistics/inventory |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/statistics/inventory` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/statistics/inventory`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/statistics/views.py:22`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.WEB_INVENTORY)` 校验请求体，必填 `type`（字符串），可选 `branchIds`（整数数组）、`page`（整数）、`pageSize`（整数）。校验失败抛 `V1_INVALID_PARAMETER`（HTTP 400）。
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，`@trans_ctx_pid_query(PlatformMode.SELF)` 注入平台级查询上下文（SELF 模式：仅限本平台）。
3. **业务函数 `business.get_inventory(data)` 调用**（源码 `statistics/business.py:19`）：
   1. **默认值注入**：`page` 默认 1，`pageSize` 默认 10，`type` 默认 `"web_frame"`（注意：实际 schema 必填 `type`，调用方必须传入，默认值仅在内部转换层兜底）。
   2. **解析清单子表配置**：从 `TAB_INFOS`（`view/inventory/business_abs.py:46`）按 `type` 查询对应配置，包含 `dao`（子表 DAO 类）、`group_keys`（分组字段）、`convert_keys`、`match`、`search` 等。
   3. **机构过滤（可选）**：若 `branchIds` 非空：
      - 调用 `AssetDao.find({"branch_id": {"$in": branchIds}})` 查询 `Asset` 集合中属于指定机构的资产 ID 列表
      - 将 `filters["asset_id"] = {"$in": asset_ids}` 注入聚合管道的 `$match` 阶段
   4. **MongoDB 聚合管道执行**（在子表 DAO 的 `coll` 上）：
      - `$match`：应用过滤条件
      - `$group`：按 `group_keys[0]` 分组，`$sum: 1` 统计每组数量
      - `$sort`：按 `sum` 降序
      - `allowDiskUse=True`：允许大数据集使用磁盘排序
   5. **结果构造**：将聚合结果转换为 `[{name, num}]` 列表，按 `page`/`pageSize` 分页切片
   6. **返回**：`{data: [...], total: len}` —— `data` 为分页后的列表，`total` 为聚合结果总长度
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认成功，`message` 默认为 `message.open_api.success.default`。

### 数据转换逻辑

- **`type` → DAO 映射**：`type` 字符串通过 `TAB_INFOS` 字典映射到对应的子表 DAO 和分组字段，例如 `port` → `AssetPortDao` + `A_Port` 集合，分组键为端口号
- **`branchIds` → asset_ids 转换**：`branchIds` 不能直接过滤子表，需先查 `Asset` 集合获取资产 ID 列表，再用 `asset_id` 字段过滤子表
- **`update_time` 等时间字段**：本接口不涉及时间字段，但子表中可能含 `first_seen`/`last_seen` 等字段，本接口不返回

### 默认行为

- `page` 缺省 → 1
- `pageSize` 缺省 → 10
- `type` 缺省 → `"web_frame"`（但 schema 必填，调用方必须传）
- `branchIds` 缺省 → 不做机构过滤，对所有资产统计
- 聚合结果按数量降序排列

### 特殊规则

- **`type` 必须为 `TAB_INFOS` 中已定义的值**：传入未定义的 `type` 会触发 `KeyError`，被异常处理中间件转换为 `V1_UNKNOWN`/`V1_SYSTEM_ERROR`
- **`branchIds` 过滤是间接的**：先查 `Asset` 集合获取 asset_ids，再过滤子表，若机构下资产数量过大可能影响性能
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **聚合使用 `allowDiskUse=True`**：大数据集会使用磁盘临时文件，可能影响查询耗时

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| type | string | 是 | "web_frame"（内部默认） | 资产清单类型，必须为 `TAB_INFOS` 中已定义的值：`port`/`software`/`database`/`web_service`/`web_frame`/`web_app`/`web_site`/`account`/`process`/... | "port" |
| branchIds | array | 否 | 无 | 元素为 integer，机构 ID 列表；传入后只统计指定机构下资产 | [100, 101] |
| page | integer | 否 | 1 | 页码，从 1 开始 | 1 |
| pageSize | integer | 否 | 10 | 每页条数 | 20 |

#### type 枚举值说明

| 值 | 含义 | 对应集合 | 分组键 |
|----|------|---------|--------|
| port | 网络端口 | A_Port | 端口号 |
| software | 软件 | A_Software | 软件名 |
| database | 数据库 | A_Software | 数据库名 |
| web_service | Web 服务 | A_Software | 服务名 |
| web_frame | Web 框架 | A_WebFrame | 框架名 |
| web_app | Web 应用 | A_WebApp | 应用名 |
| web_site | Web 站点 | A_WebSite | 站点名 |
| account | 账号 | A_Account | 账号名 |
| process | 进程 | A_Process | 进程名 |

> 注：完整 `TAB_INFOS` 定义见源码 `view/inventory/business_abs.py:46+`，可能包含 services、regedits、crontabs、bootitems 等扩展类型。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值（默认 `message.open_api.success.default`） |
| message | string | 国际化文案 key，成功时为 `"message.open_api.success.default"` |
| data | object | 聚合统计结果，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| data | array | 分页后的聚合结果列表，元素结构见下 |
| total | integer | 聚合结果总条数（未分页前） |

#### data 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| name | string | 分组键值（如端口号 "80"、软件名 "nginx"） |
| num | integer | 该分组下的资产数量 |

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "data": [
      {"name": "80", "num": 156},
      {"name": "443", "num": 132},
      {"name": "22", "num": 98}
    ],
    "total": 28
  }
}
```

## 调用示例

### 示例1：统计所有资产的端口分布 Top 10

**请求示例**：
```json
{
  "type": "port"
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "data": [
      {"name": "80", "num": 156},
      {"name": "443", "num": 132},
      {"name": "22", "num": 98},
      {"name": "3389", "num": 76},
      {"name": "3306", "num": 54},
      {"name": "8080", "num": 45},
      {"name": "21", "num": 32},
      {"name": "25", "num": 28},
      {"name": "53", "num": 22},
      {"name": "4443", "num": 18}
    ],
    "total": 28
  }
}
```

### 示例2：按机构过滤统计 Web 框架分布 Top 20

**请求示例**：
```json
{
  "type": "web_frame",
  "branchIds": [100, 101],
  "page": 1,
  "pageSize": 20
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "data": [
      {"name": "Spring", "num": 45},
      {"name": "Django", "num": 28},
      {"name": "React", "num": 22},
      {"name": "Vue", "num": 18}
    ],
    "total": 15
  }
}
```

### 示例3：错误示例——缺少必填字段

**请求示例**（缺少 `type`）：
```json
{
  "page": 1,
  "pageSize": 10
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'type: required'>",
  "data": null
}
```

### 示例4：错误示例——type 不在 TAB_INFOS 中

**请求示例**（`type="unknown_type"`）：
```json
{
  "type": "unknown_type"
}
```

**错误响应示例**（HTTP 500，业务层 KeyError 转换）：
```json
{
  "code": "V1_SYSTEM_ERROR",
  "message": "<系统错误信息>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `type` 必填，必须为 `TAB_INFOS` 中已定义的清单类型
- `branchIds` 元素必须为 integer 类型
- `page`/`pageSize` 必须为 integer 类型，建议 `page >= 1`，`pageSize` 在 1-100 之间
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `type` 决定子表 DAO 和分组键，必须与期望的清单类型匹配
- `branchIds` 可选，传入后只统计指定机构下资产；未传则统计所有资产

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据

### 性能建议

- 子表聚合使用 `allowDiskUse=True`，大数据集（百万级）可能耗时较长，建议传入 `branchIds` 缩小范围
- `branchIds` 过滤是间接的（先查 `Asset` 集合再过滤子表），机构下资产数量过大会增加前置查询开销
- `pageSize` 建议不超过 100，过大响应体会拖慢传输

### 数据一致性说明

- **响应 `total` 是聚合后总条数**：不是资产总数，而是分组后不同分组键的数量
- **`name` 字段类型**：聚合后分组键统一转字符串返回，调用方应按字符串消费
- **空结果**：若没有匹配的资产，`data` 为空数组，`total` 为 0

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `type: required`、`branchIds: must be array`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常 | 联系运维检查服务状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | `type` 不在 `TAB_INFOS` 中触发 `KeyError`，或子表 DAO 查询失败 | 确认 `type` 为 `TAB_INFOS` 中已定义的值；联系运维检查 MongoDB 连接 |

## 最佳实践

1. **`type` 严格使用枚举值**：传入未定义的 `type` 会导致 500 错误，调用方应硬编码已知类型
2. **`branchIds` 缩小范围**：大数据集场景下传入 `branchIds` 可显著提升查询性能
3. **`pageSize` 合理设置**：建议 10-100，过大响应体影响传输性能
4. **响应 `total` 解释**：`total` 是分组后不同分组键的数量，不是资产总数；调用方需要资产总数应使用 `POST /api/xdr/v1/assets/total` 接口
5. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含聚合结果
