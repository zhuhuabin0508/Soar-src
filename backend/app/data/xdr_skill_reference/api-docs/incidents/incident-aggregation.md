# POST /api/xdr/v1/incidents/aggregation

## 接口概述

本接口用于按指定字段分组聚合统计安全事件数量，支持多维度过滤、aggBy 分组、aggFuncs 聚合函数、sort 排序、limit Top N 截断。通过本接口，您可以获取以下内容：

### 可查询/统计的事件聚合信息
- **分组桶列表**：按 aggBy 字段分组后的桶数据，每桶含分组键 + 聚合值（如 count/sum 等）
- **聚合元数据 meta**：分组字段名及类型、聚合函数名及类型，便于客户端解析
- **聚合总数 total**：返回桶数（未截断前的桶总数）

### 可设置的过滤维度
- **时间范围**：startTimestamp / endTimestamp（秒级，必填）
- **时间字段**：timeField（startTime / endTime / auditTime / updateTime / uploadTime / occurTime / disposeTime / durationTimestamp / insertTime）
- **过滤参数 filterParam**：severities / dealStatus / hostBranchIds / platformHostBranchIds / platformIds / hostBusinessIds / platformHostBusinessIds / whiteStatus / manages / incidentThreatClass / gptResultIds / hostAssetIds / incidentThreatType
- **排除参数 excludeParam**：manages / hostBranchIds
- **分组字段 aggBy**：Incident 实体类字段名（如 severity / dealStatus / hostBranchId / incidentThreatClass 等）
- **聚合操作 aggFuncs**：含 name + func + param（如 count/sum/avg/cardinality 等）
- **排序 sort**：`fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔
- **Top 数量 limit**：默认 5，最大 200

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件聚合统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/incidents/list` 事件列表、`/api/xdr/v1/incidents/trends` 事件趋势、`/api/xdr/v1/incidents/asset/aggregation` 事件资产聚合、`/api/xdr/v1/incidents/averageduration` 事件平均时长 |

## 使用场景

1. **事件等级分布统计**：按 severity 分组聚合事件数，用于 SOC 大屏展示等级分布
2. **处置状态分布统计**：按 dealStatus 分组聚合事件数，监控待处置/处置中/处置完成数量
3. **资产组事件 Top N**：按 hostBranchId 分组聚合事件数，识别事件最多的资产组
4. **威胁分类分布**：按 incidentThreatClass 分组聚合事件数，统计各威胁大类的事件分布
5. **GPT 研判结论分布**：按 gptResult 字段聚合，统计不同研判结论的事件数量
6. **多维度组合统计**：按 severity + dealStatus 多字段分组，统计每个等级+状态的二维分布
7. **配合趋势接口**：先用本接口拿到分布 Top N，再用 `/incidents/trends` 看时间维度变化

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery（两者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳并回写 QO
2. **Service 层 aggBy 白名单校验**：
   - 调用 `classToMap(Incident.class)` 将 Incident 实体类所有声明字段转换为 `Map<字段名, 字段类型>`
   - 遍历 `aggBy` 列表，若任一字段不在 Incident 实体类字段中，**直接返回空结果**（meta=[]，item=[]，不报错）
3. **查询 MongoDB**：调用 `incidentDao.getIncidentAggResult(openApiIncidentAggQo)`，按 timeField 时间字段、filterParam 过滤、excludeParam 排除、aggBy 分组、aggFuncs 聚合、sort 排序、limit 截断，查询 t_incident 集合
4. **组装 meta**：根据 aggBy + aggByAlias + aggFuncs 构建 meta 元数据，每个 meta 元素含 name + type
5. **组装 item**：
   - 若 aggBy + aggByAlias 都非空：用 pkgIncidentAggItems 按别名组装每桶
   - 若只有 aggBy：用 pkgIncidentAggItems 按字段名组装每桶
   - 若 aggBy 为空：只取首个 aggFunc 名作为 key，value 为桶总数（即不分组的总聚合）
6. **设置 total**：`total = incidentAggResult.size()`，表示返回桶数
7. **异常处理**：数据库异常包装为 `IncidentException("exception.method.execute")`

### 数据转换逻辑

- MongoDB Aggregation 结果（Document） → `Map<String, Object>` 列表，每桶一个 Map
- aggBy 字段名 → meta.name；Incident 字段类型 → meta.type（缺省 "Integer"）
- aggFuncs[0].name → meta.name（type="Integer"）
- aggBy 为空时，单桶返回 `{aggFuncName: totalCount}`

