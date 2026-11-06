# POST /api/xdr/v1/incidents/timedelayduration

## 接口概述

本接口用于查询指定时间范围内事件的"时延事件数"与"时延时长总和"，支撑事件时延分析与 SLA 监控报表。通过本接口，您可以获取/操作以下内容：

### 可查询的时延统计信息
- **总量类**：时延事件数（allTimeDelayCount）、时延时长总和（allTimeDelay，单位秒）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件时延统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/averageduration` 平均处置/响应时长、`/incidents/detectiontime` 平均检测时长、`/incidents/aggregation` 通用聚合 |

## 使用场景

1. **SLA 监控**：时延事件数与时延总和用于计算平均时延，超阈值触发告警
2. **运营报表**：日报/周报中统计事件时延分布，识别响应缓慢的事件
3. **趋势对比**：配合 `/incidents/trends` 查看时延随时间变化
4. **配合处置时长接口**：本接口专注时延，配合 `/incidents/averageduration` 看处置/响应时长
5. **加白过滤**：通过 excludeWhite=true 默认过滤已加白数据，专注真实事件时延

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/timedelayduration |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentTimeDelayDurationQo`，含 `hostBranchId`/`platformIds`/`startTimestamp`/`endTimestamp`/`excludeWhite`/`timeField`
2. 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 补全时间范围；返回 null 时抛 `IncidentException("timestamp params failed")`
3. 调用 `openApiIncidentService.queryIncidentTimeDelayDuration(incidentDurationQo)`
4. Service 层调用 `timeValidate(startTimestamp, endTimestamp)` 校验时间字段与跨度（>180 天抛 `Time.span.greater.than.180`）
5. 调用 `incidentDao.queryTimeDelayDuration(incidentDurationQo)` 查询时延统计，返回 `OpenApiIncidentTimeDelayVo`
6. 封装 `OpenApiResponse` 返回

### 数据转换逻辑

- DAO 直接返回 `OpenApiIncidentTimeDelayVo`，含 allTimeDelayCount 与 allTimeDelay 两字段
- Service 层不做额外转换，仅做时间校验后透传

### 默认行为

- `excludeWhite` 默认 true（过滤已加白数据）
- `timeField` 默认 `IncidentTimeFieldTypeEnum.END_TIME.getTimeField()`=endTime
- 时间范围补全失败时直接抛异常，不返回默认空 VO

### 特殊规则

- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法取值，否则抛 `time.field.error`
- 时间跨度 > 180 天抛 `Time.span.greater.than.180` 异常
- `hostBranchId` 字段名注意：Java 字段名为 hostBranchId（单数），但通过 `@JsonAlias("branchIds")` 兼容旧字段名 branchIds
- `excludeWhite=true` 时过滤已加白事件，专注真实事件时延

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：OpenApiIncidentTimeDelayDurationQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| hostBranchId | array[integer] | 否 | - | 关联资产组ID（注意：Java 字段名 hostBranchId 单数，但类型为 List；通过 @JsonAlias("branchIds") 兼容旧字段名 branchIds；@Size(max=1000)） | [1, 2] |
| platformIds | array[string] | 否 | - | 平台ID（@Size(max=100)） | ["plat-1"] |
| startTimestamp | long | 否 | - | 起始时间（秒级时间戳） | 1750968000 |
| endTimestamp | long | 否 | - | 结束时间（秒级时间戳） | 1783113600 |
| excludeWhite | boolean | 否 | true | 是否过滤已加白数据，默认为是 | true |
| timeField | string | 否 | endTime | 时间字段，IncidentTimeFieldTypeEnum 取值，见下方枚举说明 | "endTime" |

> 注意：本 QO 字段无 @JsonProperty 注解（hostBranchId 用 @JsonAlias 兼容 branchIds），JSON 字段名按 Java 字段名（hostBranchId/platformIds/startTimestamp/endTimestamp/excludeWhite/timeField）。

#### timeField 枚举说明（IncidentTimeFieldTypeEnum）

| 取值 | 说明 |
|------|------|
| startTime | 事件开始时间 |
| endTime | 事件结束时间 |
| auditTime | 审核时间 |
| updateTime | 更新时间 |
| uploadTime | 上传时间 |
| occurTime | 发生时间 |
| disposeTime | 处置时间 |
| durationTimestamp | 时长时间戳 |
| insertTime | 入库时间 |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，结构见下方 data 说明 |

### data 结构说明（来源：OpenApiIncidentTimeDelayVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| allTimeDelayCount | long | 时延事件数 | ≥ 0 | 15 |
| allTimeDelay | long | 时延时长总和（单位秒） | ≥ 0 | 5400 |

## 调用示例

### 示例1：查询近 7 天事件时延统计

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "excludeWhite": true
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "allTimeDelayCount": 15,
        "allTimeDelay": 5400
    }
}
```

### 示例2：按资产组过滤查询时延

**请求示例**：
```json
{
    "hostBranchId": [1, 2],
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "allTimeDelayCount": 8,
        "allTimeDelay": 2400
    }
}
```

### 示例3：错误响应 - 时间范围补全失败

**请求示例**：
```json
{
    "startTimestamp": -1,
    "endTimestamp": -1
}
```

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "timestamp params failed",
    "data": null
}
```

### 示例4：错误响应 - 时间跨度超过 180 天

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "Time.span.greater.than.180",
    "data": null
}
```

### 示例5：权限不足

**错误响应示例**：
```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `hostBranchId` 列表大小 ≤ 1000
- `platformIds` 列表大小 ≤ 100
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法取值
- 时间跨度 ≤ 180 天，否则抛 `Time.span.greater.than.180`

### 参数依赖关系
- `hostBranchId` 与 `platformIds` 为 AND 关系
- `timeField` 决定时间范围作用的事件时间字段
- `excludeWhite=true` 时过滤已加白事件

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.lists.log"）

### 性能建议
- 时间跨度 ≤ 30 天性能最佳，> 30 天可能慢查询
- 配合 hostBranchId/platformIds 缩小查询范围

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- allTimeDelay 单位为秒
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | timestamp params failed | 时间范围补全失败（如 start>end） | 检查 startTimestamp ≤ endTimestamp |
| 500 | Time.span.greater.than.180 | 时间跨度 > 180 天 | 缩小时间范围至 ≤ 180 天 |
| 500 | time.field.error | timeField 非法 | 使用 IncidentTimeFieldTypeEnum 合法取值 |
| 400 | exception.validate.invalid.length | hostBranchId/platformIds 列表超长 | hostBranchId ≤ 1000，platformIds ≤ 100 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **按业务时区计算时间范围**：startTimestamp/endTimestamp 用业务时区自然日起止转秒级时间戳
2. **默认 excludeWhite=true**：保持默认即可，专注真实事件时延
3. **配合处置时长接口**：本接口专注时延，配合 `/incidents/averageduration` 看处置/响应时长
4. **关注平均时延**：allTimeDelay / allTimeDelayCount 即平均时延，超 SLA 阈值需运营介入
5. **缓存 5 分钟**：大屏态数据可前端缓存 5 分钟
