# POST /api/xdr/v1/incidents/durationlist

## 接口概述

本接口用于按时间范围、资产组、等级、处置状态、平台等条件分页查询事件时长列表，返回每个事件的检测/处置/响应时长、是否逾期、超时标准等明细，支撑 MSS 时长统计与逾期事件管理场景。通过本接口，您可以获取/操作以下内容：

### 可查询的事件时长信息
- **基础信息**：事件ID（incidentUuId）、事件名称（name）、插入时间（insertTime，秒级）、处置状态（dealStatus）、风险等级（severity）
- **时长指标**：时长分钟（duration）、时长毫秒（durationTimestamp）、是否逾期（isOverdue，1是/0否）
- **过滤维度**：时间范围（基于 timeField）、处置类型（incidentDisposalType：1检测/2处置/3响应）、处置状态、风险等级、是否逾期、资产组、平台、分页、排序

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件时长列表查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/incidents/detectiontime` 平均检测时长、`/incidents/averageduration` 平均处置/响应时长、`/incidents/timedelayduration` 平均时延时长 |

## 使用场景

1. **MSS 时长统计**：在 MSS 报表展示事件检测/处置/响应时长明细
2. **逾期事件管理**：通过 isOverdueList 筛选逾期事件，定位需要优先处置的事件
3. **时长分布分析**：按风险等级/处置状态筛选，分析时长分布
4. **SLA 度量辅助**：导出单事件时长明细用于 SLA 度量
5. **超时事件排查**：通过 isOverdue=1 筛选超时事件，排查超时原因

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/durationlist |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `OpenApiIncidentDurationListQo` 并校验
2. 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，若返回 null 则抛 `IncidentException(I18nUtils.i18n("exception.param.time.error"))`
3. 校验 startTimestamp <= endTimestamp，否则抛 `IncidentException("The starttime cannot be greater than the endtime")`
4. 根据 `incidentDisposalType` 路由不同 Service 方法：
   - `IncidentDisposalTypeEnum.DETECTION`（1）→ `openApiIncidentService.queryDetectionIncidentList(incidentResponseListQo)` 查询检测时长列表
   - `IncidentDisposalTypeEnum.DISPOSAL`（2）→ `openApiIncidentService.queryDisposalIncidentList(incidentResponseListQo)` 查询处置时长列表
   - `IncidentDisposalTypeEnum.RESPONSE`（3）→ `openApiIncidentService.queryResponseIncidentList(incidentResponseListQo)` 查询响应时长列表
   - 不匹配任何类型时返回空 `OpenApiPageResult`
5. Service 内部按 incidentDisposalType 计算对应时长字段（duration/durationTimestamp）与是否逾期（isOverdue），返回 `OpenApiPageResult<OpenApiIncidentDurationListVo>`

### 数据转换逻辑
- Incident → OpenApiIncidentDurationListVo：取 incidentUuId/name/insertTime/dealStatus/severity 字段
- duration/durationTimestamp：按 incidentDisposalType 计算对应时长（检测时长/处置时长/响应时长）
- isOverdue：根据超时标准与实际时长比较得出

### 默认行为
- `timeField` 默认 `endTime`（来源：`IncidentTimeFieldTypeEnum.END_TIME`）
- `sort` 默认 `durationTimestamp:desc`（按时长降序）
- `statisticallyEmpty` 默认 false（相关字段无值的数据不加入统计）
- `excludeWhite` 默认 true（过滤已加白数据）
- `pageSize`/`page` 默认 null（未传时由 Service/DAO 层补全）

### 特殊规则
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值，否则返回 400 (`timeField is illegal`)
- `branchIds` 最多 2000 个元素（@Size(max=2000)）
- `platformIds` 最多 100 个元素（@Size(max=100)）
- `incidentDisposalType` 必传，必须为 `IncidentDisposalTypeEnum` 合法值（1/2/3），不匹配任何类型时返回空结果
- `sort` 字段格式为 `fieldName:asc` 或 `fieldName:desc`（默认 `durationTimestamp:desc`）
- 时间范围解析失败或 startTimestamp > endTimestamp 时抛异常

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| incidentDisposalType | integer | 是 | - | 处置类型，IncidentDisposalTypeEnum 合法值：1-检测, 2-处置, 3-响应 | 1 |
| dealStatusList | array[integer] | 否 | - | 处置状态列表，**入参为内部 IncidentDealStatusEnum（1/待处置, 2/处置中, 3/处置完成, 4/挂起, 5/已忽略, 6/已遏制）**，DAO 层直接传值查库**不做 TMG 转换**。**特别注意 `incidentDisposalType=2`（处置）分支**：服务层会过滤 `dealStatusList` 仅保留 `==3（DISPOSED）` 或 `==5（IGNORED）` 的值，若传入的值不含 3 或 5（如传 TMG 40/60）会提前返回空列表，无错误提示。注意：`/incidents/aggregation` 和 `/incidents/asset/aggregation` 接口的 dealStatus 入参使用 TMG 状态码（0/10/20/30/40/50/60/70/80），本接口与 `/incidents/trends` 使用内部 1-6，不要混用 | [3, 5] |
| severityList | array[integer] | 否 | - | 风险等级列表 | [3, 4] |
| isOverdueList | array[integer] | 否 | - | 是否逾期：1-是, 0-否 | [1] |
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long） | 1750464000 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long） | 1782604800 |
| detectionDurationStandard | long | 否 | - | 检测时长超时标准（单位毫秒） | 3600000 |
| sort | string | 否 | durationTimestamp:desc | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc` | "durationTimestamp:desc" |
| branchIds | array[integer] | 否 | - | 资产组ID（对应表 hostBranchId），最多 2000 个元素 | [101] |
| platformIds | array[string] | 否 | - | 平台ID，最多 100 个元素 | ["platform_001"] |
| excludeWhite | boolean | 否 | true | 是否过滤已加白数据 | true |
| statisticallyEmpty | boolean | 否 | false | 相关字段无值的数据是否加入统计 | false |
| responseTimeDurationStandard | array[DurationStandardQo] | 否 | - | 响应时长超时标准列表 | [{"level": 3, "value": 3600}] |
| dealTimeDurationStandardList | array[DurationStandardQo] | 否 | - | 处置时长超时标准列表 | [{"level": 3, "value": 7200}] |
| firstOperation | OperationCondition | 否 | - | 第一次标记事件处置操作 | 见下方 |
| secondOperation | OperationCondition | 否 | - | 第二次标记事件处置操作 | 见下方 |
| timeField | string | 否 | endTime | 时间字段，IncidentTimeFieldTypeEnum 合法值 | "endTime" |
| pageSize | integer | 否 | - | 条数 | 20 |
| page | integer | 否 | - | 页码 | 1 |

