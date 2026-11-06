# POST /api/xdr/v1/incidents/trends

## 接口概述

本接口用于按时间分桶统计指定时间范围内的安全事件趋势，支持按 aggBy 字段分组、按 aggFuncs 聚合、按 interval 时间间隔分桶，并对缺失时间点补零，支撑事件趋势图大屏展示。通过本接口，您可以获取/操作以下内容：

### 可查询的趋势信息
- **趋势数据列表**：每个分组含 name 与 item（时间点+值列表）
- **分组维度**：通过 aggBy 指定（如 severity、dealStatus 等 Incident 实体字段）
- **聚合函数**：通过 aggFuncs 指定（count/distinct 等）
- **时间分桶**：通过 interval 指定（1m/1H/1d/1M，大小写敏感）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件趋势统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/aggregation` 通用聚合、`/incidents/list` 事件列表、`/incidents/severity/count` 等级统计、`/alerts/trends` 告警趋势 |

## 使用场景

1. **趋势图大屏**：渲染事件时间分布折线图，按时间分桶统计事件数
2. **等级时间分布**：aggBy=severity 按等级分组展示各等级事件时间分布
3. **处置状态时间分布**：aggBy=dealStatus 按处置状态分组展示状态变化趋势
4. **多维度分组**：aggBy 多字段组合（如 severity+dealStatus）展示多维交叉趋势
5. **配合聚合接口**：本接口看时间分布，配合 `/incidents/aggregation` 看分组总数

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/trends |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentTrendQo`，含 `startTimestamp`/`endTimestamp`/`timeField`/`filterParam`/`aggBy`/`aggFuncs`/`interval`/`timeZone`
2. 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 补全时间范围
3. 调用 `openApiIncidentService.getIncidentsTrendsResult(openApiIncidentTrendQo)`
4. Service 层校验：若 `timeZone` 为空，取 `UserInfoShareHolder.getUserInfo().getTimeZone()` 兜底
5. aggBy 合法性校验：将 `Incident.class` 转为 `Map<字段名, 字段类型>`，校验 aggBy 中所有字段名存在于 Incident 字段中；不存在则返回空 item 列表
6. 调用 `incidentDao.getIncidentTrendResult(openApiIncidentTrendQo)` 执行趋势查询，返回 `List<Map>`
7. 调用 `TimeSeriesGenerator.fillingTimeByInterval(startTimestamp, endTimestamp, interval, timeZone)` 生成完整时间点列表用于补零
8. 若查询结果为空，构造默认分组（name=国际化"安全事件"，item=所有时间点 value=0）返回
9. 若查询结果非空，按 aggBy 字段分组组装：每个分组 name 为 aggBy 字段值对象（多字段时为 Map），item 为时间点+值列表，对缺失时间点补零
10. 返回 `OpenApiResponse<OpenApiTrendResult>`

### 数据转换逻辑

- DAO 返回 `List<Map>`，每项含 `_id`（分组 key，多字段时为 Map）与各时间桶数据
- 按 aggBy 字段组装分组 name：单字段时为字段值，多字段时为 `Map<字段名, 字段值>`
- 时间点通过 `TimeSeriesGenerator.fillingTimeByInterval` 生成完整序列，缺失补零
- 无 aggBy 时分组 name 默认为 i18n 的"安全事件"

### 默认行为

- `timeZone` 为空时取用户上下文 timeZone
- aggBy 为空时所有数据归入默认分组（name=国际化"安全事件"）
- 查询结果为空时返回默认分组，item 为所有时间点 value=0
- 缺失时间点自动补零

### 特殊规则

- aggBy 必须为 `Incident` 实体类字段名（通过 `classToMap(Incident.class)` 校验），非法字段直接返回空
- `interval` 必须为 `TrendIntervalFieldTypeEnum` 合法取值（1m/1H/1d/1M），**大小写敏感**（1H 大写 H、1M 大写 M）
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法取值
- `aggFuncs` 必填非空
- 接口返回 `OpenApiResponse<OpenApiTrendResult>`，含 code/message/data 包装

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：OpenApiIncidentTrendQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 起始时间（秒级时间戳） | 1750968000 |
| endTimestamp | long | 是 | - | 结束时间（秒级时间戳） | 1783113600 |
| timeField | string | 是 | - | 过滤的时间字段，IncidentTimeFieldTypeEnum 取值，见下方枚举说明 | "endTime" |
| filterParam | object | 否 | - | 其他过滤字段，结构见下方 OpenApiIncidentTrendFilterQo | {"severities":[3,4]} |
| aggBy | array[string] | 否 | - | 分组字段，必须为 Incident 实体类字段名 | ["severity"] |
| aggFuncs | array[AggFuncsDTO] | 是 | - | 聚合操作列表，结构见下方 AggFuncsDTO | 见示例 |
| interval | string | 是 | - | 时间间隔，TrendIntervalFieldTypeEnum 取值，见下方枚举说明（大小写敏感） | "1H" |
| timeZone | string | 否 | - | 时区，为空时取用户上下文 timeZone | "Asia/Shanghai" |

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

