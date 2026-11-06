# POST /api/xdr/v1/assets/inventory/ports/list

## 接口概述

本接口用于查询资产端口分布列表，按端口号 + 协议分组聚合，返回每个端口分组下开放的资产数量。通过本接口，您可以获取以下内容：

### 可查询的端口分布信息
- **端口聚合结果**：每个分组包含 `port`（端口号）、`protocol`（协议）、`regionId`（地域 ID）、`count`（资产数量）
- **分页支持**：通过 `page` 与 `pageSize` 控制返回条数
- **端口模糊搜索**：通过 `port` 字段按端口号搜索

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `PostAssetList`（`open_api/v1/resources/asset/port/__init__.py:13` / `open_api/v1/resources/asset/port/views.py:21`） |
| 所属业务域 | 资产清单 / 端口分布统计 |
| 接口分类 | 数据查询（端口分组聚合，无写入） |
| 前置依赖 | 无（可直接调用）；数据来源于 `A_Port` 集合（资产端口子表） |
| 关联接口 | `POST /api/xdr/v1/assets/statistics/inventory`（资产清单聚合统计，支持 port 等多种类型） |

## 使用场景

1. **端口分布大盘展示**：在大屏或资产总览页展示开放端口分布 Top N，识别高频端口
2. **端口安全审计**：统计开放端口分布，识别异常端口（如非业务端口 3389、22 等）
3. **端口模糊搜索**：按端口号搜索，定位特定端口的开放资产数量
4. **联动端口详情接口**：先调用本接口获取端口列表，再调用其他端口详情接口查看具体资产

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/inventory/ports/list |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/inventory/ports/list` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/inventory/ports/list`（asm.yaml 第 134-147 行，v1 assets wildcard 映射）。源码位于 v1 模块 `open_api/v1/resources/asset/port/views.py:21`，业务委托 `asset_web/app/view/inventory/ports/business.py:46` 的 `Business.get_ports_count`，底层 DAO 调用 `AssetPortDao.get_group_count`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.WEB_POST_ASSET_LIST)` 校验请求体符合 JSON Schema 约束（详见"请求参数"段）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`。
2. **登录鉴权**：`@auth_expr(expression="")` 校验登录态（鉴权失败返回 `ACCESS_DENY_RESPONSE`）。
3. **参数预处理**（源码 `open_api/v1/resources/asset/port/views.py:25`）：
   - `port_search = str(data.get('port', ''))` —— 端口号转为字符串
   - `offset = (page - 1) * pageSize` —— 计算分页偏移量
   - `limit = pageSize` —— 每页条数
   - 构造 `data = {"port_search": ..., "offset": ..., "limit": ...}` 传给业务函数
