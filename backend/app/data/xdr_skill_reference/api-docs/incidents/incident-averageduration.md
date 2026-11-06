# POST /api/xdr/v1/incidents/averageduration

## 接口概述

本接口用于查询安全事件的平均处置时长和响应时长，并按事件等级分别统计处置时长分布（总数/超时数/未超时数/总时长/超时总时长/最大时长等），用于 SLA 履约分析和运营效率监控。通过本接口，您可以获取以下内容：

### 可查询/统计的时长信息
- **整体处置时长统计**：总处置时长、处置事件数、最大处置时长
- **整体超时统计**：总超时处置时长、超时事件数、未超时事件数、最大超时处置时长、最大未超时处置时长
- **整体响应时长统计**：总响应时长、响应事件数、最大响应时长
- **SLA 履约率**：slaStrandsResponseRatio（SLA 规定处置比例）
- **按等级分布**：levelDealDurationList 每个事件等级的总数/超时数/未超时数/总时长/超时总时长/未超时总时长/最大时长/最大超时时长

### 可设置的过滤维度
- **时间范围**：startTimestamp / endTimestamp（秒级）
- **时间字段**：timeField（默认 endTime）
- **资产组**：hostBranchId（关联资产组ID，最多 1000 个）
- **事件等级**：severities
- **平台ID**：platformIds（最多 100 个）
- **加白过滤**：excludeWhite（默认 true，过滤已加白数据）
- **空值统计**：statisticallyEmpty（默认 false，相关字段无值的数据不加入统计）
- **超时标准**：detectionDurationStandard（检测时长超时标准）、dealTimeDurationStandardList（处置时长超时标准，最多 20 个）、responseTimeDurationStandard（响应时长超时标准）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件时长统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/incidents/timedelayduration` 事件平均时延时长、`/api/xdr/v1/incidents/suppressduration` 事件总遏制时间、`/api/xdr/v1/incidents/aggregation` 事件聚合 |

## 使用场景

1. **SLA 履约监控**：在 SOC 大屏展示处置时长 SLA 履约率（slaStrandsResponseRatio），监控运营团队响应效率
2. **超时事件分析**：通过 allTimeoutDealDurationCount 和 allNoTimeoutDealDurationCount 对比，定位超时占比高的时段
3. **按等级运营效率分析**：通过 levelDealDurationList 查看不同等级事件的处置时长分布，识别高等级事件处置是否及时
4. **响应时长瓶颈定位**：通过 maxResponseDuration 和 allResponseDuration 定位响应时长异常的事件
5. **加白影响评估**：通过 excludeWhite 切换 true/false 对比统计结果，评估加白数据对整体时长的影响
6. **配合趋势接口**：本接口拿整体时长分布，`/incidents/trends` 拿时间维度变化，组合监控 SLA 履约趋势
7. **MSS 运营报表**：MSS 服务经理使用本接口生成定期的处置时长报表

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/averageduration |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery（两者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳，若返回 null 抛 `exception.param.time.error`
2. **Service 层时间校验**：`timeValidate(startTimestamp, endTimestamp)` 校验时间范围合法性
3. **超时标准解析**：
   - 从 `dealTimeDurationStandardList` 提取每个等级的超时阈值，转换为 `Map<level, value秒>`（value 由毫秒转秒：`value/1000`，若结果为 0 则取 1L）
   - 若 `dealTimeDurationStandardList` 为 null，levelMap 为空 Map
   - 遍历 `IncidentSeverityEnum.values()`，将未指定的等级阈值补 0L（即不超时）
4. **默认值填充**：
   - `excludeWhite` 为 null 时默认 `true`（过滤已加白数据）
   - `statisticallyEmpty` 为 null 时默认 `false`（无值数据不加入统计）
5. **查询数据库 - 处置时长**：调用 `incidentDao.queryIncidentDealDurationBySeverity(qo, levelMap)`，按等级分组查询处置时长统计
6. **整体汇总**：遍历各等级结果累加：
   - `allDealDuration` = 各等级 levelTotalDuration 之和
   - `dealDurationCount` = 各等级 levelCount 之和
   - `maxDealDuration` = 各等级 levelMaxDuration 最大值
   - `maxTimeoutDealDuration` = 各等级 levelMaxTimeoutDuration 最大值
   - `allTimeoutDealDurationCount` = 各等级 levelTimeoutCount 之和
   - `allNotTimeoutDealDurationCount` = 各等级 levelNotTimeoutCount 之和
   - `allTimeoutDealDuration` = 各等级 levelTimeoutDuration 之和
7. **查询数据库 - 响应时长**：另查响应时长相关数据（mss 标记响应时间），累加 `allResponseDuration` / `responseDurationCount` / `maxResponseDuration`
8. **构造返回**：填充 `OpenApiIncidentDisposalAndResTimeVo`，含整体统计 + 等级分布列表

### 数据转换逻辑

- 超时标准由毫秒转秒：`value / 1000`，若为 0 则取 1L（避免除零）
- DAO 返回的等级数据直接映射到 `LevelDealDurationVo` 字段
- 各等级数据累加得到整体统计
- `slaStrandsResponseRatio` 为 SLA 规定处置比例（百分比，double）

### 默认行为

- `timeField` 缺省时为 `endTime`（IncidentTimeFieldTypeEnum.END_TIME）
- `excludeWhite` 缺省时为 `true`（过滤已加白数据）
- `statisticallyEmpty` 缺省时为 `false`（无值数据不加入统计）
- `dealTimeDurationStandardList` 缺省时所有等级阈值都为 0L（不超时）
- `hostBranchId` / `severities` / `platformIds` 缺省时不做对应过滤

### 特殊规则

- **超时标准单位毫秒**：`DurationStandardQo.value` 单位为毫秒，Service 层转秒（/1000）
- **超时标准 level 必填**：每个 DurationStandardQo 含 level + value，均 @NotNull
- **dealTimeDurationStandardList 最多 20 个**：超出返回 `exception.validate.invalid.length`
- **hostBranchId 最多 1000 个**：超出返回 `exception.validate.invalid.length`
- **platformIds 最多 100 个**：超出返回校验错误
- **timeField 必须是 IncidentTimeFieldTypeEnum 合法值**：默认 endTime
- **返回时长单位秒**：allDealDuration/allResponseDuration/maxDealDuration 等所有时长字段单位为秒

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| hostBranchId | array[integer] | 否 | - | 关联资产组 ID 列表，最多 1000 个。**注意：JSON 字段名为 hostBranchId（单数，无 @JsonProperty，使用 Java 字段名；兼容旧字段名 branchIds 通过 @JsonAlias）** | [100, 200] |
| severities | array[integer] | 否 | - | 事件等级过滤，对应 IncidentSeverityEnum（参考 enum-dictionary.md）：-1/0/1/2/3/4 | [3, 4] |
| platformIds | array[string] | 否 | - | 平台 ID 列表，最多 100 个 | ["pf1"] |
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long） | 1782604800 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long） | 1783209600 |
| statisticallyEmpty | boolean | 否 | false | 相关字段无值的数据是否加入统计（true=加入，false=不加入） | false |
| detectionDurationStandard | long | 否 | 0 | 检测时长超时标准（单位毫秒） | 3600000 |
| dealTimeDurationStandardList | array[DurationStandardQo] | 否 | - | 处置时长超时标准列表，最多 20 个，每元素含 level + value（毫秒） | [{"level": 4, "value": 7200000}] |
| responseTimeDurationStandard | array[DurationStandardQo] | 否 | - | 响应时长超时标准列表，每元素含 level + value（毫秒） | [{"level": 4, "value": 3600000}] |
| excludeWhite | boolean | 否 | true | 是否过滤已加白数据（true=过滤，false=不过滤） | true |
| timeField | string | 否 | endTime | 时间字段，对应 IncidentTimeFieldTypeEnum | "endTime" |

#### DurationStandardQo 子结构说明

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| level | integer | 是 | - | 超时标准风险等级（对应 IncidentSeverityEnum 的 value：-1/0/1/2/3/4） | 4 |
| value | long | 是 | - | 超时时长（**单位毫秒**），Service 层会转秒（/1000） | 7200000 |

#### timeField 枚举值说明（IncidentTimeFieldTypeEnum）

| value | 说明 |
|-------|------|
| startTime | 开始时间 |
| endTime | 结束时间（默认） |
| auditTime | mss审核时间 |
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
| data | object | 响应数据（OpenApiIncidentDisposalAndResTimeVo） |

### data 结构说明（OpenApiIncidentDisposalAndResTimeVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| allDealDuration | long | 总处置时长（单位秒） | 18000 |
| dealDurationCount | long | 统计处置时长的事件数量 | 50 |
| allResponseDuration | long | 总响应时长（单位秒） | 12000 |
| responseDurationCount | long | 统计响应时长的事件数量 | 45 |
| maxResponseDuration | long | 最大响应时长（单位秒） | 1800 |
| allTimeoutDealDuration | long | 总超时处置时长（单位秒） | 5000 |
| allTimeoutDealDurationCount | long | 处置时长已超时数量 | 8 |
| allNoTimeoutDealDurationCount | long | 处置时长未超时数量 | 42 |
| maxDealDuration | long | 最大处置时长（单位秒） | 2400 |
| maxTimeoutDealDuration | long | 最大处置已超时时长（单位秒） | 2400 |
| maxNoTimeoutDealDuration | long | 最大处置未超时时长（单位秒） | 1800 |
| slaStrandsResponseRatio | double | SLA 规定处置比例 | 84.0 |
| levelDealDurationList | array[LevelDealDurationVo] | 处置时长按等级分布 | 见下方 |

### LevelDealDurationVo 子结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| level | integer | 风险等级（对应 IncidentSeverityEnum 的 value） | 4 |
| levelCount | long | 该等级总数 | 15 |
| levelTimeoutCount | long | 该等级超时数量 | 3 |
| levelNotTimeoutCount | long | 该等级未超时数量 | 12 |
| levelTotalDuration | long | 该等级总时长（单位秒） | 5400 |
| levelTimeoutDuration | long | 该等级超时总时长（单位秒） | 1800 |
| levelNotTimeoutDuration | long | 该等级未超时总时长（单位秒） | 3600 |
| levelMaxDuration | long | 该等级最大时长（单位秒） | 2400 |
| levelMaxTimeoutDuration | long | 该等级最大超时时长（单位秒） | 2400 |

## 调用示例

### 示例1：查询最近 7 天处置时长（默认配置）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "allDealDuration": 18000,
    "dealDurationCount": 50,
    "allResponseDuration": 12000,
    "responseDurationCount": 45,
    "maxResponseDuration": 1800,
    "allTimeoutDealDuration": 5000,
    "allTimeoutDealDurationCount": 8,
    "allNoTimeoutDealDurationCount": 42,
    "maxDealDuration": 2400,
    "maxTimeoutDealDuration": 2400,
    "maxNoTimeoutDealDuration": 1800,
    "slaStrandsResponseRatio": 84.0,
    "levelDealDurationList": [
      {"level": 4, "levelCount": 15, "levelTimeoutCount": 3, "levelNotTimeoutCount": 12, "levelTotalDuration": 5400, "levelTimeoutDuration": 1800, "levelNotTimeoutDuration": 3600, "levelMaxDuration": 2400, "levelMaxTimeoutDuration": 2400},
      {"level": 3, "levelCount": 20, "levelTimeoutCount": 5, "levelNotTimeoutCount": 15, "levelTotalDuration": 7000, "levelTimeoutDuration": 2000, "levelNotTimeoutDuration": 5000, "levelMaxDuration": 1800, "levelMaxTimeoutDuration": 1800}
    ]
  }
}
```

