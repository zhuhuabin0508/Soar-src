# POST /api/xdr/v1/incidents/suppressduration

## 接口概述

本接口用于查询指定时间范围内已遏制事件的总遏制时长、事件数与按等级分布的遏制时长明细，支撑遏制效果分析与运营报表。通过本接口，您可以获取/操作以下内容：

### 可查询的遏制时长信息
- **总量类**：总遏制时长（allSuppressDuration，单位秒）、统计遏制时长的事件数量（suppressCount）
- **等级分布类**：按等级分布的遏制时长列表（severitySuppressList），每项含 severity/severityCount/severityTotalDuration

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 遏制时长统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/suppress` 自动遏制事件数、`/incidents/severity/count` 事件等级统计、`/incidents/aggregation` 通用聚合 |

## 使用场景

1. **遏制效果分析**：评估自动遏制策略对高危事件的遏制时长，量化响应速度
2. **等级分布报表**：按等级展示各等级遏制时长，识别哪类事件遏制最快/最慢
3. **SLA 监控**：总遏制时长与事件数比值即平均遏制时长，超阈值触发告警
4. **趋势对比**：配合 `/incidents/trends` 查看遏制时长随时间变化
5. **运营报表**：日报/周报中统计遏制时长分布

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/suppressduration |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentSuppressDurationQo`，含 `startTimestamp`/`endTimestamp`/`timeField`/`filterParam`
2. 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 补全时间范围；返回 null 时抛 `IncidentException("timestamp params failed")`
3. 调用 `openApiIncidentService.queryIncidentSuppressTime(incidentSuppressDurationQo)`
4. Service 层调用 `timeValidate(startTimestamp, endTimestamp)` 校验时间字段与跨度（>180 天抛 `Time.span.greater.than.180`）
5. 调用 `incidentDao.queryIncidentSuppressTime(incidentSuppressDurationQo)` 按等级分组查询，返回 `List<SeveritySuppressData>`
6. 遍历 `suppressDurationData` 累加 `severityTotalDuration` → `allSuppressDuration`，累加 `severityCount` → `suppressCount`
7. 每条 SeveritySuppressData 转换为 `SeveritySuppressItem`（含 severity/severityCount/severityTotalDuration），加入 `severitySuppressList`
8. 封装 `OpenApiIncidentSuppressDurationVo` 返回

### 数据转换逻辑

- DAO 返回 `SeveritySuppressData`（含 severity/severityCount/severityTotalDuration/totalSuppressTime/totalStartTime 等内部字段）
- 仅取 severity/severityCount/severityTotalDuration 三个字段构造对外 `SeveritySuppressItem`
- 总量字段由 Service 累加，非 DAO 直接返回

### 默认行为

- `timeField` 默认 `IncidentTimeFieldTypeEnum.END_TIME.getTimeField()`=endTime（QO 字段初始化）
- `filterParam` 可空，不传时仅按时间范围过滤
- 时间范围补全失败时直接抛异常，不返回默认空 VO

### 特殊规则

- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 取值（startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime），否则抛 `time.field.error`
- 时间跨度 > 180 天抛 `Time.span.greater.than.180` 异常
- 接口返回 `OpenApiResponse<OpenApiIncidentSuppressDurationVo>`，含 code/message/data 包装

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数（来源：OpenApiIncidentSuppressDurationQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 否 | - | 起始时间（秒级时间戳） | 1750968000 |
| endTimestamp | long | 否 | - | 结束时间（秒级时间戳） | 1783113600 |
| timeField | string | 否 | endTime | 时间字段，IncidentTimeFieldTypeEnum 取值，见下方枚举说明 | "endTime" |
| filterParam | object | 否 | - | 其他过滤字段，结构见下方 SuppressDurationFilterParam | {"severities":[3,4]} |

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