**incidentDisposalType 枚举值说明**（来源：IncidentDisposalTypeEnum）：

| 值 | 枚举常量名 | 说明 |
|----|-----------|------|
| 1 | DETECTION | 检测列表 |
| 2 | DISPOSAL | 处置列表 |
| 3 | RESPONSE | 响应列表 |

**DurationStandardQo 结构说明**（来源：DurationStandardQo）：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| level | integer | 是 | 超时标准风险等级 | 3 |
| value | long | 是 | 超时时长（单位秒） | 3600 |

> 注意：DurationStandardQo 中 value 单位为秒（源码注释明确）。这与 `OpenApiIncidentDurationQo` 中 DurationStandardQo 单位为毫秒不同。

**OperationCondition 结构说明**（来源：OpenApiIncidentResponseTimeQo.OperationCondition）：

| 参数名 | 类型 | 必填 | 默认值 | 说明 | 示例值 |
|--------|------|------|--------|------|--------|
| operate | integer | 是 | - | operate值 | 1 |
| sort | string | 否 | asc | 排序方式：asc-升序取第一条，desc-降序取第一条 | "asc" |
| userName | UserNameCondition | 否 | - | 查询操作用户名称 | 见下方 |

**UserNameCondition 结构说明**：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| matchType | string | 是 | userName查询方式：equal/regex | "equal" |
| value | string | 是 | userName查询值 | "admin" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：OpenApiPageResult<OpenApiIncidentDurationListVo>）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | long | 满足条件的总记录数 |
| page | integer | 当前页码 |
| pageSize | integer | 每页大小 |
| item | array[OpenApiIncidentDurationListVo] | 事件时长列表 |

