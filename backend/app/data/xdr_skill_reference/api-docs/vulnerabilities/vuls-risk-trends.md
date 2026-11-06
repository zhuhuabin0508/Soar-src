# POST /api/xdr/v1/vuls/risk/trends

## 接口概述

本接口用于获取脆弱性风险趋势图数据。通过本接口，您可以获取以下内容：

### 可查询的趋势信息
- **时间维度**：按小时（1H）或天（1d）聚合
- **聚合指标**：漏洞数量、弱密码数量、风险数量等任意数值字段的 count/sum/avg
- **过滤条件**：脆弱性类型、风险等级、业务组、资产组、修复优先级
- **时间范围**：最长 180 天

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `VulsTrends` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/risk/trends` 经 etcd 具体路由 转后端 `/order/v2/openapi/vuls/risk/trends`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 趋势分析 |
| 接口分类 | 趋势查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/aggregation/count`、`/api/xdr/v1/vuls/risk/aggregation/loopholeLevel` |

## 使用场景

1. **趋势图绘制**：按时间维度聚合，绘制漏洞数量随时间变化的趋势图
2. **重点关注**：识别漏洞数量激增的时间段，定位异常事件
3. **周/月对比**：按天聚合，对比周/月维度的漏洞数量趋势
4. **聚合分析**：与 aggregation 接口配合，先看当前分布，再看时间趋势
5. **告警关联**：与告警系统配合，根据时间趋势定位告警触发点

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/trends` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.VULS_TREND_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=False)` 转换参数
4. **时间范围校验**：
   - `end_timestamp - start_timestamp < 0` → 抛 `V1OpenAPIError(ERROR.V1_UNKNOWN, message="开始时间不能大于结束时间")`
   - `end_timestamp - start_timestamp > 180 * 24 * 60 * 60` → 抛 `V1OpenAPIError(ERROR.V1_UNKNOWN, message="开始时间和结束时间间隔不能超过180天")`
5. **agg_by 转换**：将 `agg_by` 数组中的每个 key 通过 `camelcase_to_underscore` 转换
6. **趋势查询**：调用 `get_vuls_trend(new_data)`，按 `interval` 聚合时间维度
7. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
8. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- 入参小驼峰 → 内部下划线
- 出参下划线 → 小驼峰
- `agg_by` 数组元素单独转换（camelcase → underscore）

### 默认行为

- 不传 `timeZone` 时使用默认时区
- `agg_by` 最大 1 个元素（只支持单分组）
- `aggFuncs` 最大 1 个元素（只支持单聚合函数）

### 特殊规则

- **时间范围校验**：开始时间必须小于结束时间，且间隔不超过 180 天，否则返回 Unknown.SerComError 错误
- **agg_by 限制**：目前只支持 1 个分组字段
- **aggFuncs 限制**：目前只支持 1 个聚合函数
- **interval 枚举**：`["1H", "1d"]`（1 小时或 1 天）
- **aggFuncs 字段正则**：`name`/`func` 字段正则 `^(?!.*[\'\"\\\\<>()%&+]).+$`（禁用特殊字符）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒） | 1717200000 |
| endTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒），与 startTimestamp 间隔 ≤ 180 天 | 1719800000 |
| timeField | string | 是 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/`found_time`/`last_time` | "found_time" |
| timeZone | string | 否 | - | 时区，maxLength=64 | "Asia/Shanghai" |
| filterParam | object | 否 | - | 过滤条件对象 | 见下方 |
| aggBy | array&lt;string&gt; | 否 | - | 分组字段，maxItems=1，maxLength=64，符合 SEARCH_REGEX 正则 | ["riskLevels"] |
| aggFuncs | array&lt;object&gt; | 是 | - | 聚合函数列表，maxItems=1 | 见下方 |
| interval | string | 是 | - | 时间间隔，枚举 `["1H", "1d"]` | "1d" |
| platformFilter | array&lt;object&gt; | 否 | 平台过滤条件数组，元素含 `platformId`/`branchIds` 等。**`platformId` 必须是当前租户平台树中真实存在的 ID——传不存在的 platformId 会触发 `TypeError: 'NoneType' object is not iterable`** | [{"platformId": "P1", "branchIds": [101]}] |