### 默认行为

- `aggBy` 缺省时返回不分组的总聚合（单桶）
- `aggByAlias` 缺省时使用 aggBy 字段名作为 meta
- `limit` 缺省时为 `5`（**默认静默截断为 Top 5**）
- `sort` 缺省时按 MongoDB 默认顺序
- `filterParam` / `excludeParam` 缺省时不做对应过滤/排除
- 时间范围由 Controller 的 `OpenApiTimeRangeUtil.resolveTimestamp` 统一处理

### 特殊规则

- **aggBy 字段名必须使用 Incident 实体类字段名**：常用字段包括 `severity`（事件等级，注意不是 `incidentSeverity`）、`dealStatus`（处置状态）、`hostBranchId`（资产组ID）、`hostAssetId`、`incidentThreatClass`（事件大类）、`incidentThreatType`（事件小类）、`gptResult`（GPT研判）、`whiteStatus`、`productType`、`hostClassify1Id` 等。aggBy 中任一字段不在 Incident 类字段中则返回空结果
- **业务规则：通用聚合 aggBy 只传 1 个字段**：源码 `@Size(max = 8)` 允许多个但业务上多维度聚合走 ipinfosstats 类接口，本接口建议 aggBy 只传 1 个字段
- **sort 格式为冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，多字段用逗号 `,` 分隔。空格分隔会被解析失败
- **limit 区间 [1, 200]**：超出返回校验错误，缺省 5 会静默截断
- **timeField 必填**：必须是 IncidentTimeFieldTypeEnum 合法值
- **aggFuncs 必填**：至少 1 个元素，每个含 name + func + param

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long） | 1782604800 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，对应 IncidentTimeFieldTypeEnum（见下方枚举） | "startTime" |
| filterParam | object | 否 | - | 过滤参数（OpenApiIncidentAggFilterQo），见下方子结构 | {"severities": [3, 4]} |
| excludeParam | object | 否 | - | 排除参数（OpenApiIncidentAggExcludeQo），见下方子结构 | {"manages": ["dev1"]} |
| aggBy | array[string] | 否 | [] | 分组字段，必须是 Incident 实体类字段名（如 severity、dealStatus、hostBranchId 等）。**业务规则：通用聚合只传 1 个字段** | ["severity"] |
| aggByAlias | array[string] | 否 | [] | 分组别名，与 aggBy 一一对应，用于 meta 中显示 | ["事件等级"] |
| aggFuncs | array[AggFuncsDTO] | 是 | - | 聚合操作列表，每个含 name + func + param，至少 1 个 | [{"name": "count", "func": "count", "param": "*"}] |
| sort | string | 否 | - | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "count:desc" |
| limit | integer | 否 | 5 | Top 数量，取值范围 [1, 200]。**注意：默认 5 会静默截断** | 10 |

#### timeField 枚举值说明（IncidentTimeFieldTypeEnum）

| value | 说明 |
|-------|------|
| startTime | 开始时间 |
| endTime | 结束时间 |
| auditTime | mss审核时间 |
| updateTime | 更新时间 |
| uploadTime | 上传时间 |
| occurTime | 发生时间 |
| disposeTime | 处置时间 |
| durationTimestamp | 时长时间戳 |
| insertTime | 入库时间 |

#### aggBy 白名单（Incident 实体类字段名，部分常用）

> aggBy 必须使用 Incident 实体类字段名，由 `classToMap(Incident.class)` 提取。常用字段包括：

| 字段名 | 类型 | 说明 |
|-------|------|------|
| severity | Integer | 事件等级 |
| dealStatus | Integer | 处置状态 |
| hostBranchId | Integer | 所属资产组ID |
| hostAssetId | Long | 资产编号 |
| hostClassify1Id | Integer | 主机资产父类型 |
| hostClassifyId | Integer | 主机资产具体类型 |
| incidentThreatClass | String | 事件大类 |
| incidentThreatType | String | 事件小类 |
| threatClass | String | 事件大类（同上，旧字段） |
| threatType | String | 事件小类（同上，旧字段） |
| gptResult | - | GPT 研判结论（参考 enum-dictionary.md PrototypeGptResultEnum） |
| whiteStatus | String | 加白状态 |
| productType | String | 上报设备类型 |
| vendor | String | 上报设备厂商 |
| manage | String | 上报端 devId |
| attackResult | Integer | 攻击结果 |
| detectionStatus | Integer | 检测状态 |
| manualType | Integer | 手动处置标志 |
| confidence | Integer | 确定性 |
| hostCountryName | String | 国家名称 |
| hostProvinceName | String | 城市名称 |
| ... | ... | 完整列表见 Incident.java 源码 |