#### interval 枚举说明（TrendIntervalFieldTypeEnum，**大小写敏感**）

| 取值 | 说明 | 备注 |
|------|------|------|
| 1m | 每分钟 | 小写 m |
| 1H | 每小时 | **大写 H**（不是小写 h，写成 1h 会被 default 分支吞掉返回空） |
| 1d | 每天 | 小写 d |
| 1M | 每月 | **大写 M** |

#### aggFuncs 结构说明（OpenApiIncidentTrendQo.AggFuncsDTO）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| name | string | 否 | - | 聚合结果名称 | "count" |
| param | string | 否 | - | 聚合字段 | "*" |

> 注意：AggFuncsDTO 字段名以 @JsonProperty 为准（name/param）。Incident 趋势接口的 AggFuncsDTO 未定义 func 字段（与告警趋势略有差异），实际聚合函数由 DAO 层根据 name 推断。

#### filterParam 结构说明（OpenApiIncidentTrendFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| severities | array[integer] | 否 | - | 事件等级，IncidentSeverityEnum 取值（参考 enum-dictionary.md：-1/0/1/2/3/4） | [3, 4] |
| hostAssetIds | array[integer] | 否 | - | 资产id（数据库字段：hostAssetId） | [1001] |
| hostIps | array[string] | 否 | - | 主机ip（数据库字段：hostIp） | ["192.168.1.10"] |
| hostBranchIds | array[integer] | 否 | - | 资产组id（注意：JSON 字段名 hostBranchIds 复数，由 @JsonProperty("hostBranchIds") 指定） | [1, 2] |
| platformHostBranchIds | array[string] | 否 | - | 平台资产组id | ["p1"] |
| hostBusinessIds | array[integer] | 否 | - | 所属业务（数据库字段：hostGroupIds） | [10] |
| platformHostBusinessIds | array[string] | 否 | - | 所属业务平台（数据库字段：platformHostGroupIds） | ["pb1"] |
| platformIds | array[string] | 否 | - | 平台id | ["plat-1"] |
| whiteStatus | array[string] | 否 | - | 加白状态，WhiteStatusEnum（参考 enum-dictionary.md：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2"） | ["未加白"] |
| dealStatus | array[integer] | 否 | - | 处置状态，IncidentDealStatusEnum（参考 enum-dictionary.md：1/2/3/4/5/6） | [1, 2] |
| devSourceNames | array[string] | 否 | - | 设备来源 | ["EDR"] |

> 注意：filterParam 字段名全部以 @JsonProperty 为准（severities/hostAssetIds/hostIps/hostBranchIds/platformHostBranchIds/hostBusinessIds/platformHostBusinessIds/platformIds/whiteStatus/dealStatus/devSourceNames）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，结构见下方 data 说明 |

### data 结构说明（来源：OpenApiTrendResult）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| item | array[object] | 数据列表，每项为分组对象，结构见下方 item 结构 | 见示例 |

### item 元素结构说明（OpenApiTrendResult.ItemDTO）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string/object | 分组名称（无 aggBy 时为国际化"安全事件"，有 aggBy 时为字段值对象） | "安全事件" 或 {"severity":3} |
| item | array[Items] | 时间点+值列表，见下方 Items 结构 | 见示例 |

### Items 结构说明（OpenApiTrendResult.Items）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 时间点（秒级时间戳字符串形式） | "1750968000" |
| value | integer | 该时间点的统计值 | 12 |

## 调用示例

