# POST /api/xdr/v1/alerts/ipinfosstats

- 业务对象：告警
- 接口类型：双维度聚合统计
- 关联文档：`alert-aggregation.md`（通用聚合）、`alert-branchstats.md`（境内外受攻击资产）

## 接口概述

获取攻击源与受攻击资产的双维度聚合查询结果——按源IP+国家（或目的IP+国家）双维度聚合统计告警数，专为多维度聚合场景设计。与通用聚合接口 `/api/xdr/v1/alerts/aggregation`（aggBy 只传一个字段）不同，本接口支持 aggBy 传多个字段做双维度分组。**适用于按源IP+国家双维度聚合统计、境外攻击源 Top N、攻击源地理位置分析等场景**。

## 使用场景

- **按源IP+国家双维度聚合统计**（境外攻击源 Top N、攻击源地理位置分析）
- 按源IP+目的IP双维度聚合（攻击源-受攻击目标对分析）
- 多维度聚合统计（aggBy 传多个字段，超出通用聚合接口单字段约束时）
- 攻击源统计分析（境外/境内攻击源分布）

## 请求路径

- **对外调用路径**：`/api/xdr/v1/alerts/ipinfosstats`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/alerts/ipinfosstats`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin` 或 `alertQuery`

## 请求参数

复用 `OpenApiAlertAggQo`（与 `/api/xdr/v1/alerts/aggregation` 相同的 QO）。详见 `alert-aggregation.md` 的请求参数表。

### 关键差异

| 参数 | 通用聚合接口 | 本接口（ipinfosstats） |
|------|-------------|----------------------|
| aggBy 字段数 | 只传 1 个（业务约束） | 可传多个（双维度聚合） |
| 典型 aggBy | `["hostBranchId"]` | `["srcIp", "srcCountryName"]` |
| 典型场景 | Top N 单维度统计 | 双维度聚合统计 |

### 顶层参数（OpenApiAlertAggQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 起始时间，秒级时间戳 |
| endTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 结束时间，秒级时间戳 |
| timeField | String | 是 | — | 见 alert-aggregation.md timeField 枚举 | 过滤的时间字段 |
| filterParam | Object | 否 | — | 见 alert-aggregation.md filterParam 子结构 | 其他过滤字段（含 srcIps、srcCountryNames 等双维度过滤字段） |
| aggBy | Array<String> | 是 | — | Alert.class 字段名；**本接口可传多个字段做双维度聚合** | 分组字段，传多个做双维度聚合 |
| aggFuncs | Array<Object> | 是 | — | 见 alert-aggregation.md aggFuncs 子结构 | 聚合操作 |
| sort | String | 否 | — | `fieldName:asc` 或 `fieldName:desc`（冒号分隔） | 排序方法 |
| limit | Integer | 否 | 5 | 1 ~ 各 QO 最大值 | TOP 数量，未传默认 5 会静默截断 |

### 双维度聚合常用字段组合

| 双维度场景 | aggBy 字段组合 | filterParam 过滤字段 |
|----------|---------------|---------------------|
| 按源IP+国家聚合（境外攻击源 Top N） | `["srcIp", "srcCountryName"]` | `srcIps`、`srcCountryNames` |
| 按目的IP+国家聚合（受攻击目标 Top N） | `["dstIp", "dstCountryName"]` | `dstIps`、`dstCountryNames` |
| 按源IP+目的IP聚合（攻击源-目标对） | `["srcIp", "dstIp"]` | `srcIps`、`dstIps` |

## 返回参数（OpenApiAggResult）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| item | Array<Object> | 双维度聚合桶列表，每个桶含多维度字段值 |
| sumOtherDocCount | Long | 未进入 Top N 的合计文档数 |
| total | Long | 总文档数 |

### item 元素结构

每个 item 元素含多个 `<aggBy字段名>` 字段（对应双维度分组值）+ 各 aggFuncs 聚合结果字段。例：aggBy=`["srcIp", "srcCountryName"]`，item 元素含 `srcIp`、`srcCountryName`、`count` 等字段。

## 业务逻辑

### 核心处理流程