4. **业务函数 `Business.get_ports_count(data)` 调用**（源码 `view/inventory/ports/business.py:46`）：
   1. **端口搜索参数校验**：调用 `validators.validate_ports_count(data)`（源码 `view/inventory/ports/validators.py:8`）：
      - 端口搜索字符串 `port_search` `strip()` 后若非空，尝试 `int()` 转换，失败抛 `FrontendError(ERROR.DEFAULT_ERROR, msg=Message.Port.Restrict.message())`
      - 端口号范围校验：`< 0` 或 `> 65535` 抛同样错误
      - 返回转换后的 `port_search`（int 或空字符串）
   2. **加载子表配置**：`dao, group_keys, convert_keys, _match, _ = TAB_INFOS.get("port")`（源码 `view/inventory/business_abs.py:46`）：
      - `dao` = `AssetPortDao`（`A_Port` 集合）
      - `group_keys` = `["number", "protocol", "region_id"]`（按端口号、协议、地域分组）
      - `convert_keys` = `["port", "protocol", "region_id"]`（输出键名映射）
      - `_match` = `{}`（无初始过滤）
   3. **构造搜索条件**：若 `port_search` 为 int，`search = {"number": port_search}`；否则 `search = {}`
   4. **DAO 聚合查询**：调用 `AssetPortDao.get_group_count(group_keys, convert_keys=convert_keys, match=_match, limit=..., offset=..., id_distinct=False, cache_key="port", search=search)`（源码 `asset_common/dao/inventory_abs.py:294`）：
      - **缓存路径**（`cache_key="port"` 非空且无外部 `match`）：
        - `match` 序列化为 JSON，调用 `get_group_count_cache`，命中缓存则直接返回
        - 缓存结果按地域 `region_id` 分组，调用方可见地域过滤后聚合 `asset_num`，按 `asset_num` 降序排序，分页切片返回
      - **非缓存路径**（传入外部 `match` 时 `cache_key=None`）：
        - 若 `get_ctx_data_regions() != "all"`，注入 `match["region_id"] = {"$in": data_regions}`
        - 构造聚合管道 `get_group_count_pipeline`（源码 `asset_common/dao/inventory_abs.py:66`）：
          - `$match`：应用过滤条件
          - `$group`：按 `group_keys` 分组，`asset_ids: {$addToSet: "$asset_id"}` 收集资产 ID
          - `$addFields`：`asset_num: {$size: "$asset_ids"}` 计算资产数
          - `$sort`：按 `asset_num` 降序、`_id.port/protocol` 升序
          - `$project`：投影 `port/protocol/region_id/asset_num`，去掉 `_id`
        - `$facet`：分两个分支计算 `total` 与 `data`（带 `$skip`/`$limit`）
        - `cls.coll.aggregate(pipeline, allowDiskUse=True)` 执行
   5. **返回**：`(data, total)` —— `data` 为分组列表，`total` 为分组总条数
5. **响应字段重命名**（源码 `port/views.py:29`）：
   - `count_res = list(map(lambda x: dict(x, **{'count': x.pop('asset_num')}), count_res))` —— 将每项的 `asset_num` 键重命名为 `count`
6. **返回**：`v1_open_api_output(data={'total': total, 'item': count_res})` —— OpenAPI 外壳 `{code, message, data}`，`data` 含 `total` 与 `item` 列表。

### 数据转换逻辑

- **入参字段重组**：API 入参 `port`/`page`/`pageSize` 被重组为 `port_search`/`offset`/`limit`，传给业务函数
- **端口搜索类型转换**：`port` 字符串在 `validate_ports_count` 中转为 int，注入 MongoDB `search = {"number": int}`
- **DAO 输出键映射**：`group_keys`（MongoDB 字段 `number`/`protocol`/`region_id`）通过 `convert_keys` 映射为输出键 `port`/`protocol`/`region_id`
- **响应键重命名**：DAO 返回的 `asset_num` 在响应中被重命名为 `count`（`x.pop('asset_num')` 后注入 `count`）

### 默认行为

- `page` 缺省 → 1
- `pageSize` 缺省 → 10（受 schema `LIMIT_NUM` 枚举限制，仅允许 `10/20/25/50/100`）
- `port` 缺省 → `""`（不按端口搜索，返回所有端口分组）
- `pageSize` 枚举限制：必须为 `10/20/25/50/100` 之一
- 缓存路径下按 `asset_num` 降序排序；非缓存路径下先按 `asset_num` 降序、再按 `_id.port/protocol` 升序
- `id_distinct=False`：聚合时使用 `asset_ids: {$addToSet: "$asset_id"}` + `$size` 计算资产数（去重计数）

### 特殊规则

