# POST /api/xdr/v1/incidents/suppress

## 接口概述

本接口用于查询指定时间范围内"自动遏制事件数"与"事件总数"两项指标，支撑自动遏制率统计与运营报表。通过本接口，您可以获取/操作以下内容：

### 可查询的遏制统计信息
- **自动遏制类**：自动遏制事件数（autoSuppressIncidentCnt）
- **总量类**：事件总数（incidentCnt）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 自动遏制统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/suppressduration` 总遏制时长、`/incidents/dealstatus/count` 处置状态统计、`/incidents/aggregation` 通用聚合 |

## 使用场景

1. **自动遏制率展示**：大屏卡片展示 autoSuppressIncidentCnt / incidentCnt 计算自动遏制率
2. **运营报表**：日报/周报中统计自动遏制事件占比，量化自动化处置能力
3. **趋势对比**：配合 `/incidents/trends` 查看事件与遏制时间分布
4. **效果评估**：评估自动遏制策略覆盖度，配合 `/incidents/suppressduration` 评估遏制时长
5. **异常识别**：自动遏制率突降时排查策略失效或事件类型变化

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/suppress |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentSuppressQo`，含 `startTimestamp`/`endTimestamp`（可空）
2. 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 补全时间范围
3. 将补全后的时间戳写回 Qo
4. 调用 `openApiIncidentService.getSuppress(openApiIncidentSuppressQo)`
5. Service 层校验 `startTime`/`endTime` 非 null，为 null 时返回 CODE_UNKNOWN 错误响应
6. 调用 `incidentDao.countIncidentsWithoutRegion(startTime, endTime)` 查询事件总数
7. 调用 `incidentDao.getIncidentsByDealStatus(List.of(IncidentDealStatusEnum.SUPPRESS.getStatusCode()), startTime, endTime, AUTO_DISPOSE_LIST_INCIDENT_COUNT)` 查询已遏制（statusCode=6）事件
8. 过滤 `isAutoDispose=true` 的事件，得到自动遏制事件列表
9. 设置 `incidentCnt` 与 `autoSuppressIncidentCnt` 返回

### 数据转换逻辑

- DAO 返回 `Incident` 列表，Stream filter `isAutoDispose=true` 后取 size 作为自动遏制数
- `IncidentDealStatusEnum.SUPPRESS.getStatusCode()`=6（已遏制，参考 enum-dictionary.md）

### 默认行为

- `startTimestamp`/`endTimestamp` 为 null 时由 `OpenApiTimeRangeUtil.resolveTimestamp` 按默认策略补全（具体逻辑见工具类）
- VO 默认 `autoSuppressIncidentCnt=0`、`incidentCnt=0`（@Builder 默认）

### 特殊规则

- 自动遏制判定：`dealStatus=6`（已遏制）且 `isAutoDispose=true`，二者同时满足
- 接口返回 `OpenApiResponse<OpenApiIncidentSuppressVo>`，含 code/message/data 包装
- 时间范围缺失时返回 CODE_UNKNOWN（非 400 校验错误，而是业务错误码）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：OpenApiIncidentSuppressQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 否 | - | 起始时间（秒级时间戳） | 1750968000 |
| endTimestamp | long | 否 | - | 结束时间（秒级时间戳） | 1783113600 |

> 注意：OpenApiIncidentSuppressQo 字段无 @JsonProperty 注解，JSON 字段名与 Java 字段名一致（startTimestamp/endTimestamp）。字段标注 `@Nullable`，可空。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，结构见下方 data 说明 |

### data 结构说明（来源：OpenApiIncidentSuppressVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| autoSuppressIncidentCnt | integer | 自动遏制事件数 | ≥ 0 | 10 |
| incidentCnt | integer | 事件总数 | ≥ 0 | 100 |

## 调用示例

### 示例1：查询近 7 天自动遏制统计

**请求示例**：
```json
{
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
        "autoSuppressIncidentCnt": 10,
        "incidentCnt": 100
    }
}
```

### 示例2：错误响应 - 时间范围缺失

**请求示例**：
```json
{}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "startTime and endTime can not be null!",
    "data": null
}
```

### 示例3：权限不足

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
- `startTimestamp`/`endTimestamp` 虽标注可空，但 Service 层强制校验非 null，缺失会返回 CODE_UNKNOWN 业务错误
- 时间戳为秒级 10 位 Long

### 参数依赖关系
- 无

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.suppress.log"）

### 性能建议
- 单次查询含两次 DAO 调用（count + list filter），建议时间范围 ≤ 30 天
- 大屏态数据可缓存 5 分钟

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| HTTP | code | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | "InvalidParameter" | startTime and endTime can not be null（时间范围为空） | 补全 startTimestamp 与 endTimestamp |
| 403 | "Unknown.SerComError" | Access Denied（权限不足） | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **始终传入时间范围**：避免触发 Service 层 CODE_UNKNOWN 错误
2. **按业务时区计算时间范围**：startTime/endTime 用业务时区自然日起止转秒级时间戳
3. **缓存 5 分钟**：大屏态数据可前端缓存 5 分钟
4. **配合 suppressduration**：遏制数配合 `/incidents/suppressduration` 评估遏制时长
5. **关注遏制率**：autoSuppressIncidentCnt / incidentCnt 比值即自动遏制率，持续走低需排查策略
