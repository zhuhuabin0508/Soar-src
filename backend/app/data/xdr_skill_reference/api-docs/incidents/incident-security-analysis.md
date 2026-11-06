# POST /api/xdr/v1/incidents/security/analysis

## 接口概述

本接口用于一次性获取安全态势分析所需的多维统计数据，覆盖"昨日日志数 / 昨日已处置事件数 / 昨日事件总数 / 近 7 天待处置事件数 / 昨日受害资产 / 昨日告警分类"六项指标，支撑大屏首页或运营报表的安全态势展示。通过本接口，您可以获取/操作以下内容：

### 可查询的安全态势信息
- **昨日日志类**：昨日日志数（dayLogNum）
- **昨日事件类**：昨日已处置事件数（dayDealtNum）、昨日事件总数（dayEventTotal）
- **近 7 天事件类**：近 7 天待处置事件数（weekPendingNum）
- **昨日资产类**：昨日受害资产（daySufferAsset）
- **昨日告警分类类**：昨日告警分类（dayAlertThreat）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 安全态势分析 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/severity/count` 事件等级统计、`/incidents/dealstatus/count` 事件处置状态统计、`/incidents/branches/count` 资产组事件统计、`/incidents/tag/count` 事件类型统计 |

## 使用场景

1. **大屏首页展示**：一次性拉取 6 项安全态势指标，渲染运营大屏首页卡片
2. **运营日报**：每日生成昨日安全运营简报，含日志数、事件数、已处置数、待处置数
3. **趋势对比**：配合 `/incidents/trends` 接口对比昨日与近 7 天事件态势变化
4. **受害资产定位**：通过 daySufferAsset 识别昨日受害最严重的资产，配合 `/riskassets/list` 下钻
5. **告警分类钻取**：通过 dayAlertThreat 识别昨日主导告警分类，配合 `/alerts/aggregation` 进一步分组

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/security/analysis |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. 接收请求参数 `SecurityAnalysisQo`，包含 `weekTime`（近 7 天时间范围）和 `dayTime`（昨日时间范围）两个 TimeRange
2. JSR-303 校验 `weekTime` 和 `dayTime` 非 null，且内部 `startTime`/`endTime` 非 null
3. 调用 `openApiIncidentService.getSecurityAnalysis(securityAnalysisQo)`
4. Service 层并发执行 3 个子任务（线程池提交 Future）：
   - `getDayLog(dayTime)`：查询昨日日志数 → 写入 `dayLogNum`
   - `getDaySufferAsset(dayTime)`：查询昨日受害资产 → 写入 `daySufferAsset`
   - `getEventCount(securityAnalysisQo)`：查询昨日已处置/全部事件 + 近 7 天待处置事件 + 昨日告警分类 → 写入 `dayDealtNum`/`dayEventTotal`/`weekPendingNum`/`dayAlertThreat`
5. 顺序 `future.get()` 收集每个子任务结果，按非 null 字段合并到统一 `SecurityAnalysisVo`
6. 返回 `SecurityAnalysisVo`（注意：Controller 直接返回 VO，未包 OpenApiResponse 外层）

### 数据转换逻辑

- 各子任务返回局部 `SecurityAnalysisVo`，主流程按非 null 字段逐一拷贝到合并 VO
- 子任务异常时 `log.warn` 后 `continue`，对应字段保持默认 null
- 涉及 SaasThreadContext 透传：子线程通过 `SaasThreadContextUtil.load(contextDataHolders)` 继承父线程租户上下文

### 默认行为

- 子任务返回 null 字段不覆盖，最终 VO 中对应字段为 null
- 不指定时间范围时由 `@NotNull` 校验直接拒绝（400 错误）

### 特殊规则

- `weekTime` 与 `dayTime` 必须同时传入，二者用途不同：`weekTime` 用于近 7 天待处置统计，`dayTime` 用于昨日各项统计
- 子任务超时或异常不会中断整体返回，仅对应字段缺失
- 接口直接返回 `SecurityAnalysisVo` 而非 `OpenApiResponse<SecurityAnalysisVo>`，无 code/message 包装

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| weekTime | object | 是 | - | 每周统计时间范围，结构见下方 TimeRange | {"startTime":1749772800,"endTime":1750204800} |
| dayTime | object | 是 | - | 每日统计时间范围，结构见下方 TimeRange | {"startTime":1750204800,"endTime":1750291200} |

#### weekTime / dayTime 结构说明（SecurityAnalysisQo.TimeRange）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTime | long | 是 | - | 起始时间（秒级时间戳） | 1749772800 |
| endTime | long | 是 | - | 截至时间（秒级时间戳） | 1750204800 |

> 注意：该嵌套类无 @JsonProperty 注解，JSON 字段名与 Java 字段名一致（startTime/endTime）。

## 返回参数

### 响应结构

接口直接返回 `SecurityAnalysisVo`，无 `code`/`message`/`data` 包装。响应体即下方 data 结构。

### data 结构说明（来源：SecurityAnalysisVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| dayLogNum | long | 昨日日志数 | 1024 |
| dayDealtNum | long | 昨日已处置事件数 | 18 |
| dayEventTotal | long | 昨日事件总数 | 32 |
| weekPendingNum | long | 近 7 天待处置事件数 | 5 |
| daySufferAsset | string | 昨日受害资产 | "192.168.1.10" |
| dayAlertThreat | string | 昨日告警分类 | "漏洞利用" |

## 调用示例

### 示例1：查询昨日与近 7 天安全态势

**请求示例**：
```json
{
    "weekTime": {
        "startTime": 1749772800,
        "endTime": 1750204800
    },
    "dayTime": {
        "startTime": 1750204800,
        "endTime": 1750291200
    }
}
```

**响应示例**：
```json
{
    "dayLogNum": 1024,
    "dayDealtNum": 18,
    "dayEventTotal": 32,
    "weekPendingNum": 5,
    "daySufferAsset": "192.168.1.10",
    "dayAlertThreat": "漏洞利用"
}
```

### 示例2：错误响应 - 缺少必填参数

**请求示例**：
```json
{
    "dayTime": {
        "startTime": 1750204800,
        "endTime": 1750291200
    }
}
```

**错误响应示例**：
```json
{
    "code": 400,
    "message": "weekTime cannot be null",
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
- `weekTime` 与 `dayTime` 必须同时传入，否则 400 拒绝
- `startTime`/`endTime` 为秒级 10 位 Long，传 13 位毫秒级时间戳会导致查询范围错误

### 参数依赖关系
- `weekTime` 与 `dayTime` 时间范围互不重叠也不包含，分别用于不同指标

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.getSecurityAnalysis.log"）

### 性能建议
- Service 层并发执行 3 个子任务，单次接口耗时近似为最慢子任务耗时
- 子任务内部涉及多表查询，建议在低峰期或大屏刷新间隔 ≥ 5 分钟调用

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 本文档示例基于当前日期 2026-07-05 推算：昨日（2026-07-04 00:00:00 UTC）≈ 1783113600，昨日 23:59:59 UTC ≈ 1751659199；近 7 天（2026-06-28 ~ 2026-07-04）起点 ≈ 1750968000。实际调用以业务时区为准

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | weekTime cannot be null | 缺少 weekTime | 补全 weekTime 字段 |
| 400 | dayTime cannot be null | 缺少 dayTime | 补全 dayTime 字段 |
| 400 | startTime cannot be null | TimeRange 内 startTime 缺失 | 补全 startTime |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |

## 最佳实践

1. **按业务时区计算时间范围**：startTime/endTime 用业务时区的昨日 00:00:00 ~ 23:59:59 转秒级时间戳
2. **缓存 5 分钟**：大屏首页态数据可前端缓存 5 分钟，避免高频调用拖慢 Service
3. **失败容错**：返回字段可能为 null（子任务异常时），前端需对 null 字段做兜底显示
4. **配合趋势接口**：态势卡片配合 `/incidents/trends` 接口展示事件时间分布
5. **配合资产下钻**：daySufferAsset 字段配合 `/riskassets/list?hostAssetIds=...` 下钻受害资产详情
