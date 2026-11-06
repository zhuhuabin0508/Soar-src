# POST /api/xdr/v1/incidents/dealrate

## 接口概述

本接口用于按指定时间字段和分组字段聚合统计安全事件的处置率，返回各分组的事件总数、各处置状态（待处置/处置中/处置完成/挂起/已忽略/已遏制）的事件数及处置率百分比，支撑 SLA 度量与处置效率分析场景。通过本接口，您可以获取/操作以下内容：

### 可查询的处置率信息
- **分组聚合**：按 aggBy 字段分组（必须使用 Incident 实体类字段名），limit 控制返回分组数（默认 5）
- **处置状态计数**：每个分组返回待处置（pending）、处置中（disposing）、处置完成（disposed）、挂起（hangup）、已忽略（ignored）、已遏制（suppress）的事件数
- **汇总指标**：每个分组返回事件总数（totalCount）与处置率（dealRate，百分比）
- **过滤维度**：时间范围（基于 timeField）、资产组ID（filterParam.hostBranchIds）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件处置率聚合 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/incidents/aggregation` 通用事件聚合、`/incidents/dealstatus/count` 处置状态数量统计、`/incidents/dealstatus/list` 处置状态列表 |

## 使用场景

1. **SLA 度量**：按资产组、事件等级等维度统计处置率，评估是否达到 SLA 目标
2. **处置效率分析**：按时间分布查看处置率变化，识别处置瓶颈
3. **责任团队对比**：按资产组分组对比各团队处置效率
4. **报表生成**：导出各分组的处置率数据用于定期报表
5. **待处置告警监控**：通过 pending/disposing 计数识别积压事件

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/dealrate |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentDealRateQo` 并校验
2. 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 处理时间范围，回填 startTimestamp/endTimestamp
3. 调用 `openApiIncidentService.getIncidentsDealRate(openApiIncidentDealRateQo)`
4. Service 内部：
   - 参数校验：startTimestamp/endTimestamp 非空（@NotNull）、timeField 非空且为 `IncidentTimeFieldTypeEnum` 合法值
   - aggBy 白名单校验：通过 `ClassUtil.classToMap(Incident.class)` 提取 Incident 实体所有字段名，aggBy 中每个字段必须存在于该 Map 中，否则返回空列表（不抛异常）
   - 调用 `incidentDao.getIncidentDealRate(incidentDealRateQo)` 执行聚合查询（DAO 层按 timeField/aggBy/limit/hostBranchIds 构造 MongoDB 聚合管道）
   - 处置率格式化（`formatIncidentDealRate`）：遍历每个分组，统计已处置事件数（dealCount，来自 IncidentDealStatusEnum 中标记 ifTreated=true 的状态计数），按四舍五入保留两位小数转百分比；处理"四舍五入后为100但实际未全处置"的边界情况
   - 特殊字段处理及富化（`enrichIncidentDealRateResult`）：对返回结果中的状态字段做国际化/枚举映射
   - 返回 `IncidentDealRateVo`（含 item 列表，每个元素为 Map）
5. Controller 返回 `OpenApiResponse<IncidentDealRateVo>`

### 数据转换逻辑
- DAO 返回 `List<Map>`，每个 Map 表示一个分组，含各处置状态计数、totalCount、dealRate
- 处置率百分比格式化：使用 `DecimalFormat("#.##")` 保留两位小数，不保留末尾 0
- 已处置事件数（dealCount）= 累加 IncidentDealStatusEnum 中 ifTreated=true 的状态（disposed/ignored/suppress）计数

### 默认行为
- `aggBy` 不传或为空时：返回单分组合计（不分组）
- `limit` 默认 5（@Min(1)），仅返回 Top N 分组，超出部分被静默截断
- `filterParam.hostBranchIds` 不传时：不过滤资产组

### 特殊规则
- **aggBy 字段名约束**：aggBy 必须使用 Incident 实体类的字段名（如 `severity`、`dealStatus`、`hostBranchId` 等），不能使用 JSON 别名；非法字段会被静默丢弃并返回空列表
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值（startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime）
- 处置率边界处理：四舍五入后为 100% 但 dealCount < totalCount 时，调整为 99.99%（避免显示 100% 但实际有未处置事件）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long） | 1750464000 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1782604800 |
| timeField | string | 是 | - | 过滤的时间字段，必须为 IncidentTimeFieldTypeEnum 合法值 | "updateTime" |
| aggBy | array[string] | 否 | [] | 分组字段，必须使用 Incident 实体类字段名 | ["severity"] |
| limit | integer | 否 | 5 | 数量限制，最小 1，仅返回 Top N 分组 | 5 |

**timeField 枚举值说明**（来源：IncidentTimeFieldTypeEnum）：

| 枚举值 | 说明 |
|--------|------|
| startTime | 事件开始时间 |
| endTime | 事件结束时间 |
| auditTime | 审计时间 |
| updateTime | 更新时间 |
| uploadTime | 上报时间 |
| occurTime | 发生时间 |
| disposeTime | 处置时间 |
| durationTimestamp | 时长时间戳 |
| insertTime | 入库时间 |

#### filterParam 结构说明（来源：IncidentDealRateFilterQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| hostBranchIds | array[long] | 否 | 资产组ID列表（注意 JSON 字段名 hostBranchIds，复数，由 @JsonProperty("hostBranchIds") 指定） | [101, 102] |

> 注意：filterParam 仅含 `hostBranchIds` 一个字段，无其他过滤维度。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：IncidentDealRateVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[map] | 处置率列表，每个元素为一个分组 Map，见下方 item 元素结构说明 |