#### filterParam 结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| dataType | string/array&lt;string&gt; | 否 | 脆弱性类型（支持 string 或 array），参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码, `baseline`/基线 | "loophole" |
| riskLevels | array&lt;integer&gt; | 否 | 风险等级，参考 enum-dictionary-python.md。0/低, 1/中, 2/高, 3/严重 | [2, 3] |
| assetBranchIds | array&lt;integer&gt; | 否 | 资产组 ID 列表（对应内部 `branch_ids` → Mongo `business_id`） | [101] |
| assetGroupIds | array&lt;integer&gt; | 否 | 业务组 ID 列表（对应内部 `group_ids` → Mongo `group_id`） | [201] |
| fixPriority | array&lt;integer&gt; | 否 | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |

#### aggFuncs 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | 聚合结果字段名，maxLength=64，正则 `^(?!.*[\'\"\\\\<>()%&+]).+$` | "totalCount" |
| func | string | 是 | 聚合函数名（count/sum/avg/max/min），maxLength=64，正则 `^(?!.*[\'\"\\\\<>()%&+]).+$` | "count" |
| param | string | 否 | 聚合函数参数，maxLength=64，符合 SEARCH_REGEX 正则 | "risk_num" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 "Success"（OpenAPI 外壳，**字符串非整数**）。失败时为 "InvalidParameter"/"Unknown.SerComError"/"InternalError" |
| message | string | 响应消息，成功时为 `"success"` |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| meta | array&lt;object&gt; | 聚合维度元信息（描述每个 aggBy 字段） |
| item | array&lt;object&gt; | 趋势数据列表（按 aggBy 分组） |

> **注意本接口不返回 `data.list` 也不返回 `data.total`**：响应只有 `data.meta` + `data.item`。`item` 为按 `aggBy` 字段分组的桶列表，每桶内含时间序列数组。

### item 元素结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| {aggBy_0} | string/integer | 分组字段值（若传了 aggBy） | 由 aggBy 字段类型决定 | 3 |
| {aggFuncs[0].name} | array&lt;object&gt; | 该分组的时间序列数组（按 interval 分桶） | - | `[{"timestamp":1717200000,"totalCount":12}]` |
| timeField | string | 时间字段名（仅未传 aggBy 时返回） | - | "found_time" |
| timestamp | integer | 时间戳（仅未传 aggBy 时返回，按 interval 对齐） | - | 1717200000 |
| {aggFuncs[0].name} | integer/number | 聚合结果（仅未传 aggBy 时返回） | - | 12 |

### {aggFuncs[0].name} 数组元素结构（传了 aggBy 时）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| timeField | string | 时间字段名 | "found_time" |
| timestamp | integer | 时间戳（按 interval 对齐） | 1717200000 |
| {aggFuncs[0].name} | integer/number | 聚合结果 | 12 |

## 调用示例

### 示例 1：按天聚合漏洞数量趋势

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggFuncs": [{"name": "totalCount", "func": "count"}],
  "interval": "1d"
}
```

**响应示例**（未传 aggBy，扁平时间序列）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [],
    "item": [
      {"timeField": "found_time", "timestamp": 1717200000, "totalCount": 12},
      {"timeField": "found_time", "timestamp": 1717286400, "totalCount": 18},
      {"timeField": "found_time", "timestamp": 1717372800, "totalCount": 25},
      {"timeField": "found_time", "timestamp": 1717459200, "totalCount": 30}
    ]
  }
}
```

### 示例 2：按小时聚合，按风险等级分组

**请求示例**：
```json
{
  "startTimestamp": 1719500000,
  "endTimestamp": 1719586400,
  "timeField": "last_time",
  "filterParam": {
    "dataType": "loophole",
    "fixPriority": [2, 3]
  },
  "aggBy": ["riskLevels"],
  "aggFuncs": [{"name": "vulnCount", "func": "count"}],
  "interval": "1H"
}
```