- **`pageSize` 枚举严格限制**：仅允许 `10/20/25/50/100`，其他值会被 schema 拒绝
- **端口搜索范围**：`port` 字符串转 int 后必须在 `0-65535` 之间，否则抛 `Message.Port.Restrict.message()`（被转换为 `V1_UNKNOWN`）
- **缓存机制**：默认走 `cache_key="port"` 缓存路径，命中缓存时按地域过滤后聚合；缓存结果可能不实时反映最新数据
- **地域过滤**：缓存路径按 `get_ctx_data_regions()` 过滤可见地域的 `asset_num`；非缓存路径在 `$match` 阶段注入 `region_id: {$in: data_regions}`
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **`page` 最小值 0**：schema 声明 `minimum: 0`，但 `page=0` 会导致 `offset = -pageSize`，建议传 `page >= 1`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| port | string | 否 | "" | 端口号字符串，业务层会转 int 校验，必须在 0-65535 之间 | "80" |
| page | integer | 否 | 1 | minimum=0；页码，从 1 开始（schema 允许 0，但建议 >= 1） | 1 |
| pageSize | integer | 否 | 10 | enum：`[10, 20, 25, 50, 100]`；每页条数 | 20 |

> 注：schema `required` 为空数组，所有参数均可选。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值 |
| message | string | 国际化文案 key，成功时为 `message.open_api.success.default` |
| data | object | 端口分布查询结果，含 `total` 与 `item` |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 端口分组总条数（未分页前） |
| item | array | 分页后的端口分组列表，元素结构见下 |

### item 数组元素结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| port | integer | 端口号 | 0-65535 | 80 |
| protocol | string | 协议 | `tcp` / `udp` | "tcp" |
| regionId | string | 地域 ID（缓存路径下可能为字符串，非缓存路径下取决于数据） | 字符串 | "region-001" |
| count | integer | 该端口分组下的资产数量（去重计数） | >= 0 | 156 |

