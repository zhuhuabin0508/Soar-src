# POST /api/xdr/v1/incidents/dealstatus/count

## 接口概述

本接口用于按时间范围统计安全事件各处置状态（待处置/处置中/处置完成/挂起/已忽略/已遏制）的事件数量，返回各状态计数与事件总数，支撑大屏统计与处置效率度量场景。通过本接口，您可以获取/操作以下内容：

### 可查询的处置状态数量信息
- **总事件数**：满足时间范围条件的事件总数（total）
- **各状态计数**：按 `IncidentDealStatusSortEnum` 顺序返回各处置状态的计数（item 列表，每项含状态名称 name 与计数 value）
- **过滤维度**：时间范围（基于 timeRange 类型 + startTimestamp/endTimestamp）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件处置状态统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/incidents/dealstatus/list` 处置状态列表、`/incidents/dealrate` 处置率聚合 |

## 使用场景

1. **大屏统计**：在 XDR 大屏展示当前时间范围内各处置状态的事件数量分布
2. **SLA 度量**：基于待处置/处置中/处置完成计数计算处置率
3. **积压告警监控**：通过 pending/disposing 计数识别积压事件
4. **报表生成**：导出各状态计数用于定期报表
5. **趋势对比**：按时间范围多次调用对比状态分布变化

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/dealstatus/count |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `IncidentTimeRangeQo` 并校验
   - `timeRange` 必填，必须为 `TimeRangeEnum` 合法值
   - `startTimestamp`/`endTimestamp` 必填
   - `topN` 可选，默认 5，范围 1~200（本接口实际未使用 topN）
2. 调用 `iIncidentScreenService.getIncidentDispose(timeRangeQo)`
3. Service 内部：
   - 构造 `CommonQo`（startTime/endTime 来自 timeRangeQo）
   - 调用 `iReportDao.findList(param)` 执行 MongoDB 聚合查询，按 dealStatus 分组计数
   - 累加各分组 count 得到 incidentTotal
   - 按 `IncidentDealStatusSortEnum` 顺序（按 sequentially 排序）遍历，构造 `IncidentStatisticalVo(name=dealStatusDesc, value=count)` 列表
   - 返回 `IncidentDisposeVo(incidentTotal, result)`
4. Controller 直接返回 `IncidentDisposeVo`（被 `@OpenApiResponseResult` 包装为标准 OpenApiResponse）

### 数据转换逻辑
- MongoDB 聚合结果 `IncidentCountGroupVo` → `IncidentStatisticalVo`：name ← dealStatusDesc，value ← count
- 按 `IncidentDealStatusSortEnum.sequentially` 排序，确保返回列表状态顺序固定
- 缺失的 dealStatus 分组补 0

### 默认行为
- `topN` 默认 5，范围 1~200（本接口实际未使用 topN，仅做校验）
- 缺失的 dealStatus 分组补 0（通过 `IncidentDealStatusSortEnum.values()` 遍历保证所有状态都出现在结果中）

### 特殊规则
- `timeRange` 必须为 `TimeRangeEnum` 合法值（last7d/last30d/last24h/custom），否则返回 400 (`timeRange value error`)
- `startTimestamp`/`endTimestamp` 必填
- 返回的 `name` 是处置状态的国际化描述（来自 `IncidentDealStatusEnum.getDealStatusDesc()`），如"待处置"/"处置中"/"处置完成"/"挂起"/"已忽略"/"已遏制"

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| timeRange | string | 是 | - | 时间范围类型，必须为 TimeRangeEnum 合法值，见下方枚举说明 | "custom" |
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long） | 1750464000 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1782604800 |
| topN | integer | 否 | 5 | top级别，取值范围 1~200（本接口实际未使用，仅做校验） | 5 |

**timeRange 枚举值说明**（来源：TimeRangeEnum）：

| 枚举值 | 说明 |
|--------|------|
| last7d | 最近7天 |
| last30d | 最近30天 |
| last24h | 最近24小时 |
| custom | 自定义时间范围（需配合 startTimestamp/endTimestamp） |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：IncidentDisposeVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| total | long | 满足时间范围条件的事件总数 | 100 |
| item | array[IncidentStatisticalVo] | 各处置状态计数列表 | 见下方说明 |

### item 元素结构说明（来源：IncidentStatisticalVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 统计数据key（处置状态描述，来自 IncidentDealStatusEnum.getDealStatusDesc()） | 待处置/处置中/处置完成/挂起/已忽略/已遏制 | "待处置" |
| value | long | 数据量 | - | 25 |

> 注意：item 列表按 `IncidentDealStatusSortEnum.sequentially` 排序，固定顺序为：待处置 → 处置中 → 处置完成 → 挂起 → 已忽略 → 已遏制。

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 100,
        "item": [
            {"name": "待处置", "value": 25},
            {"name": "处置中", "value": 10},
            {"name": "处置完成", "value": 50},
            {"name": "挂起", "value": 5},
            {"name": "已忽略", "value": 5},
            {"name": "已遏制", "value": 5}
        ]
    }
}
```

