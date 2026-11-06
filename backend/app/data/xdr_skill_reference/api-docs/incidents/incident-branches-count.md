# POST /api/xdr/v1/incidents/branches/count

## 接口概述

本接口用于按资产组（hostBranchId）分组聚合统计安全事件数量，返回事件最多的 Top N 资产组，并将资产组 ID 解析为资产组名称后返回。通过本接口，您可以获取以下内容：

### 可查询/统计的资产组事件信息
- **资产组事件 Top N**：每个资产组的事件数量（已按资产组名解析），按 topN 截断
- **统计数据 key**：资产组名称（name，由 hostBranchId 通过缓存解析为原始名称）
- **数据量**：该资产组的事件数量（value）

### 可设置的过滤维度
- **时间范围类型**：timeRange（last7d / last30d / last24h / custom）
- **时间范围**：startTimestamp / endTimestamp（秒级，必填）
- **Top 数量**：topN（默认 5，最大 200）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件资产组统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/incidents/tag/count` 事件类型数量统计、`/api/xdr/v1/incidents/asset/aggregation` 事件主机聚合查询、`/api/xdr/v1/incidents/aggregation` 事件通用聚合、`/api/xdr/v1/incidents/list` 事件列表 |

## 使用场景

1. **大屏资产组事件排名**：在 SOC 大屏展示事件最多的 Top 5/Top 10 资产组，快速识别风险资产
2. **资产风险下钻**：先用本接口拿到事件最多的资产组，再用 `/incidents/list` 配合 hostBranchIds 过滤查看明细
3. **运营效率分析**：定期调用本接口，对比不同时段资产组事件数变化，定位风险上升趋势的资产组
4. **配合通用聚合**：本接口返回 name=资产组名（已解析），`/incidents/aggregation` 返回 hostBranchId（未解析），可互为补充
5. **大屏 timeRange 切换**：通过 last7d/last30d/last24h 快速切换大屏时间窗口，无需手动算时间戳
6. **配合资产组聚合**：本接口专为资产组维度设计，更细粒度（如 hostIp/hostAssetId）用 `/incidents/asset/aggregation`

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/branches/count |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery（两者任一） |

## 业务逻辑

### 核心处理流程

1. **入参校验**：
   - `timeRange` 必填，必须是 TimeRangeEnum 合法值（last7d / last30d / last24h / custom）
   - `startTimestamp` / `endTimestamp` 必填
   - `topN` 取值范围 [1, 200]，缺省 5
2. **Service 层查询**：调用 `iIncidentDao.countByHostBranchId(timeRangeQo)`，按 hostBranchId 分组聚合统计事件数，按时间范围过滤、按 topN 截断
3. **资产组 ID 解析**：遍历查询结果，通过 `branchNameCache.getOriginInteger(Integer.parseInt(name))` 将 hostBranchId（数字字符串）解析为资产组名称（原始名称）
4. **返回**：返回 `List<IncidentStatisticalVo>`，每元素含 name（资产组名）+ value（事件数）

### 数据转换逻辑

- DAO 返回的 `name` 字段为 hostBranchId 数字字符串
- Service 层通过 `branchNameCache.getOriginInteger` 解析为资产组原始名称
- 解析失败时可能返回原数字字符串或空值（依赖缓存命中率）

### 默认行为

- `topN` 缺省时为 `5`（**默认静默截断为 Top 5**）
- 时间范围由 `timeRange` + `startTimestamp/endTimestamp` 共同决定（custom 模式以时间戳为准）

### 特殊规则

- **timeRange 必填且必须为 TimeRangeEnum 合法值**：last7d / last30d / last24h / custom
- **topN 取值范围 [1, 200]**：超出返回校验错误
- **name 字段为资产组名（已解析）**：不是 hostBranchId 数字，由 branchNameCache 解析
- **本接口不返回 meta**：直接返回 `List<IncidentStatisticalVo>`，无 meta/item 包装
- **时间范围同时传 timeRange + startTimestamp/endTimestamp**：custom 模式以时间戳为准，其他模式由后端按 timeRange 推导

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数（IncidentTimeRangeQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| timeRange | string | 是 | - | 时间范围类型，对应 TimeRangeEnum：last7d / last30d / last24h / custom | "last7d" |
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long） | 1782604800 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1783209600 |
| topN | integer | 否 | 5 | Top 数量，取值范围 [1, 200]。**注意：默认 5 会静默截断** | 10 |

#### timeRange 枚举值说明（TimeRangeEnum）

| value | 说明 |
|-------|------|
| last7d | 最近 7 天 |
| last30d | 最近 30 天 |
| last24h | 最近 24 小时 |
| custom | 自定义时间范围（以 startTimestamp/endTimestamp 为准） |

## 返回参数

### 响应结构

本接口直接返回 `List<IncidentStatisticalVo>`，无外层 code/message/data 包装（Controller 方法返回类型为 `List<IncidentStatisticalVo>`）。

### 数组元素结构说明（IncidentStatisticalVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 资产组名称（由 hostBranchId 通过 branchNameCache 解析得到） | 资产组原始名称 | "北京研发中心" |
| value | long | 该资产组的事件数量 | >= 0 | 80 |

## 调用示例

### 示例1：查询最近 7 天事件 Top 5 资产组（默认）

**请求示例**：
```json
{
  "timeRange": "last7d",
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**响应示例**：
```json
[
  {"name": "北京研发中心", "value": 80},
  {"name": "上海数据中心", "value": 65},
  {"name": "深圳测试环境", "value": 40},
  {"name": "广州办公网", "value": 25},
  {"name": "杭州生产环境", "value": 18}
]
```

### 示例2：查询最近 24 小时事件 Top 10 资产组

**请求示例**：
```json
{
  "timeRange": "last24h",
  "startTimestamp": 1783123200,
  "endTimestamp": 1783209600,
  "topN": 10
}
```

**响应示例**：
```json
[
  {"name": "北京研发中心", "value": 25},
  {"name": "上海数据中心", "value": 18},
  {"name": "深圳测试环境", "value": 12},
  {"name": "广州办公网", "value": 8}
]
```

### 示例3：自定义时间范围 + Top 20

**请求示例**：
```json
{
  "timeRange": "custom",
  "startTimestamp": 1749072000,
  "endTimestamp": 1783209600,
  "topN": 20
}
```

**响应示例**：
```json
[
  {"name": "北京研发中心", "value": 280},
  {"name": "上海数据中心", "value": 215},
  {"name": "深圳测试环境", "value": 140},
  {"name": "广州办公网", "value": 95},
  {"name": "杭州生产环境", "value": 78}
]
```

### 示例4：最近 30 天事件 Top 200（拿完整分布）

**请求示例**：
```json
{
  "timeRange": "last30d",
  "startTimestamp": 1749072000,
  "endTimestamp": 1783209600,
  "topN": 200
}
```

**响应示例**：
```json
[
  {"name": "北京研发中心", "value": 1280},
  {"name": "上海数据中心", "value": 965},
  {"name": "深圳测试环境", "value": 540},
  {"name": "广州办公网", "value": 425},
  {"name": "杭州生产环境", "value": 318},
  {"name": "...", "value": 12}
]
```

### 示例5：错误响应示例（timeRange 非法）

**请求示例**：
```json
{
  "timeRange": "invalidRange",
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**错误响应示例**：
```json
{
  "code": 400,
  "message": "time range value error",
  "data": null
}
```

### 示例6：错误响应示例（topN 超出范围）

**请求示例**（topN = 0）：
```json
{
  "timeRange": "last7d",
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "topN": 0
}
```

**错误响应示例**：
```json
{
  "code": 400,
  "message": "topN cannot be less than 1",
  "data": null
}
```

### 示例7：错误响应示例（缺少必填参数）

**请求示例**（缺少 startTimestamp）：
```json
{
  "timeRange": "last7d",
  "endTimestamp": 1783209600
}
```

**错误响应示例**：
```json
{
  "code": 400,
  "message": "startTimestamp cannot be empty",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `timeRange` 必填，仅 last7d / last30d / last24h / custom 四选一
- `startTimestamp` / `endTimestamp` 必填，秒级 10 位 Long
- `topN` 取值范围 [1, 200]，超出返回校验错误

### 参数依赖关系
- `timeRange=custom` 时以 `startTimestamp/endTimestamp` 为准
- 其他 timeRange 模式由后端按 timeRange 推导时间范围，但仍需传 startTimestamp/endTimestamp（用于校验）

### 权限要求
- 需具备 `superAdmin` 或 `incidentQuery` 权限

### 性能建议
- topN 较大时返回数据膨胀，建议按业务合理设置（一般 5~20 足够）
- 资产组维度基数有限，建议传 200 拿完整分布再客户端裁剪
- 频繁调用建议结果做缓存

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800，2026-07-04 00:00:00 UTC = 1783123200，2026-06-05 00:00:00 UTC = 1749072000
- `name` 字段为资产组名称（已解析），不是 hostBranchId 数字字符串
- 资产组名称解析依赖 branchNameCache，缓存未命中时可能返回原数字或空值

### 使用注意事项
- **topN 默认值 = 5**：不传 topN 时只返回 Top 5 个资产组，其余被静默截断不报错。资产组维度建议传 200 拿完整分布
- **返回结构无包装**：本接口直接返回 `List<IncidentStatisticalVo>` 数组，不是 `{code, message, data}` 结构，对接时需注意
- **name 字段为资产组名（已解析）**：不是 hostBranchId 数字，便于直接展示前端
- **timeRange 与时间戳同时传**：所有模式都需传 startTimestamp/endTimestamp，custom 模式以时间戳为准

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | time range cannot be empty | 未传 timeRange | 必传 timeRange |
| 400 | time range value error | timeRange 不是 TimeRangeEnum 合法值 | 改为 last7d/last30d/last24h/custom |
| 400 | startTimestamp cannot be empty | 未传 startTimestamp | 必传 startTimestamp |
| 400 | endTimestamp cannot be empty | 未传 endTimestamp | 必传 endTimestamp |
| 400 | topN cannot be less than 1 | topN < 1 | 传入 1~200 |
| 400 | topN cannot be greater than 200 | topN > 200 | 传入 1~200 |
| 500 | exception.method.execute | 数据库查询异常 | 联系管理员查看后端日志 |

## 最佳实践

1. **大屏场景**：使用 last7d / last24h 配合 topN=10，快速展示当前重点风险资产组
2. **完整分布**：资产组维度基数有限，建议传 topN=200 拿完整分布再客户端裁剪
3. **配合列表接口**：先用本接口拿到事件最多的资产组名，再用 `/incidents/list` 配合 hostBranchIds 过滤查看明细
4. **配合通用聚合**：本接口返回 name=资产组名（已解析），`/incidents/aggregation` 返回 hostBranchId（未解析），可互为补充
5. **timeRange 选型**：实时大屏用 last24h，周报用 last7d，月报用 last30d，自定义时段用 custom
6. **资产组名解析**：name 字段依赖 branchNameCache，对接时若出现数字字符串说明缓存未命中，可联系管理员补充资产组元数据
7. **返回结构注意**：本接口直接返回数组（无 code/message 包装），对接客户端时需特殊处理
8. **避免重复调用**：本接口聚合维度固定为 hostBranchId，如需其他维度（severity、dealStatus 等）走 `/incidents/aggregation`