### item 元素结构说明（来源：OpenApiIncidentDurationListVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| incidentUuId | string | 数据库唯一标识-事件Id（UUID和主键Id相同） | - | "incident-001" |
| insertTime | long | 插入时间（秒级时间戳） | - | 1782604800 |
| name | string | 事件名称 | - | "永恒之蓝攻击事件" |
| dealStatus | integer | 处置状态 | IncidentDealStatusEnum，参考 enum-dictionary.md。1-待处置, 2-处置中, 3-处置完成, 4-挂起, 5-已忽略, 6-已遏制 | 3 |
| severity | integer | 风险等级 | IncidentSeverityEnum，参考 enum-dictionary.md。-1/0-信息, 1-低危, 2-中危, 3-高危, 4-严重 | 4 |
| duration | decimal | 时长（分钟） | - | 30.5 |
| durationTimestamp | long | 时长（毫秒） | - | 1830000 |
| isOverdue | integer | 是否逾期 | 1-是, 0-否 | 0 |

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 50,
        "page": 1,
        "pageSize": 20,
        "item": [
            {
                "incidentUuId": "incident-001",
                "insertTime": 1782604800,
                "name": "永恒之蓝攻击事件",
                "dealStatus": 3,
                "severity": 4,
                "duration": 30.5,
                "durationTimestamp": 1830000,
                "isOverdue": 0
            }
        ]
    }
}
```

## 调用示例

### 示例1：查询检测时长列表

**请求示例**：
```json
{
    "incidentDisposalType": 1,
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "detectionDurationStandard": 3600000,
    "page": 1,
    "pageSize": 20
}
```

### 示例2：查询逾期处置时长列表

**请求示例**：
```json
{
    "incidentDisposalType": 2,
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "isOverdueList": [1],
    "dealTimeDurationStandardList": [{"level": 3, "value": 7200}],
    "page": 1,
    "pageSize": 50
}
```

### 示例3：查询响应时长列表（按操作用户筛选）

**请求示例**：
```json
{
    "incidentDisposalType": 3,
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "firstOperation": {
        "operate": 1,
        "sort": "asc",
        "userName": {"matchType": "equal", "value": "admin"}
    },
    "responseTimeDurationStandard": [{"level": 3, "value": 3600}],
    "page": 1,
    "pageSize": 20
}
```

### 示例4：错误响应 - 时间范围不合法

**请求示例**：
```json
{
    "incidentDisposalType": 1,
    "startTimestamp": 1782604800,
    "endTimestamp": 1750464000
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "The starttime cannot be greater than the endtime",
    "data": null
}
```

### 示例5：错误响应 - timeField 不合法

**请求示例**：
```json
{
    "incidentDisposalType": 1,
    "timeField": "invalidField"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "timeField is illegal",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `incidentDisposalType` 必传，必须为 IncidentDisposalTypeEnum 合法值（1/2/3）
- `branchIds` 最多 2000 个元素
- `platformIds` 最多 100 个元素
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值

### 参数依赖关系
- `incidentDisposalType` 决定路由的 Service 方法与时长计算逻辑
- `detectionDurationStandard` 仅 incidentDisposalType=1 时有意义
- `dealTimeDurationStandardList` 仅 incidentDisposalType=2 时有意义
- `responseTimeDurationStandard` + `firstOperation`/`secondOperation` 仅 incidentDisposalType=3 时有意义
- `isOverdueList` 与对应超时标准配合使用

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.lists.log"）

### 性能建议
- 时间范围建议不超过 7 天
- `pageSize` 建议 20~50

### 使用注意事项
- **DurationStandardQo 单位秒**：本接口的 DurationStandardQo.value 单位为秒，与 `OpenApiIncidentDurationQo` 中的毫秒单位不同
- **incidentDisposalType 必传**：不传或传错值会返回空结果
- **sort 默认 durationTimestamp:desc**：默认按时长降序，可改为升序查看最短时长事件
- **firstOperation/secondOperation**：用于响应时长场景，限定按某操作类型与用户筛选
- **dealStatusList 入参/返回都是内部 1-6**：本接口入参 `dealStatusList` 和返回 `dealStatus` 都使用内部 IncidentDealStatusEnum（1-6），DAO 层不做 TMG 转换。`incidentDisposalType=2`（处置）分支会过滤掉非 DISPOSED(3) 或 IGNORED(5) 的状态，传 TMG 值（如 40）会因不包含 3/5 而提前返回空。注意：`/incidents/aggregation` 和 `/incidents/asset/aggregation` 接口的 dealStatus 入参使用 TMG 状态码（0/10/20/30/40/50/60/70/80），调用前需核对每个接口的取值口径
- **不传 dealStatusList 时的默认过滤陷阱（重点）**：当 `statisticallyEmpty=false`（默认值！）且未传 `dealStatusList` 时，DAO 屢会**强制限定只查已处置(3)+已忽略(5)**（`incidentDisposalType=3` 响应场景额外加已遏制(6)）。也就是说，即使你没传 dealStatusList，返回值也**不会是全部状态的事件**，只会包含已处置/已忽略/已遏制。若想查询所有状态，需传全部 1-6，或设 `statisticallyEmpty=true`

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- `duration` 单位为分钟（BigDecimal，保留小数），`durationTimestamp` 单位为毫秒（Long）
- `dealStatus` 返回的是内部状态码（1-6），不是 TMG 状态码

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | timeField is illegal | timeField 不在枚举范围 | 使用 IncidentTimeFieldTypeEnum 合法值 |
| 400 | exception.param.time.error | 时间范围解析失败 | 检查时间范围 |
| 400 | The starttime cannot be greater than the endtime | startTimestamp > endTimestamp | 调整时间范围 |
| 400 | param.attack.screen.area.branch.limit | branchIds 超过 2000 | 控制 branchIds 数量 |
| 400 | exception.validate.invalid.length | 字段元素数量超限 | 控制 platformIds 等字段元素数量 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | exception.method.execute | 查询执行异常 | 联系技术支持 |

## 最佳实践

1. **incidentDisposalType 显式传值**：必传处置类型，避免返回空结果
2. **超时标准核对单位**：本接口 DurationStandardQo.value 单位为秒，注意与 averageduration 接口（毫秒）区分
3. **逾期筛选**：isOverdueList=[1] 筛选逾期事件，定位优先处置对象
4. **配合 detectiontime/averageduration**：本接口返回单事件明细，统计指标用 detectiontime/averageduration
5. **响应时长场景**：incidentDisposalType=3 时配合 firstOperation/secondOperation 限定操作类型与用户