### 示例1：查询近 7 天按小时分桶的事件趋势

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "aggFuncs": [{"name": "count", "param": "*"}],
    "interval": "1H"
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "name": "安全事件",
                "item": [
                    {"name": "1750968000", "value": 5},
                    {"name": "1750971600", "value": 8},
                    {"name": "1750975200", "value": 12}
                ]
            }
        ]
    }
}
```

### 示例2：按等级分组查询近 7 天事件趋势

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "aggBy": ["severity"],
    "aggFuncs": [{"name": "count", "param": "*"}],
    "interval": "1d",
    "filterParam": {
        "severities": [3, 4]
    }
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "name": {"severity": 3},
                "item": [
                    {"name": "1750968000", "value": 4},
                    {"name": "1751054400", "value": 6}
                ]
            },
            {
                "name": {"severity": 4},
                "item": [
                    {"name": "1750968000", "value": 1},
                    {"name": "1751054400", "value": 2}
                ]
            }
        ]
    }
}
```

### 示例3：错误响应 - interval 大小写错误

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "aggFuncs": [{"name": "count", "param": "*"}],
    "interval": "1h"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param interval is invalid value. ",
    "data": null
}
```

### 示例4：错误响应 - aggBy 字段不存在

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "aggBy": ["nonExistField"],
    "aggFuncs": [{"name": "count", "param": "*"}],
    "interval": "1H"
}
```

**响应示例**（校验失败返回空 item）：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": []
    }
}
```

### 示例5：错误响应 - 缺少必填参数

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
    "aggFuncs": [{"name": "count", "param": "*"}]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "interval cannot be null",
    "data": null
}
```

### 示例6：权限不足

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
- `startTimestamp`/`endTimestamp`/`timeField`/`aggFuncs`/`interval` 必填
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法取值
- `interval` 必须为 `TrendIntervalFieldTypeEnum` 合法取值，**大小写敏感**（1H 大写 H、1M 大写 M，写成小写会被 default 分支吞掉返回空）
- `aggBy` 中字段名必须为 `Incident` 实体类字段名（如 severity、dealStatus、incidentThreatClass 等），非法字段直接返回空 item
- `aggFuncs` 必须非空

### 参数依赖关系
- `filterParam` 内字段之间为 AND 关系
- `timeField` 决定时间范围作用的事件时间字段
- `interval` 与时间范围共同决定时间桶数量，建议桶数 ≤ 1000 避免响应过大
- **filterParam.dealStatus 是内部状态码 1-6**：本接口直接传 dealStatus 到 MongoDB 查询，DAO 层**不做 TMG 转换**，用户必须传内部 IncidentDealStatusEnum 值（1/待处置, 2/处置中, 3/处置完成, 4/挂起, 5/已忽略, 6/已遏制）。注意：`/incidents/aggregation` 和 `/incidents/asset/aggregation` 接口的 dealStatus 入参使用 TMG 状态码（0/10/20/30/40/50/60/70/80），调用前需核对每个接口的取值口径，不要混用

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.trends.log"）

### 性能建议
- 时间跨度与 interval 配合：1m 适合 ≤ 1 天，1H 适合 ≤ 30 天，1d 适合 ≤ 1 年，1M 适合 ≤ 多年
- aggBy 字段数 ≤ 3 避免分组爆炸
- 大屏态数据可缓存 5 分钟

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 返回 item 中 name 字段为时间桶起始点的秒级时间戳字符串形式
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | startTimestamp cannot be null | startTimestamp 缺失 | 补全 startTimestamp |
| 400 | endTimestamp cannot be null | endTimestamp 缺失 | 补全 endTimestamp |
| 400 | timeField cannot be null | timeField 缺失 | 补全 timeField |
| 400 | interval cannot be null | interval 缺失 | 补全 interval |
| 400 | param interval is invalid value. | interval 非法或大小写错误 | 使用 1m/1H/1d/1M（注意大小写） |
| 400 | param timeField is invalid value. | timeField 非法 | 使用 IncidentTimeFieldTypeEnum 合法取值 |
| 400 | aggFuncs cannot be empty | aggFuncs 为空 | 补全 aggFuncs |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **interval 大小写敏感**：必须写 1m/1H/1d/1M，1H 与 1M 大写，写成小写会被吞掉返回空
2. **aggBy 用实体字段名**：aggBy 必须为 Incident 实体类字段名（如 severity），非驼峰别名（如 incidentSeverity 不可用）
3. **时间跨度与 interval 匹配**：1m 适合短时间范围，1d 适合长时间范围，避免桶数过多
4. **缺失时间点自动补零**：返回的 item 包含完整时间点序列，无需客户端补零
5. **配合聚合接口**：本接口看时间分布，配合 `/incidents/aggregation` 看分组总数