#### filterParam 结构说明（OpenApiIncidentSuppressDurationQo.SuppressDurationFilterParam）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| hostBranchIds | array[integer] | 否 | - | 资产组id | [1, 2] |
| platformHostBranchIds | array[string] | 否 | - | 平台资产组id | ["p1", "p2"] |
| platformIds | array[string] | 否 | - | 平台id | ["plat-1"] |
| severities | array[integer] | 否 | - | 事件等级，IncidentSeverityEnum 取值（参考 enum-dictionary.md：-1/0/1/2/3/4） | [3, 4] |
| whiteStatus | array[string] | 否 | - | 加白状态，WhiteStatusEnum（参考 enum-dictionary.md：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2"） | ["未加白"] |

> 注意：嵌套类字段名以 @JsonProperty 为准（hostBranchIds/platformHostBranchIds/platformIds/severities/whiteStatus）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，结构见下方 data 说明 |

### data 结构说明（来源：OpenApiIncidentSuppressDurationVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| allSuppressDuration | long | 总遏制时长（单位秒） | ≥ 0 | 3600 |
| suppressCount | long | 统计遏制时长的事件数量 | ≥ 0 | 10 |
| severitySuppressList | array[SeveritySuppressItem] | 遏制时长按等级分布 | 见下方 item 结构 | 见示例 |

### severitySuppressList 元素结构说明（OpenApiIncidentSuppressDurationVo.SeveritySuppressItem）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| severity | integer | 安全等级 | IncidentSeverityEnum，参考 enum-dictionary.md：-1/0/1/2/3/4 | 3 |
| severityCount | long | 该等级事件总数 | ≥ 0 | 4 |
| severityTotalDuration | long | 该等级总遏制时长（单位秒） | ≥ 0 | 1440 |

## 调用示例

### 示例1：查询近 7 天高危与严重的遏制时长分布

**请求示例**：
```json
{
    "startTimestamp": 1750968000,
    "endTimestamp": 1783113600,
    "timeField": "endTime",
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
        "allSuppressDuration": 3600,
        "suppressCount": 10,
        "severitySuppressList": [
            {"severity": 3, "severityCount": 7, "severityTotalDuration": 1800},
            {"severity": 4, "severityCount": 3, "severityTotalDuration": 1800}
        ]
    }
}
```

### 示例2：错误响应 - 时间范围补全失败

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

### 示例3：错误响应 - 时间跨度超过 180 天

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "Time.span.greater.than.180",
    "data": null
}
```

### 示例4：错误响应 - timeField 非法

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "time.field.error",
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
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法取值
- 时间跨度 ≤ 180 天，否则抛 `Time.span.greater.than.180`
- `severities` 取值范围 -1/0/1/2/3/4（IncidentSeverityEnum）
- `whiteStatus` 中文环境传"未加白"/"已加白"/"部分加白"，国际版传"0"/"1"/"2"

### 参数依赖关系
- `filterParam` 内字段之间为 AND 关系
- `timeField` 决定时间范围作用的事件时间字段

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.lists.log"）

### 性能建议
- 时间跨度 ≤ 30 天性能最佳，> 30 天可能慢查询
- 配合 filterParam.severities 缩小查询范围

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- allSuppressDuration 与 severityTotalDuration 单位均为秒
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：近 7 天（2026-06-28 00:00:00 UTC）≈ 1750968000，当前（2026-07-05 00:00:00 UTC）≈ 1783113600

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | timestamp params failed | 时间范围补全失败（如 start>end） | 检查 startTimestamp ≤ endTimestamp |
| 500 | Time.span.greater.than.180 | 时间跨度 > 180 天 | 缩小时间范围至 ≤ 180 天 |
| 500 | time.field.error | timeField 非法 | 使用 IncidentTimeFieldTypeEnum 合法取值 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **按业务时区计算时间范围**：startTimestamp/endTimestamp 用业务时区自然日起止转秒级时间戳
2. **优先 endTime**：timeField 默认 endTime，反映事件结束后的遏制时长
3. **配合 filterParam**：用 severities 限定高危与严重，避免低危事件干扰
4. **关注等级分布**：severitySuppressList 识别哪类事件遏制最慢
5. **缓存 5 分钟**：大屏态数据可前端缓存 5 分钟