1. **时间范围补全**：Controller 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 对入参时间戳做补全处理
2. **aggBy 字段校验**：Service 将 aggBy 字段名与 `Alert.class.getDeclaredFields()` 比对，任一字段不存在则返回空结果
3. **aggFuncs 字段替换**：若 aggFuncs.param 含 `uuId`，自动改为 `name`
4. **DAO 查询**：调用 `alertDao.getAlertAggResult(qo)` 执行 ES 双维度聚合查询（aggBy 多字段分组）
5. **结果组装**：ES 多维度 Aggregation 解析为 VO 桶列表，每个桶含多个 aggBy 字段值 + 聚合结果
6. **截断处理**：limit 控制返回桶数，未传时默认 5 会静默截断

### 默认行为

- startTimestamp/endTimestamp 缺省时由 `OpenApiTimeRangeUtil` 补全
- limit 缺省时取 5（**会静默截断分组结果且不报错**）

### 特殊规则

- **aggBy 多字段支持**：本接口专为双维度聚合设计，aggBy 可传多个字段；与通用聚合接口（aggBy 只传一个字段）形成互补
- **aggFuncs.param.uuId 自动替换**：传 `uuId` 会被自动改为 `name`
- **aggFuncs.func 必须用源码支持的值**：`count`/`cardinality`/`avg`/`max`/`min`/`sum`
- **sort 冒号分隔**：`fieldName:asc` 或 `fieldName:desc`
- **aggBy 字段名约束**：必须用 `Alert.class` 实体类字段名

## 数据一致性说明

- **入参与返回时间戳均为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：当前时间 2026-07-05 00:00:00 UTC，最近 7 天起始时间戳为 `1782499200`（10 位秒级）

## 调用示例

### 示例 1：境外攻击源 Top 5（按源IP+国家双维度聚合）

```json
POST /api/xdr/v1/alerts/ipinfosstats
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["srcIp", "srcCountryName"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "*"
    }
  ],
  "sort": "count:desc",
  "limit": 5
}
```

返回示例：

```json
{
  "item": [
    {"srcIp": "203.0.113.1", "srcCountryName": "CountryA", "count": 120},
    {"srcIp": "198.51.100.2", "srcCountryName": "CountryB", "count": 95},
    {"srcIp": "192.0.2.3", "srcCountryName": "CountryC", "count": 80},
    {"srcIp": "203.0.113.4", "srcCountryName": "CountryA", "count": 65},
    {"srcIp": "198.51.100.5", "srcCountryName": "CountryD", "count": 50}
  ],
  "sumOtherDocCount": 320,
  "total": 730
}
```

### 示例 2：按源IP+国家双维度聚合，过滤特定国家

```json
POST /api/xdr/v1/alerts/ipinfosstats
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["srcIp", "srcCountryName"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "*"
    }
  ],
  "filterParam": {
    "srcCountryNames": ["CountryA", "CountryB"]
  },
  "sort": "count:desc",
  "limit": 10
}
```

## 使用注意事项

1. **本接口 aggBy 可传多个字段**：专为双维度聚合设计，与通用聚合接口（aggBy 只传一个字段）形成互补
2. **aggBy 字段名**：必须用 `Alert.class` 实体类字段名（如 `srcIp`、`srcCountryName`、`dstIp`、`dstCountryName`），不能用凭推测的字段名
3. **aggFuncs.func**：用源码支持的值（`count`/`cardinality`/`avg`/`max`/`min`/`sum`），不是 ES 原生函数名
4. **aggFuncs.param**：传 `uuId` 会被自动改为 `name`
5. **filterParam 字段名**：复数字段（`srcIps`、`srcCountryNames`、`dstIps`、`dstCountryNames` 等）从 `@JsonProperty` 提取，不能写成单数
6. **sort 冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，不是空格分隔
7. **limit 不省略**：未传时默认 5 会静默截断分组结果且不报错；聚合字段为已知有限枚举时传枚举总数，非已知枚举时让业务方给出 N
8. **时间戳单位**：入参与返回均为秒级（10 位 Long），不是毫秒级

## 关联接口

- `alert-aggregation.md`：通用聚合接口（aggBy 单字段）
- `alert-branchstats.md`：境内外受攻击资产查询
- `alert-list.md`：分页查询告警明细列表