# POST /api/xdr/v1/incidents/detectiontime

## 接口概述

本接口用于按时间范围、资产组、事件等级、平台等条件统计事件的平均检测时长、超时数量、未超时数量、最大超时时长等指标，支撑 SLA 度量与检测效率分析场景。通过本接口，您可以获取/操作以下内容：

### 可查询的检测时长指标
- **总检测时长**：所有事件的总检测时长（allDetectionDuration，单位秒）
- **总检测时长数量**：参与统计的事件数量（detectionDurationCount）
- **超时统计**：总超时检测时长（allTimeoutDetectionDuration）、总超时检测时长数量（allTimeoutDetectionDurationCount）、最大超时检测时长（maxTimeoutDetectionDuration）
- **未超时统计**：总未超时检测时长（allNoTimeoutDetectionDuration）、总未超时检测时长数量（allNoTimeoutDetectionDurationCount）
- **SLA 比例**：SLA规定响应比例（slaStrandsResponseRatio）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件检测时长统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/incidents/averageduration` 平均处置/响应时长、`/incidents/timedelayduration` 平均时延时长、`/incidents/durationlist` 时长列表 |

## 使用场景

1. **SLA 度量**：统计事件检测时长是否满足 SLA 标准，识别超时事件
2. **检测效率分析**：按时间分布查看检测时长变化，识别检测瓶颈
3. **超时事件监控**：通过 allTimeoutDetectionDurationCount 监控超时事件数量
4. **报表生成**：导出检测时长指标用于定期报表
5. **配置校准**：根据实际检测时长分布调整 detectionDurationStandard 阈值

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/detectiontime |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentDurationQo` 并校验
2. 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，若返回 null 则抛 `IncidentException("exception.param.time.error")`
3. 调用 `openApiIncidentService.queryIncidentDetectionTime(incidentDurationQo)`
4. Service 内部：
   - 调用 `timeValidate(startTimestamp, endTimestamp)` 校验时间合法性
   - 调用 `incidentDao.queryIncidentUuidList(incidentDurationQo, true)` 查询符合条件的需要统计检测时长的事件ID列表
   - 调用 `mssIncidentServiceStatusService.getDetectionDuration(uuidList)` 获取每个事件的检测时长
   - 若结果列表为空，返回空 `OpenApiIncidentDetectionTimeVo`
   - 遍历事件检测时长，按 `detectionDurationStandard` 阈值统计：
     - 累加 allDetectionDuration
     - 若 detectionTime > detectionDurationStandard：超时计数+1、累加超时时长、更新 maxTimeoutDetectionDuration
     - 否则：未超时计数+1、累加未超时时长
   - 构造 `OpenApiIncidentDetectionTimeVo` 并返回
5. Controller 返回 `OpenApiResponse<OpenApiIncidentDetectionTimeVo>`

### 数据转换逻辑
- DAO 返回事件ID列表 → 调用 mssIncidentServiceStatusService 获取检测时长 → 累加统计
- 检测时长单位为秒级 Long

### 默认行为
- `statisticallyEmpty` 默认 false（相关字段无值的数据不加入统计）
- `excludeWhite` 默认 true（过滤已加白数据）
- `timeField` 默认 `endTime`（来源：`IncidentTimeFieldTypeEnum.END_TIME`）
- `detectionDurationStandard` 必填（无默认值，未传则视为 0，所有事件都会被判定为超时）

### 特殊规则
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值，否则返回 400 (`timeField is illegal`)
- `hostBranchId` 最多 1000 个元素（@Size(max=1000)）
- `platformIds` 最多 100 个元素（@Size(max=100)）
- `severities` JSON 字段名通过 `@JsonProperty("severities")` 指定
- `hostBranchId` 同时支持 `@JsonAlias("branchIds")` 别名
- `dealTimeDurationStandardList` 最多 20 个元素（@Size(max=20)），DurationStandardQo 含 level/value 字段，value 单位为毫秒
- 时间范围解析失败时抛 `IncidentException("exception.param.time.error")`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long） | 1750464000 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long） | 1782604800 |
| timeField | string | 否 | endTime | 时间字段，IncidentTimeFieldTypeEnum 合法值 | "endTime" |
| hostBranchId | array[integer] | 否 | - | 关联资产组ID，最多 1000 个元素（支持别名 branchIds） | [101] |
| severities | array[integer] | 否 | - | 事件等级（JSON 字段名 severities，由 @JsonProperty 指定） | [3, 4] |
| platformIds | array[string] | 否 | - | 平台ID，最多 100 个元素 | ["platform_001"] |
| statisticallyEmpty | boolean | 否 | false | 相关字段无值的数据是否加入统计 | false |
| detectionDurationStandard | long | 否 | - | 检测时长超时标准（单位毫秒） | 3600000 |
| dealTimeDurationStandardList | array[DurationStandardQo] | 否 | - | 处置时长超时标准列表，最多 20 个元素 | [{"level": 3, "value": 7200000}] |
| responseTimeDurationStandard | array[DurationStandardQo] | 否 | - | 响应时长超时标准列表 | [{"level": 3, "value": 3600000}] |
| excludeWhite | boolean | 否 | true | 是否过滤已加白数据 | true |

