# POST /api/xdr/v1/incidents/tag/count

## 接口概述

本接口用于按事件一级标签（RiskTag）分组统计指定时间范围内安全事件数量，返回 Top N 标签及其事件数，支撑事件类型分布大屏卡片与运营报表。通过本接口，您可以获取/操作以下内容：

### 可查询的事件类型分布信息
- **标签 Top 列表**：每项含标签名（name）与事件数（value）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件类型统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/branches/count` 资产组事件统计、`/incidents/dealstatus/count` 处置状态统计、`/incidents/severity/count` 等级统计、`/incidents/aggregation` 通用聚合 |

## 使用场景

1. **事件类型分布大屏**：渲染 Top N 事件类型柱状图，展示主导事件分类
2. **运营报表**：日报/周报中按事件类型统计数量，识别高频事件类型
3. **趋势对比**：配合 `/incidents/trends` 按一级标签分组展示事件时间分布
4. **聚合接口替代**：当只需按一级标签分组计数时，本接口比 `/incidents/aggregation` 更轻量
5. **配合威胁分类接口**：通过 `/incidents/threatclass` 获取一级分类枚举值，与本接口统计结果交叉验证

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/tag/count |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `IncidentTimeRangeQo`，含 `timeRange`/`startTimestamp`/`endTimestamp`/`topN`
2. JSR-303 校验：`timeRange` 非 empty 且为 `TimeRangeEnum` 合法取值；`startTimestamp`/`endTimestamp` 非 null；`topN` ∈ [1, 200]
3. 调用 `iIncidentScreenService.getIncidentTypeTop(timeRangeQo)`
4. Service 层调用 `iIncidentDao.countByFirstLevelLabel(timeRangeQo)` 按一级标签分组查询，返回 `List<IncidentStatisticalVo>`
5. 遍历结果，调用 `RiskTagEnum.getLabelByRiskTag(name)` 将原始标签 key 转为国际化展示名称
6. 返回 List（Controller 直接返回 List，无 OpenApiResponse 包装）

### 数据转换逻辑

- DAO 返回 `IncidentStatisticalVo` 列表，name 字段为标签原始 key（如 "A001"）
- 通过 `RiskTagEnum.getLabelByRiskTag(name)` 转为国际化中文标签（如 "脆弱性风险"）
- value 字段为该标签下事件数

### 默认行为

- `topN` 默认 5（QO 字段初始化）
- 不传 topN 时取默认 5

### 特殊规则

- `timeRange` 必须为 `TimeRangeEnum` 合法取值（last7d/last30d/last24h/custom）
- `topN` ∈ [1, 200]，超出范围 400 拒绝
- 接口直接返回 `List<IncidentStatisticalVo>` 而非 `OpenApiResponse<List<...>>`，无 code/message 包装

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：IncidentTimeRangeQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| timeRange | string | 是 | - | 时间范围类型，TimeRangeEnum 取值，见下方枚举说明 | "last7d" |
| startTimestamp | long | 是 | - | 开始时间（秒级时间戳） | 1750968000 |
| endTimestamp | long | 是 | - | 结束时间（秒级时间戳） | 1783113600 |
| topN | integer | 否 | 5 | Top 级别，取值范围 [1, 200] | 10 |

#### timeRange 枚举说明（TimeRangeEnum）

| 取值 | 说明 |
|------|------|
| last7d | 最近 7 天 |
| last30d | 最近 30 天 |
| last24h | 最近 24 小时 |
| custom | 自定义时间范围（需配合 startTimestamp/endTimestamp） |

> 注意：IncidentTimeRangeQo 字段无 @JsonProperty 注解，JSON 字段名与 Java 字段名一致。

## 返回参数

### 响应结构

接口直接返回 `List<IncidentStatisticalVo>`，无 `code`/`message`/`data` 包装。响应体即下方 item 列表。

### item 元素结构说明（IncidentStatisticalVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 统计数据key（已国际化的标签名） | RiskTagEnum 国际化标签 | "脆弱性风险" |
| value | long | 数据量（事件数） | ≥ 0 | 42 |

## 调用示例

### 示例1：查询近 7 天 Top 5 事件类型

**请求示例**：
```json
{
    "timeRange": "last7d",
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "topN": 5
}
```

**响应示例**：
```json
[
    {"name": "脆弱性风险", "value": 42},
    {"name": "服务探测", "value": 18},
    {"name": "网站攻击", "value": 12},
    {"name": "账号暴力破解", "value": 8},
    {"name": "挖矿", "value": 5}
]
```

### 示例2：错误响应 - timeRange 缺失

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600
}
```

**错误响应示例**：
```json
{
    "code": 400,
    "message": "timeRange cannot be empty",
    "data": null
}
```

### 示例3：错误响应 - topN 超范围

**请求示例**：
```json
{
    "timeRange": "last7d",
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
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

### 示例4：权限不足

**错误响应示例**：
```json
{
    "code": 403,
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `timeRange` 必填，必须为 TimeRangeEnum 合法取值
- `startTimestamp`/`endTimestamp` 必填，秒级 10 位 Long
- `topN` ∈ [1, 200]，默认 5

### 参数依赖关系
- `timeRange=custom` 时按 startTimestamp/endTimestamp 过滤；其他取值时 timeRange 决定时间范围（startTimestamp/endTimestamp 仍需传入）

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.get.incidents.tagCount.log"）

### 性能建议
- topN 建议 ≤ 20，避免返回过多标签导致前端渲染拥挤
- 大屏态数据可缓存 5 分钟

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | timeRange cannot be empty | timeRange 缺失 | 补全 timeRange 字段 |
| 400 | timeRange value error | timeRange 非法 | 使用 TimeRangeEnum 合法取值 |
| 400 | startTimestamp cannot be null | startTimestamp 缺失 | 补全 startTimestamp |
| 400 | topN cannot be less than 1 | topN < 1 | topN ≥ 1 |
| 400 | topN cannot be greater than 200 | topN > 200 | topN ≤ 200 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **按业务时区计算时间范围**：startTimestamp/endTimestamp 用业务时区自然日起止转秒级时间戳
2. **topN 适中**：建议 topN=10，覆盖主要类型且不冗余
3. **缓存 5 分钟**：大屏态数据可前端缓存 5 分钟
4. **配合 branches/count**：本接口看类型分布，配合 `/incidents/branches/count` 看资产组分布
5. **配合 threatclass**：通过 `/incidents/threatclass` 获取一级分类完整枚举值
