# GET /api/xdr/v1/incidents/incidentDataGeneration

## 接口概述

本接口用于巡检检查事件在指定时间范围内是否有新增数据，返回该时间范围内的新增事件数量。通过本接口，您可以获取以下内容：

### 可查询的统计信息
- **新增事件数量**：指定时间范围内（startTime ~ endTime）当前租户新增的安全事件总数（Long 类型）

### 可设置的过滤维度
- **开始时间戳**：startTime（秒级，必填，Query 参数）
- **结束时间戳**：endTime（秒级，必填，Query 参数）
- **隐式租户过滤**：按当前调用方的 tenantId 过滤（仅查当前租户的事件）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件巡检统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/incidents/list` 事件列表、`/api/xdr/v1/incidents/aggregation` 事件聚合 |

## 使用场景

1. **定时巡检**：定时（如每 5 分钟）调用本接口检查最近时段是否有新增事件，用于监控事件接入链路是否正常
2. **接入链路监控**：在运维大屏展示"最近 N 分钟新增事件数"，若长期为 0 提示接入链路可能故障
3. **数据补齐校验**：在数据补齐任务后调用本接口，校验补齐后的事件数量是否符合预期
4. **租户隔离巡检**：多租户场景下，每个租户调用本接口只看到自己的新增事件数
5. **SLA 告警触发**：当某时段新增事件数为 0 时触发告警，提示运营人员核查

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/incidents/incidentDataGeneration |
| Content-Type | application/x-www-form-urlencoded（GET Query 参数） |
| 权限要求 | superAdmin 或 incidentQuery（两者任一） |

## 业务逻辑

### 核心处理流程

1. **入参校验**（Controller 层）：
   - `startTime` / `endTime` 必填（@RequestParam(required=true)）
   - `startTime > endTime` 时抛 `IllegalArgumentException`，message 为 `START_TIME_LT_END_TIME` 对应的国际化文案（"开始时间不能大于结束时间"）
   - 时间范围超过 30 天（`endTime - startTime > 2595600 秒`）时抛 `IllegalArgumentException`，message 为 `START_TIME_RANGE30_END_TIME` 对应的国际化文案（"时间范围不能超过 30 天"）
2. **Service 调用**：调用 `incidentService.getIncidentDataGenerationByTenantId(startTime, endTime)`
3. **DAO 查询**：调用 `incidentDao.getIncidentDataGenerationByTenant(startTime, endTime)`，按当前租户 tenantId + 时间范围 [startTime, endTime] 统计新增事件数量（MongoDB 查询 t_incident 集合）
4. **异常处理**：Service 层捕获所有异常，记录 error 日志后返回 `OpenApiResponse.newInstance(0L)`（即异常时返回 0，不抛 500）
5. **构造返回**：返回 `OpenApiResponse<Long>`，data 为新增事件数量

### 数据转换逻辑

- DAO 返回 Long 类型计数
- Service 层包装为 `OpenApiResponse<Long>`
- 异常时返回 0L（不抛 500）

### 默认行为

- 时间范围由调用方显式传入（无默认值）
- 异常时返回 0L（业务约定：异常不抛错，返回 0 表示统计失败）

### 特殊规则

- **startTime 不能大于 endTime**：否则抛 `START_TIME_LT_END_TIME` 异常
- **时间范围不能超过 30 天**：30 天 = 2595600 秒（30 * 24 * 60 * 60 - 部分修正，实际为 2595600 而非 2592000），超出抛 `START_TIME_RANGE30_END_TIME` 异常
- **按当前租户过滤**：Service 层隐式按当前调用方的 tenantId 过滤，多租户场景下每个租户只看到自己的事件
- **异常返回 0**：DAO 层查询异常时返回 0L，不抛 500（避免巡检任务因单次失败而中断）
- **GET 请求**：本接口为 GET 请求，参数通过 Query 传，不是 POST body

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求可不传，默认 application/x-www-form-urlencoded |

### Query 参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTime | long | 是 | - | 开始时间戳（秒级，10 位 Long），不能大于 endTime | 1782604800 |
| endTime | long | 是 | - | 结束时间戳（秒级，10 位 Long），与 startTime 差值不能超过 30 天（2595600 秒） | 1783209600 |

> **注意**：本接口为 GET 请求，参数通过 URL Query 传，不是 POST body。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | long | 时间范围内新增事件数量（异常时返回 0） |

### data 字段说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| data | long | 时间范围 [startTime, endTime] 内当前租户新增的安全事件数量 | >= 0 | 128 |

## 调用示例

### 示例1：查询最近 7 天新增事件数

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1782604800&endTime=1783209600
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": 128
}
```