> **重要**：事件等级字段名为 `severity`，不是 `incidentSeverity`。

#### aggFuncs 元素结构说明（AggFuncsDTO）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| name | string | 否 | - | 聚合结果名称（输出桶中的 key） | "count" |
| func | string | 否 | - | 聚合操作名称（如 count/sum/avg/cardinality/max/min 等） | "count" |
| param | string | 否 | - | 聚合字段（`*` 表示计数，或具体字段名） | "*" |

#### filterParam 子结构说明（OpenApiIncidentAggFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| severities | array[integer] | 否 | - | 事件等级过滤，对应 IncidentSeverityEnum（参考 enum-dictionary.md）：-1/0/1/2/3/4 | [3, 4] |
| dealStatus | array[integer] | 否 | - | 处置状态过滤，**入参为 TMGIncidentDealStatusEnum（0/10/20/30/40/50/60/70/80），不是内部 IncidentDealStatusEnum（1-6）**。DAO 层会通过 `DealStatusUtil.tmgDealStatusConvert` 转换为内部 1-6 再查库。常见口语映射：已处置/处置完成 → 40，已忽略 → 60，已遏制/已封堵 → 70，待处置 → 0，处置中 → 10。**注意：30=已防护（PROTECTED），70=已遏制（SUPPRESS），不要弄反**。完整映射参考 `incident-dealstatus.md` 中的"业务语义 → 建议传参值"表 | [40, 60] |
| hostBranchIds | array[integer] | 否 | - | 资产组 ID 列表 | [100] |
| platformHostBranchIds | array[string] | 否 | - | 平台资产组 ID 列表 | ["p100"] |
| platformIds | array[string] | 否 | - | 平台 ID 列表 | ["pf1"] |
| hostBusinessIds | array[integer] | 否 | - | 所属业务 ID 列表 | [200] |
| platformHostBusinessIds | array[string] | 否 | - | 所属业务平台 ID 列表 | ["pb1"] |
| whiteStatus | array[string] | 否 | - | 加白状态过滤，对应 WhiteStatusEnum（参考 enum-dictionary.md）：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2" | ["未加白"] |
| manages | array[string] | 否 | - | 上报设备 ID 列表 | ["dev1"] |
| incidentThreatClass | array[string] | 否 | - | 事件一级分类 | ["A001"] |
| incidentThreatType | array[string] | 否 | - | 事件二级分类 | ["A001_B001"] |
| gptResultIds | array[integer] | 否 | - | GPT 研判结论 ID，对应 PrototypeGptResultEnum（参考 enum-dictionary.md） | [110, 120] |
| hostAssetIds | array[integer] | 否 | - | 资产 ID 列表（数据库字段 hostAssetId） | [1001] |

#### excludeParam 子结构说明（OpenApiIncidentAggExcludeQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| manages | array[string] | 否 | - | 排除的上报设备 ID 列表 | ["dev1"] |
| hostBranchIds | array[integer] | 否 | - | 排除的资产组 ID 列表 | [100] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiIncidentAggResult） |

### data 结构说明（OpenApiIncidentAggResult，继承 OpenApiAggResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| meta | array[OpenApiAggResultMeta] | 元数据列表，每元素含 name + type |
| item | array[map] | 数据列表，每桶一个 Map，key 为分组字段名/别名 + aggFunc.name，value 为分组键值 + 聚合值 |
| total | integer | 聚合总数（返回桶数） |

### meta 元素结构说明（OpenApiAggResultMeta）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 字段名（aggBy 字段名或 aggByAlias 别名 + aggFunc.name） | "severity" |
| type | string | 字段类型（Incident 字段类型，缺省 "Integer"） | "Integer" |

### item 元素结构说明

item 为 `List<Map>`，每桶一个 Map，结构示例：

```json
{
  "severity": 4,
  "count": 128
}
```

- key 为 aggBy 字段名（或 aggByAlias 别名）+ aggFuncs[0].name
- value 为分组键值 + 聚合结果

## 调用示例