## 调用示例

### 示例1：自定义时间范围统计

**请求示例**：
```json
{
    "timeRange": "custom",
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800
}
```

### 示例2：最近 7 天统计

**请求示例**：
```json
{
    "timeRange": "last7d",
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800
}
```

### 示例3：错误响应 - timeRange 不合法

**请求示例**：
```json
{
    "timeRange": "invalid",
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "timeRange value error",
    "data": null
}
```

### 示例4：错误响应 - startTimestamp 为空

**请求示例**：
```json
{
    "timeRange": "custom",
    "endTimestamp": 1782604800
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
- `timeRange` 必填，必须为 `TimeRangeEnum` 合法值
- `startTimestamp`/`endTimestamp` 必填，秒级 10 位 Long
- `topN` 范围 1~200（@Min(1)/@Max(200)），本接口实际未使用

### 参数依赖关系
- `timeRange=custom` 时需配合 `startTimestamp`/`endTimestamp`
- 其他 timeRange 类型（last7d/last30d/last24h）也需传 startTimestamp/endTimestamp（接口未自动按 timeRange 推算时间）

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.get.incidents.dealStatusCount.log"）

### 性能建议
- 时间范围建议不超过 30 天，过大可能查询超时
- 单次查询足够，无需翻页

### 使用注意事项
- **状态顺序固定**：item 列表按 `IncidentDealStatusSortEnum.sequentially` 排序，固定顺序为：待处置 → 处置中 → 处置完成 → 挂起 → 已忽略 → 已遏制
- **缺失状态补 0**：所有 6 个处置状态都会出现在结果中，缺失的补 0
- **name 是中文描述**：name 字段是处置状态的国际化描述（如"待处置"），不是状态码；国际版环境会返回英文描述

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无返回时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- `total` 为各状态计数的累加和（保证 `sum(item.value) == total`）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | empty time range | timeRange 为空 | 传入合法的 timeRange |
| 400 | timeRange value error | timeRange 不在 TimeRangeEnum 枚举范围 | 使用合法值：last7d/last30d/last24h/custom |
| 400 | empty start time | startTimestamp 为空 | 传入 startTimestamp |
| 400 | empty end time | endTimestamp 为空 | 传入 endTimestamp |
| 400 | topN cannot be less than 1 | topN < 1 | 设置 topN >= 1 |
| 400 | topN cannot be greater than 200 | topN > 200 | 设置 topN <= 200 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | internal error | 服务端异常 | 联系技术支持 |

## 最佳实践

1. **时间范围显式传值**：无论 timeRange 是哪种类型，都建议显式传 startTimestamp/endTimestamp，避免歧义
2. **状态码识别**：返回的 name 是中文描述，前端展示无需再映射；如需状态码可按顺序固定映射（待处置=1, 处置中=2, ...）
3. **total 校验**：`sum(item.value)` 应等于 `total`，可用于数据完整性校验
4. **配合 dealrate**：如需按其他维度（资产组、等级）分组统计处置率，使用 `/incidents/dealrate` 接口
5. **大屏展示**：本接口为大屏统计场景设计，返回固定顺序的 6 个状态计数，适合直接展示