### 示例2：查询最近 1 天新增事件数（巡检场景）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1783123200&endTime=1783209600
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": 25
}
```

### 示例3：查询最近 30 天新增事件数（最大允许范围）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1749072000&endTime=1783209600
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": 1280
}
```

### 示例4：查询最近 1 小时新增事件数（高频巡检）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1751670000&endTime=1783209600
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": 5
}
```

### 示例5：查询无新增数据（接入链路异常场景）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1783123200&endTime=1783209600
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": 0
}
```

### 示例6：错误响应示例（startTime > endTime）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1783209600&endTime=1782604800
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "开始时间不能大于结束时间",
  "data": null
}
```

### 示例7：错误响应示例（时间范围超 30 天）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1746384000&endTime=1783209600
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "时间范围不能超过 30 天",
  "data": null
}
```

### 示例8：错误响应示例（缺少必填参数）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1782604800
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "Required Long parameter 'endTime' is not present",
  "data": null
}
```

### 示例9：DAO 异常时返回 0（不抛 500）

**请求示例**：
```
GET /api/xdr/v1/incidents/incidentDataGeneration?startTime=1782604800&endTime=1783209600
```

**响应示例**（DAO 查询异常时）：
```json
{
  "code": "Success",
  "message": "success",
  "data": 0
}
```

## 注意事项与限制

### 参数限制
- `startTime` / `endTime` 必填（GET Query 参数）
- `startTime` 必须 <= `endTime`，否则抛 `START_TIME_LT_END_TIME`
- `endTime - startTime` 必须 <= 2595600 秒（30 天），否则抛 `START_TIME_RANGE30_END_TIME`
- 时间戳为秒级 10 位 Long

### 参数依赖关系
- `startTime` 与 `endTime` 共同决定查询时间范围
- 隐式按当前调用方的 tenantId 过滤（不需要传 tenantId）

### 权限要求
- 需具备 `superAdmin` 或 `incidentQuery` 权限
- 多租户场景下，每个租户只看到自己的事件

### 性能建议
- 巡检场景建议时间窗口 5 分钟 ~ 1 小时，避免查询耗时
- 不要查询 30 天最大范围，性能较差
- 异常返回 0 时不一定是真的 0，需结合后端日志判断是否 DAO 异常

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800，2026-07-04 00:00:00 UTC = 1783123200，2026-06-05 00:00:00 UTC = 1749072000
- 30 天 = 2595600 秒（业务约定，比 2592000 略大）
- 返回的 data 为秒级时间范围内的新增事件数（按 tenantId 过滤）

### 使用注意事项
- **GET 请求**：本接口为 GET 请求，参数通过 URL Query 传，不是 POST body
- **时间范围限制 30 天**：超过 30 天抛异常，需分段查询
- **异常返回 0**：DAO 查询异常时返回 0L 不抛 500，对接时需结合业务判断（如长期为 0 需检查接入链路）
- **按租户隔离**：多租户场景下每个租户只看到自己的事件，不需传 tenantId
- **国际化 message**：异常 message 走 i18n 国际化（`START_TIME_LT_END_TIME` / `START_TIME_RANGE30_END_TIME`），中文/国际版文案不同

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | Required Long parameter 'startTime'/'endTime' is not present | 缺少必填 Query 参数 | 必传 startTime 和 endTime |
| 500 | 开始时间不能大于结束时间（i18n key: START_TIME_LT_END_TIME） | startTime > endTime | 修正时间范围 |
| 500 | 时间范围不能超过 30 天（i18n key: START_TIME_RANGE30_END_TIME） | endTime - startTime > 2595600 秒 | 缩小时间范围或分段查询 |
| 200（data=0） | DAO 查询异常 | 数据库异常被吞（HTTP 200 但 data 为 0，非真实结果） | 检查后端日志确认是否真的 0 还是异常 |

## 最佳实践

1. **定时巡检间隔**：建议每 5 分钟调用一次，时间窗口 5 分钟，监控接入链路健康度
2. **异常为 0 判断**：长期返回 0 时需检查接入链路，可能是 DAO 异常返回的 0 而非真实数据
3. **分段查询 30 天**：如需查 90 天，分 3 段每段 30 天查询，避免单次超限
4. **租户隔离利用**：多租户场景下每个租户独立调用，不需要传 tenantId
5. **GET 请求注意**：本接口为 GET 请求，参数在 URL Query，注意 URL 长度限制（时间戳很短不会有问题）
6. **SLA 告警**：当本接口返回 0 持续超过 30 分钟时触发告警，提示接入链路可能故障
7. **国际化对接**：异常 message 走 i18n，对接时需注意中文/国际版文案差异