### 示例1：按事件等级聚合 Top 5（默认 limit）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["severity"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "sort": "count:desc"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "severity", "type": "Integer"},
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"severity": 4, "count": 128},
      {"severity": 3, "count": 95},
      {"severity": 2, "count": 60},
      {"severity": 1, "count": 30},
      {"severity": 0, "count": 12}
    ],
    "total": 5
  }
}
```

### 示例2：按处置状态聚合（拿到所有状态分布）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["dealStatus"],
  "aggByAlias": ["处置状态"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "limit": 6
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "处置状态", "type": "Integer"},
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"处置状态": 1, "count": 320},
      {"处置状态": 2, "count": 80},
      {"处置状态": 3, "count": 45},
      {"处置状态": 6, "count": 12}
    ],
    "total": 4
  }
}
```

### 示例3：按资产组聚合 Top 10

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostBranchId"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "sort": "count:desc",
  "limit": 10
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "hostBranchId", "type": "Integer"},
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"hostBranchId": 100, "count": 80},
      {"hostBranchId": 200, "count": 65},
      {"hostBranchId": 300, "count": 40}
    ],
    "total": 3
  }
}
```

### 示例4：按事件等级 + 处置状态双维度聚合

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["severity", "dealStatus"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "limit": 50
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "severity", "type": "Integer"},
      {"name": "dealStatus", "type": "Integer"},
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"severity": 4, "dealStatus": 1, "count": 60},
      {"severity": 4, "dealStatus": 2, "count": 50},
      {"severity": 3, "dealStatus": 1, "count": 40}
    ],
    "total": 3
  }
}
```

### 示例5：使用 filterParam 过滤 + aggBy 聚合

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "filterParam": {
    "severities": [3, 4],
    "dealStatus": [0, 10]
  },
  "aggBy": ["hostBranchId"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "sort": "count:desc",
  "limit": 5
}
```

> 说明：`filterParam.dealStatus` 使用 TMG 状态码（0=待处置，10=处置中），DAO 层会自动转换为内部 1-6 进行查询。若误传内部码 [1, 2]，`tmgDealStatusConvert` 内部的 `TMGIncidentDealStatusEnum.build` 会抛异常，接口直接返回 500。

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "hostBranchId", "type": "Integer"},
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"hostBranchId": 100, "count": 45}
    ],
    "total": 1
  }
}
```

### 示例6：不分组的总聚合（aggBy 为空）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "count", "type": "Integer"}
    ],
    "item": [
      {"count": 425}
    ],
    "total": 1
  }
}
```

### 示例7：错误响应示例（aggBy 字段不存在）

**请求示例**（aggBy 含不存在字段 `incidentSeverity`）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["incidentSeverity"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}]
}
```

**响应示例**（不报错，直接返回空）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [],
    "item": [],
    "total": 0
  }
}
```

### 示例8：错误响应示例（timeField 非法）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "invalidField",
  "aggBy": ["severity"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "param timeField is invalid value.",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp` / `endTimestamp` 必填，秒级 10 位 Long
- `timeField` 必填，仅 IncidentTimeFieldTypeEnum 合法值
- `aggFuncs` 必填，至少 1 个元素
- `limit` 取值范围 [1, 200]，超出返回校验错误
- `aggBy` 元素必须是 Incident 实体类字段名，否则返回空结果（不报错）

### 参数依赖关系
- `aggBy` 与 `aggByAlias` 长度应一致（一一对应）
- `aggFuncs[0].name` 在 item 中作为聚合值的 key
- 各过滤字段之间为 AND 关系

### 权限要求
- 需具备 `superAdmin` 或 `incidentQuery` 权限
- 数据范围按用户权限过滤

### 性能建议
- 时间窗口过大时聚合可能耗时，建议按业务合理设置
- aggBy 字段建议加索引（如 severity、dealStatus）
- limit 较大且 sort 无索引字段时性能下降，建议 sort 字段也是聚合字段

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800
- `total` 字段为返回桶数（受 limit 截断），不是事件总数
- `severity` 字段名不是 `incidentSeverity`，aggBy 必须用 `severity`