> 注：`regionId` 字段名在响应中可能是 `regionId`（驼峰）或 `region_id`（下划线），取决于 DAO 返回与是否经 `transform_output`。本接口未显式调用 `transform_output`，故保留 DAO 原始下划线命名 `region_id` 的可能性较大。调用方应做兼容处理。

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "total": 28,
    "item": [
      {"port": 80, "protocol": "tcp", "region_id": "region-001", "count": 156},
      {"port": 443, "protocol": "tcp", "region_id": "region-001", "count": 132},
      {"port": 22, "protocol": "tcp", "region_id": "region-001", "count": 98},
      {"port": 3389, "protocol": "tcp", "region_id": "region-001", "count": 76},
      {"port": 3306, "protocol": "tcp", "region_id": "region-001", "count": 54},
      {"port": 8080, "protocol": "tcp", "region_id": "region-001", "count": 45},
      {"port": 21, "protocol": "tcp", "region_id": "region-001", "count": 32},
      {"port": 25, "protocol": "tcp", "region_id": "region-001", "count": 28},
      {"port": 53, "protocol": "udp", "region_id": "region-001", "count": 22},
      {"port": 4443, "protocol": "tcp", "region_id": "region-001", "count": 18}
    ]
  }
}
```

## 调用示例

### 示例1：获取端口分布 Top 10

**请求示例**：
```json
{
  "page": 1,
  "pageSize": 10
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "total": 28,
    "item": [
      {"port": 80, "protocol": "tcp", "region_id": "region-001", "count": 156},
      {"port": 443, "protocol": "tcp", "region_id": "region-001", "count": 132},
      {"port": 22, "protocol": "tcp", "region_id": "region-001", "count": 98}
    ]
  }
}
```

### 示例2：按端口号搜索特定端口分布

**请求示例**：
```json
{
  "port": "80",
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
    "total": 1,
    "item": [
      {"port": 80, "protocol": "tcp", "region_id": "region-001", "count": 156}
    ]
  }
}
```

### 示例3：分页获取端口分布第二页

**请求示例**：
```json
{
  "page": 2,
  "pageSize": 10
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "total": 28,
    "item": [
      {"port": 25, "protocol": "tcp", "region_id": "region-001", "count": 28},
      {"port": 53, "protocol": "udp", "region_id": "region-001", "count": 22}
    ]
  }
}
```

### 示例4：错误示例——pageSize 枚举非法

**请求示例**（`pageSize=15` 不在枚举中）：
```json
{
  "page": 1,
  "pageSize": 15
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'pageSize: 15 is not one of [10, 20, 25, 50, 100]'>",
  "data": null
}
```

### 示例5：错误示例——端口号超出范围

**请求示例**（`port="99999"` 超过 65535）：
```json
{
  "port": "99999",
  "page": 1,
  "pageSize": 10
}
```

**错误响应示例**（HTTP 400，业务层校验失败，`FrontendError` 转换为 `V1_UNKNOWN`）：
```json
{
  "code": "V1_UNKNOWN",
  "message": "<Message.Port.Restrict 对应的国际化文案>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `port` 可选，字符串类型，业务层转 int 后必须在 `0-65535` 之间
- `page` 可选，integer 类型，`minimum=0`，但建议 `>= 1`（`page=0` 会导致 `offset` 为负数）
- `pageSize` 必须为枚举值 `10/20/25/50/100` 之一，其他值会被 schema 拒绝
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `page` 与 `pageSize` 共同决定分页（`offset = (page - 1) * pageSize`）
- `port` 与 `page`/`pageSize` 独立，可单独使用或组合使用

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- 本 Resource 未显式注入 `@trans_ctx_pid_query`，但 DAO 层 `get_group_count` 内部通过 `get_ctx_data_regions()` 做地域过滤

### 性能建议

- 默认走 `cache_key="port"` 缓存路径，命中缓存时响应较快；缓存可能不实时反映最新数据
- 非缓存路径使用 `allowDiskUse=True`，大数据集（百万级端口记录）可能耗时较长
- `pageSize` 建议不超过 100，过大响应体会拖慢传输
- 端口搜索（`port` 字段）会触发 `search` 注入，可能影响缓存命中率

### 数据一致性说明

- **`total` 是分组后总条数**：是按端口号+协议分组后的条数，不是端口记录总数或资产总数
- **缓存数据可能延迟**：缓存路径下返回的是缓存数据，可能与最新 MongoDB 数据有延迟
- **`count` 字段命名**：响应中 `count` 是从 DAO 输出的 `asset_num` 重命名而来
- **`region_id` 命名**：响应中可能为 `region_id`（下划线），调用方应做兼容处理（本接口未显式调用 `transform_output`）
- **资产去重计数**：聚合使用 `asset_ids: {$addToSet: "$asset_id"}` + `$size`，对同一资产在多端口的记录去重

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `pageSize: 15 is not one of [10, 20, 25, 50, 100]`、`page: must be integer`、`additionalProperties not allowed`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/枚举/必填约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<Message.Port.Restrict>` | `port` 字符串无法转 int 或超出 0-65535 范围（`validate_ports_count` 抛 `FrontendError`） | 确认 `port` 为合法端口号字符串（0-65535） |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 聚合查询失败 / `A_Port` 集合不可用 / 缓存服务异常 | 联系运维检查 MongoDB 连接与缓存服务状态 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **`pageSize` 使用枚举值**：必须为 `10/20/25/50/100` 之一，调用方应硬编码这些值，避免传入其他值导致 schema 校验失败
2. **`page` 从 1 开始**：虽然 schema 允许 `page=0`，但会导致 `offset` 为负数，建议始终传 `page >= 1`
3. **端口搜索用字符串**：`port` 字段为字符串类型，调用方传入端口号时应转为字符串（如 `"80"` 而非 `80`）
4. **缓存数据延迟容忍**：本接口默认走缓存路径，响应数据可能有延迟；若需实时数据，可联系运维清理缓存或使用其他实时接口
5. **`count` 字段消费**：响应中 `count` 是该端口分组下的资产数量（去重计数），用于排序展示；调用方做端口分布分析时应按 `count` 降序消费
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含 `total` 与 `item` 列表