**DurationStandardQo 结构说明**：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| level | integer | 是 | 超时标准风险等级 | 3 |
| value | long | 是 | 超时时长（单位毫秒） | 3600000 |

> 注意：DurationStandardQo 在 `OpenApiIncidentDurationQo` 中 value 单位为毫秒，但在 `OpenApiIncidentDurationListQo` 中 value 单位为秒（源码 DurationStandardQo.java 注释为"超时时长（单位秒）"）。调用时需根据接口区分单位。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：OpenApiIncidentDetectionTimeVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| allDetectionDuration | long | 总检测时长（单位秒） | 18000 |
| allNoTimeoutDetectionDurationCount | long | 总未超时的检测时长数量 | 8 |
| allTimeoutDetectionDuration | long | 总超时检测时长（单位秒） | 7200 |
| allNoTimeoutDetectionDuration | long | 总未超时检测时长（单位秒） | 10800 |
| allTimeoutDetectionDurationCount | long | 总超时检测时长数量 | 2 |
| detectionDurationCount | long | 总检测时长数量 | 10 |
| maxTimeoutDetectionDuration | long | 最大超时检测时长（单位秒） | 5400 |
| slaStrandsResponseRatio | double | SLA规定响应比例 | 80.0 |

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "allDetectionDuration": 18000,
        "allNoTimeoutDetectionDurationCount": 8,
        "allTimeoutDetectionDuration": 7200,
        "allNoTimeoutDetectionDuration": 10800,
        "allTimeoutDetectionDurationCount": 2,
        "detectionDurationCount": 10,
        "maxTimeoutDetectionDuration": 5400,
        "slaStrandsResponseRatio": 80.0
    }
}
```

## 调用示例

### 示例1：统计最近 7 天事件检测时长

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "endTime",
    "detectionDurationStandard": 3600000
}
```

### 示例2：按资产组与等级筛选

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "hostBranchId": [101, 102],
    "severities": [3, 4],
    "detectionDurationStandard": 3600000
}
```

### 示例3：错误响应 - 时间范围不合法

**请求示例**：
```json
{
    "startTimestamp": 1782604800,
    "endTimestamp": 1750464000,
    "detectionDurationStandard": 3600000
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "exception.param.time.error",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `hostBranchId` 最多 1000 个元素
- `platformIds` 最多 100 个元素
- `dealTimeDurationStandardList` 最多 20 个元素
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值

### 参数依赖关系
- `startTimestamp`/`endTimestamp` 配合使用，时间范围由 `OpenApiTimeRangeUtil.resolveTimestamp` 处理
- `detectionDurationStandard` 决定超时判定阈值，未传则视为 0

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.lists.log"）

### 性能建议
- 时间范围建议不超过 7 天
- `hostBranchId`/`platformIds` 数量不宜过多，建议 100 以内

### 使用注意事项
- **detectionDurationStandard 单位毫秒**：检测时长超时标准单位为毫秒（如 3600000 表示 1 小时）
- **返回时长单位秒**：返回的时长字段单位为秒，与入参的毫秒单位不同
- **statisticallyEmpty 默认 false**：默认不统计相关字段无值的事件，需统计时显式传 true
- **excludeWhite 默认 true**：默认过滤已加白事件，需包含时显式传 false

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 入参 detectionDurationStandard 单位为毫秒，返回时长字段单位为秒，单位不同需注意

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | timeField is illegal | timeField 不在枚举范围 | 使用 IncidentTimeFieldTypeEnum 合法值 |
| 400 | exception.param.time.error | 时间范围不合法（如 start > end） | 检查时间范围 |
| 400 | exception.validate.invalid.length | 字段元素数量超限 | 控制 hostBranchId/platformIds 元素数量 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | exception.method.execute | 查询执行异常 | 联系技术支持 |

## 最佳实践

1. **detectionDurationStandard 显式传值**：必传超时标准，避免被判定为 0 导致所有事件超时
2. **单位换算**：入参毫秒、返回秒，调用方需注意单位换算
3. **资产组筛选**：通过 hostBranchId 限定范围，避免跨资产组统计
4. **配合 durationlist**：如需查看单事件检测时长明细，使用 `/incidents/durationlist` 接口
5. **SLA 比例展示**：slaStrandsResponseRatio 已是百分比数值，前端直接拼接 "%" 展示