**响应示例**（传了 aggBy=["riskLevels"]，按风险等级分组，每桶内含时间序列）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [{"name": "riskLevels", "type": "integer"}],
    "item": [
      {"riskLevels": 3, "vulnCount": [
        {"timeField": "last_time", "timestamp": 1719500000, "vulnCount": 5},
        {"timeField": "last_time", "timestamp": 1719503600, "vulnCount": 7}
      ]},
      {"riskLevels": 2, "vulnCount": [
        {"timeField": "last_time", "timestamp": 1719500000, "vulnCount": 12},
        {"timeField": "last_time", "timestamp": 1719503600, "vulnCount": 15}
      ]}
    ]
  }
}
```

### 示例 3：错误响应 - 开始时间大于结束时间

**请求示例**：
```json
{
  "startTimestamp": 1719800000,
  "endTimestamp": 1717200000,
  "timeField": "found_time",
  "aggFuncs": [{"name": "totalCount", "func": "count"}],
  "interval": "1d"
}
```

**错误响应示例**：
```json
{
  "code": "Unknown.SerComError",
  "message": "Unknown.SerComError",
  "data": null
}
```

### 示例 4：错误响应 - 时间间隔超过 180 天

**请求示例**：
```json
{
  "startTimestamp": 1609459200,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggFuncs": [{"name": "totalCount", "func": "count"}],
  "interval": "1d"
}
```

**错误响应示例**：
```json
{
  "code": "Unknown.SerComError",
  "message": "Unknown.SerComError",
  "data": null
}
```

### 示例 5：错误响应 - 缺少必填字段

**请求示例**（缺少 `interval`）：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggFuncs": [{"name": "totalCount", "func": "count"}]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "InvalidParameter",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `startTimestamp` 必须小于 `endTimestamp`
- 时间间隔不超过 180 天（180 * 24 * 60 * 60 秒）
- `aggBy` maxItems=1（只支持单分组字段）
- `aggFuncs` maxItems=1（只支持单聚合函数）
- `interval` 枚举 `["1H", "1d"]`
- `aggFuncs.name`/`func` 字段禁用特殊字符（正则 `^(?!.*[\'\"\\\\<>()%&+]).+$`）
- 平台过滤数组，每个元素 `{"platformId": 必填, "branchIds": 可选, "groupIds": 可选}`。**`platformId` 必须是当前租户平台树中真实存在的 ID**——传不存在的 platformId 会触发 `TypeError: 'NoneType' object is not iterable`（后端按 platformId 展开子资产组时找不到节点）。如不确定 platformId，先用平台查询接口取真实值

### 参数依赖关系

- `startTimestamp` 和 `endTimestamp` 必填，且间隔 ≤ 180 天
- `interval` 决定时间粒度，影响返回数据点数量
- `aggBy` 与 `aggFuncs` 配合使用，aggBy 决定分组，aggFuncs 决定聚合

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `interval="1H"` 适用于短时间范围（≤ 7 天）
- `interval="1d"` 适用于长时间范围（7-180 天）
- `aggBy` 不传时只返回时间维度聚合，性能更好

### 数据一致性说明

- 响应字段为小驼峰命名
- 错误码，成功时为 "Success"（OpenAPI 外壳，**字符串非整数**）。失败时为 "InvalidParameter"/"Unknown.SerComError"/"InternalError"
- **时间范围校验**：超过 180 天返回 Unknown.SerComError 错误
- **aggBy/aggFuncs 限制**：目前只支持单分组、单聚合函数

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| "Unknown.SerComError" | Unknown.SerComError | 开始时间大于结束时间 | 调整时间范围 |
| "Unknown.SerComError" | Unknown.SerComError | 时间间隔超过 180 天 | 缩小时间范围 |
| "InvalidParameter" | InvalidParameter | 缺少必填字段 | 补全字段 |
| "InvalidParameter" | InvalidParameter | interval 不在 `["1H", "1d"]` 枚举内 | 使用 1H 或 1d |
| "InvalidParameter" | InvalidParameter | aggBy/aggFuncs 超过 maxItems=1 | 只传 1 个元素 |
| "InvalidParameter" | InvalidParameter | aggFuncs.name/func 含特殊字符 | 移除 `'"\\<>()%&+` 字符 |
| "InternalError" | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **interval 选择**：短时间用 1H，长时间用 1d
2. **aggBy 不传**：不需要分组时省略 aggBy，性能更好
3. **时间范围限制**：≤ 180 天，超过需分段查询
4. **filterParam 必带**：缩小数据范围，提升性能
5. **特殊字符过滤**：aggFuncs.name/func 避免使用 `'"\\<>()%&+` 字符
6. **平台过滤**：跨平台查询时显式设置 `platformFilter`（数组对象，每个元素含 `platformId` 必填、`branchIds`/`groupIds` 可选），不传时默认只查当前平台。**`platformId` 必须是租户平台树中真实存在的 ID**，传不存在 ID 会触发 `TypeError: 'NoneType' object is not iterable`

---
