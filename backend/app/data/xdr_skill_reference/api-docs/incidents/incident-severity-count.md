# POST /api/xdr/v1/incidents/severity/count

## 接口概述

本接口用于按事件等级分组统计指定时间范围内的安全事件数量，返回信息/低危/中危/高危/严重 5 个等级各自的事件数，支撑事件等级分布大屏卡片与运营报表。通过本接口，您可以获取/操作以下内容：

### 可查询的事件等级分布信息
- **等级数量**：信息事件数（infoNum）、低危事件数（lowNum）、中危事件数（midNum）、高危事件数（highNum）、严重事件数（criticalNum）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件等级统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/security/analysis` 安全态势分析（含昨日事件总数）、`/incidents/dealstatus/count` 处置状态统计、`/incidents/aggregation` 通用聚合（可按 severity 分组） |

## 使用场景

1. **等级分布大屏**：渲染事件等级分布饼图/柱状图，展示各等级事件占比
2. **运营报表**：日报/周报中按等级统计事件数，量化风险严重度
3. **趋势对比**：配合 `/incidents/trends` 按等级分组展示事件时间分布
4. **SLA 监控**：高危与严重事件数突增时触发告警，提示运营介入
5. **聚合接口替代**：当只需按 severity 分组计数时，本接口比 `/incidents/aggregation` 更轻量

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/severity/count |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. 接收请求参数 `PhishCountQo`，含 `startTime`/`endTime`（秒级时间戳）
2. JSR-303 校验 `startTime`/`endTime` 非 null
3. 调用 `openApiIncidentService.getIncidentSeverity(countQo)`
4. Service 层调用 `incidentDao.countIncidentSeverity(startTime, endTime)` 按等级分组查询，返回 `List<RiskIncidentSeverityCount>`
5. 遍历查询结果，按 `IncidentSeverityEnum` 的 value 将 count 写入对应等级字段：
   - `LOW.getValue()`=1 → `lowNum`
   - `MID.getValue()`=2 → `midNum`
   - `HIGH.getValue()`=3 → `highNum`
   - `CRITICAL.getValue()`=4 → `criticalNum`
   - 其余（含 INFO/HEALTH value=0/-1）→ `infoNum`
6. 返回 `IncidentSeverityVo`（Controller 直接返回 VO，无 OpenApiResponse 包装）

### 数据转换逻辑

- DAO 返回 `RiskIncidentSeverityCount` 列表，每项含 severity 与 count
- 按 severity 数值映射到 VO 的 5 个等级字段
- 未匹配 LOW/MID/HIGH/CRITICAL 的等级全部归入 infoNum

### 默认行为

- 各等级字段使用 `@Builder.Default` 初始化为 0L，无数据时返回全 0
- 不指定时间范围时由 `@NotNull` 校验直接拒绝（400 错误）

### 特殊规则

- 接口直接返回 `IncidentSeverityVo` 而非 `OpenApiResponse<IncidentSeverityVo>`，无 code/message 包装
- 等级值映射依据 `IncidentSeverityEnum`（参考 enum-dictionary.md）：1=低危、2=中危、3=高危、4=严重，其余归信息

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：PhishCountQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTime | long | 是 | - | 统计开始时间（秒级时间戳） | 1750968000 |
| endTime | long | 是 | - | 统计结束时间（秒级时间戳） | 1783113600 |

> 注意：PhishCountQo 字段无 @JsonProperty 注解，JSON 字段名与 Java 字段名一致（startTime/endTime）。

## 返回参数

### 响应结构

接口直接返回 `IncidentSeverityVo`，无 `code`/`message`/`data` 包装。响应体即下方 data 结构。

### data 结构说明（来源：IncidentSeverityVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| infoNum | long | 信息事件数量 | IncidentSeverityEnum：参考 enum-dictionary.md。中文：-1/信息, 0/信息；国际版：-1/0 | 5 |
| lowNum | long | 低危事件数量 | IncidentSeverityEnum：参考 enum-dictionary.md。中文：1/低危；国际版：1 | 12 |
| midNum | long | 中危事件数量 | IncidentSeverityEnum：参考 enum-dictionary.md。中文：2/中危；国际版：2 | 8 |
| highNum | long | 高危事件数量 | IncidentSeverityEnum：参考 enum-dictionary.md。中文：3/高危；国际版：3 | 3 |
| criticalNum | long | 严重事件数量 | IncidentSeverityEnum：参考 enum-dictionary.md。中文：4/严重；国际版：4 | 1 |

## 调用示例

### 示例1：查询近 7 天事件等级分布

**请求示例**：
```json
{
    "startTime": 1750968000,
    "endTime": 1783113600
}
```

**响应示例**：
```json
{
    "infoNum": 5,
    "lowNum": 12,
    "midNum": 8,
    "highNum": 3,
    "criticalNum": 1
}
```

### 示例2：错误响应 - 缺少必填参数

**请求示例**：
```json
{
    "startTime": 1750968000
}
```

**错误响应示例**：
```json
{
    "code": 400,
    "message": "endTime cannot be null",
    "data": null
}
```

### 示例3：权限不足

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
- `startTime`/`endTime` 必填，秒级 10 位 Long
- 时间范围无最大跨度限制，但建议 ≤ 30 天以避免慢查询

### 参数依赖关系
- 无

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.getSeverityAnalysis.log"）

### 性能建议
- 单次查询按等级分组聚合，性能优于多次 `/incidents/list` 取 total
- 大屏态数据可缓存 5 分钟

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | startTime cannot be null | 缺少 startTime | 补全 startTime 字段 |
| 400 | endTime cannot be null | 缺少 endTime | 补全 endTime 字段 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **按业务时区计算时间范围**：startTime/endTime 用业务时区自然日/自然周起止转秒级时间戳
2. **缓存 5 分钟**：大屏态数据可前端缓存 5 分钟
3. **配合聚合接口**：如需同时按其他维度分组，改用 `/incidents/aggregation` 一次拿多维度
4. **配合趋势接口**：如需查看等级时间分布，用 `/incidents/trends` 按 severity 分组
5. **关注高危与严重**：highNum 与 criticalNum 突增时优先运营介入