### 使用注意事项
- **limit 默认值 = 5**：不传 limit 时只返回 Top 5 个分组，其余被静默截断不报错。聚合字段为已知有限枚举时（如 dealStatus 共 6 个值）建议传枚举总数（如 limit=6）拿到完整分布
- **aggBy 字段名严格匹配 Incident 实体类**：常用字段名为 `severity`（不是 `incidentSeverity`）、`hostBranchId`（不是 `hostBranchIds`，filterParam 中是 `hostBranchIds` 复数但 aggBy 用单数）、`hostAssetId`（不是 `hostAssetIds`）
- **业务规则：通用聚合 aggBy 只传 1 个字段**：源码 `@Size(max = 8)` 允许 8 个但业务上多维度聚合走其他接口，本接口建议 aggBy 只传 1 个字段
- **sort 格式为冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔。常见错误：写成 `count desc`（空格分隔）会被解析失败
- **aggBy 不存在字段静默返回空**：不会报错，需通过返回的 meta/item 是否为空判断
- **filterParam.dealStatus 入参与返回不一致**：入参用 TMG 状态码（0/10/20/30/40/50/60/70/80），DAO 通过 `tmgDealStatusConvert` 转换查库；但 `aggBy: ["dealStatus"]` 返回的 item 值是内部 1-6（DB 存储值）。若同时过滤 + 分组 dealStatus，注意入参 TMG、出参内部的差异
- **dealStatus 是 TMG 状态码**：本接口入参 dealStatus 使用 TMGIncidentDealStatusEnum（0/10/20/30/40/50/60/70/80），不是内部 IncidentDealStatusEnum（1-6）。但 `/incidents/trends` 和 `/incidents/durationlist` 接口的 dealStatus 入参使用内部 1-6，调用前需核对每个接口的取值口径
- **误传内部 1-6 会直接抛 500（重点）**：DAO 调 `DealStatusUtil.tmgDealStatusConvert(status)` 内部用 `TMGIncidentDealStatusEnum.build(status)`，传入不在 TMG 合法值（如内部码 1/2/3/4/5/6）会抛 `NoSuchSchemeException`，最终返回 500 错误，而不是静默返回空。若调用本接口收到 500 且日志含 `invalid statusCode: 1`/`invalid statusCode: 3` 等，说明误把内部状态码当成入参传进来了

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param startTimestamp cannot be empty | 未传 startTimestamp | 必须传 startTimestamp |
| 400 | param endTimestamp cannot be empty | 未传 endTimestamp | 必须传 endTimestamp |
| 400 | param timeField is invalid value. | timeField 不是 IncidentTimeFieldTypeEnum 合法值 | 改为 startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime |
| 400 | must be at least 1 / at most 200 | limit 超出范围 | 传入 1~200 |
| 500 | exception.method.execute / invalid statusCode | 数据库查询异常，或 filterParam.dealStatus 传入非 TMG 合法值（如内部码 1-6）致 `tmgDealStatusConvert` 抛 NoSuchSchemeException | dealStatus 改用 TMG 值 0/10/20/30/40/50/60/70/80；检查时间范围/aggBy 字段 |
| - | aggBy 字段不存在 | aggBy 含 Incident 实体类中不存在的字段名 | 改为 severity/dealStatus/hostBranchId 等正确字段名（注意：返回空不报错，需自查） |
| - | sort 解析失败 | sort 用空格分隔 | 改为冒号分隔 `count:desc` |

## 最佳实践

1. **aggBy 字段选型**：事件等级用 `severity`，状态用 `dealStatus`，资产组用 `hostBranchId`，威胁分类用 `incidentThreatClass`/`incidentThreatType`，GPT 研判用 `gptResult`
2. **limit 选型**：聚合字段为有限枚举（如 dealStatus 6 个、severity 5 个）时传枚举总数；非有限枚举（如 hostBranchId）按业务 Top N 需求传值
3. **业务规则：aggBy 单字段**：通用聚合 aggBy 只传 1 个字段，多维度组合走专用接口
4. **配合趋势接口**：本接口拿分布，`/incidents/trends` 拿时间维度变化，组合使用构建完整态势视图
5. **filterParam 与 excludeParam 配合**：filterParam 包含要的条件，excludeParam 排除不要的条件，二者可同时使用
6. **meta 解析**：返回的 meta 描述了 item 的结构，先读 meta 再读 item 可降低对接复杂度
7. **total 注意**：total 是返回桶数（受 limit 截断），不是事件总数。要拿事件总数用不分组的总聚合（aggBy 为空）
8. **aggByAlias 使用**：aggByAlias 让 meta 中显示中文别名，对接前端展示时更友好，但要与 aggBy 长度一致