### 示例2：按等级配置超时标准

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "endTime",
  "dealTimeDurationStandardList": [
    {"level": 4, "value": 7200000},
    {"level": 3, "value": 14400000},
    {"level": 2, "value": 28800000}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "allDealDuration": 18000,
    "dealDurationCount": 50,
    "allResponseDuration": 12000,
    "responseDurationCount": 45,
    "maxResponseDuration": 1800,
    "allTimeoutDealDuration": 5000,
    "allTimeoutDealDurationCount": 8,
    "allNoTimeoutDealDurationCount": 42,
    "maxDealDuration": 2400,
    "maxTimeoutDealDuration": 2400,
    "maxNoTimeoutDealDuration": 1800,
    "slaStrandsResponseRatio": 84.0,
    "levelDealDurationList": [
      {"level": 4, "levelCount": 15, "levelTimeoutCount": 3, "levelNotTimeoutCount": 12, "levelTotalDuration": 5400, "levelTimeoutDuration": 1800, "levelNotTimeoutDuration": 3600, "levelMaxDuration": 2400, "levelMaxTimeoutDuration": 2400}
    ]
  }
}
```

### 示例3：按资产组 + 等级过滤统计

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "hostBranchId": [100, 200],
  "severities": [3, 4],
  "excludeWhite": true,
  "statisticallyEmpty": false
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "allDealDuration": 8500,
    "dealDurationCount": 22,
    "allResponseDuration": 5500,
    "responseDurationCount": 20,
    "maxResponseDuration": 1200,
    "allTimeoutDealDuration": 2200,
    "allTimeoutDealDurationCount": 4,
    "allNoTimeoutDealDurationCount": 18,
    "maxDealDuration": 1800,
    "maxTimeoutDealDuration": 1800,
    "maxNoTimeoutDealDuration": 1200,
    "slaStrandsResponseRatio": 81.8,
    "levelDealDurationList": [
      {"level": 4, "levelCount": 8, "levelTimeoutCount": 2, "levelNotTimeoutCount": 6, "levelTotalDuration": 3200, "levelTimeoutDuration": 1200, "levelNotTimeoutDuration": 2000, "levelMaxDuration": 1800, "levelMaxTimeoutDuration": 1800}
    ]
  }
}
```