### item 元素结构说明（来源：Map，字段名为 DAO 层聚合管道输出的 key）

> 注意：item 元素为 `Map<String, Object>`，字段名由聚合管道决定，固定字段如下：

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| totalCount | integer | 事件总数 | 100 |
| dealRate | double | 处置率（已格式化为百分比，保留两位小数） | 75.50 |
| pending | integer | 待处置事件数（来源 IncidentDealStatusEnum.PENDING，statusCode=1） | 25 |
| disposing | integer | 处置中事件数（来源 IncidentDealStatusEnum.DISPOSING，statusCode=2） | 10 |
| disposed | integer | 处置完成事件数（来源 IncidentDealStatusEnum.DISPOSED，statusCode=3） | 50 |
| hangup | integer | 挂起事件数（来源 IncidentDealStatusEnum.HANGUP，statusCode=4） | 5 |
| ignored | integer | 已忽略事件数（来源 IncidentDealStatusEnum.IGNORED，statusCode=5） | 5 |
| suppress | integer | 已遏制事件数（来源 IncidentDealStatusEnum.SUPPRESS，statusCode=6） | 5 |
| {aggBy字段} | object | 分组字段的值（字段名同 aggBy 中传入的字段名） | 4 |

**IncidentDealStatusEnum 处置状态对照表**（参考 enum-dictionary.md）：

| 值 | 枚举常量名 | 国际化值（中文） | ifTreated | 是否计入 dealCount |
|----|-----------|------------------|-----------|---------------------|
| 1 | PENDING | 待处置 | false | 否 |
| 2 | DISPOSING | 处置中 | false | 否 |
| 3 | DISPOSED | 处置完成 | true | 是 |
| 4 | HANGUP | 挂起 | false | 否 |
| 5 | IGNORED | 已忽略 | true | 是 |
| 6 | SUPPRESS | 已遏制 | true | 是 |

> dealCount = disposed + ignored + suppress；dealRate = dealCount / totalCount * 100%。

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "severity": 4,
                "totalCount": 50,
                "dealRate": 80.00,
                "pending": 5,
                "disposing": 5,
                "disposed": 30,
                "hangup": 2,
                "ignored": 3,
                "suppress": 5
            },
            {
                "severity": 3,
                "totalCount": 30,
                "dealRate": 66.67,
                "pending": 5,
                "disposing": 5,
                "disposed": 15,
                "hangup": 1,
                "ignored": 2,
                "suppress": 2
            }
        ]
    }
}
```

## 调用示例

### 示例1：按事件等级分组统计处置率

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "updateTime",
    "aggBy": ["severity"],
    "limit": 5
}
```

### 示例2：按资产组过滤并按处置状态分组

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "updateTime",
    "filterParam": {
        "hostBranchIds": [101, 102]
    },
    "aggBy": ["dealStatus"],
    "limit": 10
}
```

### 示例3：不分组 - 查询全部事件处置率

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "updateTime"
}
```

### 示例4：错误响应 - timeField 不合法

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "invalidField"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param timeField is invalid",
    "data": null
}
```

### 示例5：错误响应 - startTimestamp 为空

**请求示例**：
```json
{
    "endTimestamp": 1782604800,
    "timeField": "updateTime"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "empty start time",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp`/`endTimestamp` 必填（@NotNull），秒级 10 位 Long
- `timeField` 必填，必须为 `IncidentTimeFieldTypeEnum` 合法值
- `limit` 最小 1，默认 5
- `filterParam.hostBranchIds` 元素类型为 Long

### 参数依赖关系
- `aggBy` 与 `limit` 配合使用：aggBy 决定分组维度，limit 决定返回 Top N 分组数
- `aggBy` 为空时返回单分组合计

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.aggregation.log"）

### 性能建议
- 时间范围建议不超过 7 天
- `limit` 不宜过大，建议保持默认 5 或 10

### 使用注意事项
- **aggBy 字段名约束**：aggBy 必须使用 Incident 实体类字段名（如 `severity`、`dealStatus`、`hostBranchId`），不能使用 JSON 别名；非法字段会被静默丢弃并返回空列表（不抛异常）
- **limit 默认 5 静默截断**：不传 limit 时默认 5，仅返回 Top 5 分组，其余分组被静默截断，不报错；如需更多分组需显式传 limit

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 处置率（dealRate）已格式化为百分比（如 75.50 表示 75.50%）
- 已处置事件数（dealCount）= disposed + ignored + suppress（来源 IncidentDealStatusEnum 中 ifTreated=true 的状态）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | empty start time | startTimestamp 为空 | 传入 startTimestamp |
| 400 | empty end time | endTimestamp 为空 | 传入 endTimestamp |
| 400 | param timeField is invalid | timeField 不在枚举范围 | 使用合法值：startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | exception.method.execute | 查询执行异常 | 联系技术支持 |

## 最佳实践

1. **aggBy 字段核对**：调用前先确认 Incident 实体类字段名（如 `severity` 而非 `incidentSeverity`），避免静默返回空列表
2. **limit 显式传值**：业务上需要更多分组时，显式传 limit（如 10/20），避免被默认值 5 截断
3. **timeField 选择**：按业务需求选择时间字段，处置率分析建议用 `disposeTime` 或 `updateTime`
4. **资产组过滤**：通过 filterParam.hostBranchIds 限定范围，避免跨资产组聚合
5. **百分比展示**：dealRate 已是百分比数值，前端直接拼接 "%" 展示即可，无需再乘以 100