### 示例4：不过滤加白数据（excludeWhite=false）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "excludeWhite": false,
  "statisticallyEmpty": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "allDealDuration": 22000,
    "dealDurationCount": 65,
    "allResponseDuration": 14000,
    "responseDurationCount": 60,
    "maxResponseDuration": 1900,
    "allTimeoutDealDuration": 6000,
    "allTimeoutDealDurationCount": 10,
    "allNoTimeoutDealDurationCount": 55,
    "maxDealDuration": 2500,
    "maxTimeoutDealDuration": 2500,
    "maxNoTimeoutDealDuration": 1900,
    "slaStrandsResponseRatio": 84.6,
    "levelDealDurationList": []
  }
}
```

### 示例5：错误响应示例（超时标准 level 缺失）

**请求示例**（DurationStandardQo 缺少 level）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "dealTimeDurationStandardList": [
    {"value": 7200000}
  ]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "level cannot be null",
  "data": null
}
```

### 示例6：错误响应示例（hostBranchId 超长）

**请求示例**（hostBranchId 超过 1000 个）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "hostBranchId": [1, 2, "...", 1001]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "exception.validate.invalid.length",
  "data": null
}
```

### 示例7：错误响应示例（timeField 非法）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
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
- `hostBranchId` 最多 1000 个元素
- `platformIds` 最多 100 个元素
- `dealTimeDurationStandardList` 最多 20 个元素
- 每个 DurationStandardQo 的 level + value 必填
- `timeField` 必须是 IncidentTimeFieldTypeEnum 合法值

### 参数依赖关系
- `dealTimeDurationStandardList` 中每个 level 对应 IncidentSeverityEnum 的 value（-1/0/1/2/3/4），未配置的等级阈值默认 0L（不超时）
- `responseTimeDurationStandard` 与 `dealTimeDurationStandardList` 独立配置
- `excludeWhite=true` 与 `statisticallyEmpty=false` 同时默认生效

### 权限要求
- 需具备 `superAdmin` 或 `incidentQuery` 权限

### 性能建议
- 时间窗口过大且未加等级过滤时查询可能耗时，建议按业务合理设置
- hostBranchId 列表过大时建议分批查询
- 频繁调用本接口建议结果做缓存，时长统计不要求实时精确

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800
- **入参 DurationStandardQo.value 单位为毫秒**，Service 层会转秒（/1000），若结果为 0 则取 1L
- **返回所有时长字段单位为秒**（allDealDuration/allResponseDuration/maxDealDuration/levelTotalDuration 等）
- `level` 字段对应 IncidentSeverityEnum 的 value（-1/0/1/2/3/4），参考 enum-dictionary.md

### 使用注意事项
- **默认 excludeWhite=true**：默认过滤已加白数据，需要包含加白数据时显式传 `excludeWhite: false`
- **默认 statisticallyEmpty=false**：默认不统计相关字段无值的数据，需要包含时显式传 `statisticallyEmpty: true`
- **超时标准单位毫秒**：DurationStandardQo.value 单位为毫秒，常见错误：传秒级数值会导致阈值过小
- **超时标准 level 必填**：每个 DurationStandardQo 必须含 level + value，缺一报错
- **未配置等级阈值默认 0L**：dealTimeDurationStandardList 中未列出的等级阈值默认为 0L（即所有事件都视为超时）
- **timeField 默认 endTime**：不传 timeField 时默认按 endTime 过滤
- **hostBranchId 字段名**：JSON 字段名为 `hostBranchId`（单数，无 @JsonProperty，使用 Java 字段名），兼容旧字段名 `branchIds`（通过 @JsonAlias）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | timeField is illegal | timeField 不是 IncidentTimeFieldTypeEnum 合法值 | 改为 startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime |
| 400 | exception.validate.invalid.length | hostBranchId 超过 1000 / platformIds 超过 100 / dealTimeDurationStandardList 超过 20 | 减少 list 长度 |
| 400 | level cannot be null | DurationStandardQo 缺少 level | 必填 level |
| 400 | value cannot be null | DurationStandardQo 缺少 value | 必填 value |
| 500 | exception.param.time.error | 时间戳解析失败 | 检查 startTimestamp/endTimestamp 格式 |
| 500 | exception.method.execute | 数据库查询异常 | 联系管理员查看后端日志 |

## 最佳实践

1. **超时标准配置**：按 SLA 规定配置每个等级的超时阈值（如严重事件 2 小时、高危 4 小时、中危 8 小时），未配置的等级默认 0L 视为全部超时
2. **超时标准单位毫秒**：DurationStandardQo.value 单位为毫秒，2 小时 = 7200000，4 小时 = 14400000，1 天 = 86400000
3. **加白数据控制**：默认 excludeWhite=true 过滤加白，若需评估加白影响可切换为 false 对比
4. **空值数据控制**：默认 statisticallyEmpty=false 排除无值数据，若需包含可切换为 true
5. **配合趋势接口**：本接口拿整体时长分布，`/incidents/trends` 拿时间维度变化，组合监控 SLA 履约趋势
6. **配合聚合接口**：先用 `/incidents/aggregation` 按 dealStatus 聚合看处置状态分布，再用本接口看处置时长，全面评估处置效率
7. **按资产组维度对比**：通过 hostBranchId 过滤不同资产组，对比各组的 SLA 履约率
8. **MSS 报表使用**：MSS 服务经理定期调用本接口生成 SLA 履约报表，关注 slaStrandsResponseRatio 和 levelTimeoutCount
