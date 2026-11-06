# POST /api/xdr/v1/incidents/asset/aggregation

## 接口概述

本接口用于按主机资产维度对安全事件做聚合统计，支持按资产字段（如 hostIp、hostAssetId、hostClassify1Id 等）分组聚合事件数量，返回每个资产分组的事件统计 Top N。通过本接口，您可以获取以下内容：

### 可查询/统计的事件主机聚合信息
- **资产分组桶列表**：按 aggBy 资产字段分组后的桶数据，每桶含分组键 + 聚合值（如 count/distinct 等）
- **聚合函数支持**：count（计数）/ distinct（去重计数）等 MongoDB 聚合函数

### 可设置的过滤维度
- **时间范围**：startTimestamp / endTimestamp（秒级，必填）
- **时间字段**：timeField（startTime / endTime / auditTime / updateTime / uploadTime / occurTime / disposeTime / durationTimestamp / insertTime）
- **过滤参数 filterParam**：platformIds / dealStatus / whiteStatus / incidentThreatClass / incidentThreatType / hostClassify1Id
- **分组字段 aggBy**：Incident 实体类字段名（主机资产相关字段如 hostIp / hostAssetId / hostBranchId / hostClassify1Id / hostCountryName 等）
- **聚合操作 aggFuncs**：含 name + func + param（如 count/distinct）
- **排序 sort**：`fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔
- **Top 数量 limit**：默认 5，最小 1（无上限，但建议不超过业务需要的 N）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件主机资产聚合统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/incidents/aggregation` 事件通用聚合、`/api/xdr/v1/incidents/list` 事件列表、`/api/xdr/v1/incidents/trends` 事件趋势 |

## 使用场景

1. **主机资产事件 Top N**：按 hostIp 分组聚合事件数，识别事件最多的主机，用于资产风险排名
2. **资产组事件分布**：按 hostBranchId 分组聚合事件数，统计各资产组的事件总量
3. **资产类型事件分布**：按 hostClassify1Id 分组聚合事件数，统计不同资产类型（服务器/终端/网络设备等）的事件分布
4. **资产国家/省份分布**：按 hostCountryName / hostProvinceName 分组聚合事件数，统计地理分布
5. **资产维度下钻**：先用本接口按 hostBranchId 拿到事件最多的资产组，再用 `/incidents/list` 配合 hostBranchIds 过滤查看明细
6. **配合通用聚合**：本接口专注于主机资产维度，其他维度（severity、dealStatus 等）用 `/incidents/aggregation`

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/asset/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery（两者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳并回写 QO
2. **Service 层 aggBy 白名单校验**：
   - 调用 `classToMap(Incident.class)` 将 Incident 实体类所有声明字段转换为 `Map<字段名, 字段类型>`
   - 遍历 `aggBy` 列表，若任一字段不在 Incident 实体类字段中，**直接返回空结果**（item=[]，不报错）
3. **aggFuncs 必填校验**：若 `aggFuncs` 为空，直接返回空结果
4. **aggFuncs.param 字段校验**：遍历每个 aggFunc 的 `param` 字段，若 `param` 非空白且不在 Incident 实体类字段中，**直接返回空结果**（不报错）。`param` 为空白时跳过该校验
5. **查询 MongoDB**：调用 `incidentDao.getIncidentAssetAggResult(openApiIncidentAssetAggQo)`，按 timeField 时间字段、filterParam 过滤、aggBy 分组、aggFuncs 聚合、sort 排序、limit 截断，查询 t_incident 集合
6. **Service 层 limit 二次截断**：将查询结果按 `limit` 再次截断（`itemList.subList(0, limit)`），确保返回桶数不超过 limit
7. **异常处理**：数据库异常包装为 `IncidentException("exception.method.execute")`

### 数据转换逻辑

- MongoDB Aggregation 结果（Document） → `Map<String, Object>` 列表
- 每桶的 key 由 aggBy 字段名 + aggFunc.name 决定，value 由聚合结果决定
- 不返回 meta 元数据，仅返回 item 列表

### 默认行为

- `aggBy` 缺省时返回不分组的总聚合
- `aggByAlias` 缺省时使用 aggBy 字段名
- `limit` 缺省时为 `5`（**默认静默截断为 Top 5**）
- `sort` 缺省时按 MongoDB 默认顺序
- `filterParam` 缺省时不做对应过滤
- 时间范围由 Controller 的 `OpenApiTimeRangeUtil.resolveTimestamp` 统一处理

### 特殊规则

- **aggBy 字段名必须使用 Incident 实体类字段名**：常用主机资产字段包括 `hostIp`（主机IP）、`hostAssetId`（资产编号）、`hostBranchId`（资产组ID）、`hostClassify1Id`（资产父类型）、`hostClassifyId`（资产具体类型）、`hostCountryName`（国家）、`hostProvinceName`（省份）、`hostAssetName`（资产名称）等。aggBy 中任一字段不在 Incident 类字段中则返回空结果
- **aggFuncs.param 必须是 Incident 字段名**：若 param 非空白且不在 Incident 字段中则返回空结果（不报错）。`*` 或空白 param 跳过该校验
- **业务规则：通用聚合 aggBy 只传 1 个字段**：源码无 @Size 限制但业务上建议单字段分组，多维度聚合走其他专用接口
- **sort 格式为冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，多字段用逗号 `,` 分隔
- **limit 最小值 1**：无 @Max 上限，但建议按业务需求传值，不要传超大值绕过截断
- **timeField 必填**：必须是 IncidentTimeFieldTypeEnum 合法值
- **aggFuncs 必填**：至少 1 个元素

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
| timeField | string | 是 | - | 过滤的时间字段，对应 IncidentTimeFieldTypeEnum | "startTime" |
| filterParam | object | 否 | - | 过滤参数（OpenApiIncidentAssetAggFilterQo），见下方子结构 | {"hostClassify1Id": [1]} |
| aggBy | array[string] | 否 | [] | 分组字段，必须是 Incident 实体类字段名（主机资产相关字段如 hostIp、hostAssetId、hostBranchId 等）。**业务规则：通用聚合只传 1 个字段** | ["hostIp"] |
| aggByAlias | array[string] | 否 | [] | 分组别名，与 aggBy 一一对应 | ["主机IP"] |
| aggFuncs | array[AggFuncsDTO] | 是 | - | 聚合操作列表，每个含 name + func + param，至少 1 个 | [{"name": "count", "func": "count", "param": "*"}] |
| sort | string | 否 | - | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "count:desc" |
| limit | integer | 否 | 5 | Top 数量，最小 1。**注意：默认 5 会静默截断** | 10 |

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

#### aggBy 白名单（Incident 实体类主机资产相关字段）

> aggBy 必须使用 Incident 实体类字段名，由 `classToMap(Incident.class)` 提取。主机资产相关常用字段：

| 字段名 | 类型 | 说明 |
|-------|------|------|
| hostIp | String | 主机IP |
| hostAssetId | Long | 资产编号 |
| hostAssetName | String | 资产名称 |
| hostAssetIp | String | 资产IP |
| hostBranchId | Integer | 所属资产组ID |
| platformHostBranchId | String | 所属资产组sortId |
| hostClassify1Id | Integer | 主机资产父类型 |
| hostClassifyId | Integer | 主机资产具体类型 |
| hostCountryName | String | 国家名称 |
| hostProvinceName | String | 城市名称 |
| hostGroupIds | List<Long> | 所属业务 |
| platformHostGroupIds | List<String> | 所属业务sortId |
| hostBusinessIds | - | 所属业务ID |
| manage | String | 上报端 devId |
| productType | String | 上报设备类型 |
| vendor | String | 上报设备厂商 |
| ... | ... | 完整列表见 Incident.java 源码 |

#### aggFuncs 元素结构说明（AggFuncsDTO）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| name | string | 否 | - | 聚合结果名称（输出桶中的 key） | "count" |
| func | string | 否 | - | 聚合操作名称（如 count/distinct 等） | "count" |
| param | string | 否 | - | 聚合字段（`*` 表示计数，或具体 Incident 字段名。非空白且不在 Incident 字段中则返回空结果） | "*" |

#### filterParam 子结构说明（OpenApiIncidentAssetAggFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| platformIds | array[string] | 否 | - | 平台 ID 列表 | ["pf1"] |
| dealStatus | array[integer] | 否 | - | 处置状态过滤，**入参为 TMGIncidentDealStatusEnum（0/10/20/30/40/50/60/70/80），不是内部 IncidentDealStatusEnum（1-6）**。DAO 层会通过 `DealStatusUtil.tmgDealStatusConvert` 转换为内部 1-6 再查库。常见口语映射：已处置/处置完成 → 40，已忽略 → 60，已遏制/已封堵 → 70，待处置 → 0，处置中 → 10。**注意：30=已防护（PROTECTED），70=已遏制（SUPPRESS），不要弄反**。完整映射参考 `incident-dealstatus.md` 中的"业务语义 → 建议传参值"表 | [40, 60] |
| whiteStatus | array[string] | 否 | - | 加白状态过滤，对应 WhiteStatusEnum（参考 enum-dictionary.md）：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2" | ["未加白"] |
| incidentThreatClass | array[string] | 否 | - | 事件一级分类 | ["A001"] |
| incidentThreatType | array[string] | 否 | - | 事件二级分类 | ["A001_B001"] |
| hostClassify1Id | array[integer] | 否 | - | 资产类型（主机资产父类型，对应 Classify1idEnum，参考 enum-dictionary.md）：0/未知, 1/服务器, 2/终端, 3/内网设备, ... | [1, 2] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiIncidentAssetAggVo） |

### data 结构说明（OpenApiIncidentAssetAggVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[map] | 事件主机统计列表，每桶一个 Map |

### item 元素结构说明

item 为 `List<Map>`，每桶一个 Map，结构示例：

```json
{
  "hostIp": "192.168.1.10",
  "count": 50
}
```

- key 为 aggBy 字段名 + aggFuncs.name
- value 为分组键值 + 聚合结果

## 调用示例

### 示例1：按主机IP聚合事件 Top 10

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostIp"],
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
    "item": [
      {"hostIp": "192.168.1.10", "count": 50},
      {"hostIp": "192.168.1.20", "count": 35},
      {"hostIp": "10.0.0.5", "count": 28},
      {"hostIp": "192.168.2.1", "count": 20},
      {"hostIp": "172.16.0.8", "count": 15},
      {"hostIp": "192.168.1.30", "count": 12},
      {"hostIp": "10.0.1.5", "count": 10},
      {"hostIp": "192.168.3.1", "count": 8},
      {"hostIp": "172.16.1.2", "count": 6},
      {"hostIp": "192.168.1.40", "count": 5}
    ]
  }
}
```

### 示例2：按资产组聚合事件数

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostBranchId"],
  "aggByAlias": ["资产组ID"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "sort": "count:desc",
  "limit": 20
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"资产组ID": 100, "count": 80},
      {"资产组ID": 200, "count": 65},
      {"资产组ID": 300, "count": 40}
    ]
  }
}
```

### 示例3：按资产类型聚合事件数（含过滤）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "filterParam": {
    "dealStatus": [0, 10],
    "hostClassify1Id": [1, 2]
  },
  "aggBy": ["hostClassify1Id"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "limit": 10
}
```

> 说明：`filterParam.dealStatus` 使用 TMG 状态码（0=待处置，10=处置中），DAO 层会自动通过 `tmgDealStatusConvert` 转换为内部 1-6 进行查询。若误传内部码 [1, 2]，`tmgDealStatusConvert` 会抛异常返回 500。

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"hostClassify1Id": 1, "count": 120},
      {"hostClassify1Id": 2, "count": 65}
    ]
  }
}
```

### 示例4：按国家聚合事件数（地理分布）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostCountryName"],
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
    "item": [
      {"hostCountryName": "中国", "count": 280},
      {"hostCountryName": "美国", "count": 45}
    ]
  }
}
```

### 示例5：按资产ID聚合 + 多过滤条件

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "filterParam": {
    "platformIds": ["pf1"],
    "incidentThreatClass": ["A001"]
  },
  "aggBy": ["hostAssetId"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}],
  "sort": "count:desc",
  "limit": 5
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"hostAssetId": 1001, "count": 35}
    ]
  }
}
```

### 示例6：使用 distinct 去重计数

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostBranchId"],
  "aggFuncs": [{"name": "distinctHost", "func": "distinct", "param": "hostIp"}],
  "limit": 10
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"hostBranchId": 100, "distinctHost": 25},
      {"hostBranchId": 200, "distinctHost": 18}
    ]
  }
}
```

### 示例7：错误响应示例（aggBy 字段不存在）

**请求示例**（aggBy 含不存在字段 `hostAsset`）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostAsset"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "*"}]
}
```

**响应示例**（不报错，返回空）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": []
  }
}
```

### 示例8：错误响应示例（aggFuncs.param 字段不存在）

**请求示例**（param 为 `nonExistField`）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "startTime",
  "aggBy": ["hostIp"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "nonExistField"}]
}
```

**响应示例**（不报错，返回空）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": []
  }
}
```

### 示例9：错误响应示例（timeField 非法）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "invalidField",
  "aggBy": ["hostIp"],
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
- `aggFuncs` 必填，至少 1 个元素；为空时返回空结果
- `limit` 最小值 1，无 @Max 上限
- `aggBy` 元素必须是 Incident 实体类字段名，否则返回空结果（不报错）
- `aggFuncs.param` 非空白时必须是 Incident 实体类字段名，否则返回空结果（不报错）

### 参数依赖关系
- `aggBy` 与 `aggByAlias` 长度应一致（一一对应）
- `aggFuncs[0].name` 在 item 中作为聚合值的 key
- 各过滤字段之间为 AND 关系

### 权限要求
- 需具备 `superAdmin` 或 `incidentQuery` 权限
- 数据范围按用户权限过滤

### 性能建议
- 时间窗口过大时聚合可能耗时，建议按业务合理设置
- 主机资产字段（如 hostIp）基数可能很大，limit 建议按业务 Top N 需求传值
- sort 字段建议也是聚合字段，避免无索引排序

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800
- 本接口不返回 meta 元数据，仅返回 item 列表（与 `/incidents/aggregation` 不同）
- 本接口专注主机资产维度，与 `/incidents/aggregation` 通用聚合形成互补

### 使用注意事项
- **limit 默认值 = 5**：不传 limit 时只返回 Top 5 个分组，其余被静默截断不报错。聚合字段为已知有限枚举时传枚举总数，非已知枚举时按业务需求传值
- **aggBy 字段名严格匹配 Incident 实体类**：常用主机资产字段为 `hostIp`、`hostAssetId`、`hostBranchId`、`hostClassify1Id` 等
- **aggFuncs.param 字段校验**：param 非空白时必须是 Incident 字段名（如 `hostIp`），否则返回空结果不报错。`*` 或空白 param 跳过校验
- **业务规则：通用聚合 aggBy 只传 1 个字段**：源码无 @Size 限制但业务上建议单字段分组，多维度聚合走其他专用接口
- **sort 格式为冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔。空格分隔会解析失败
- **aggBy/aggFuncs.param 不存在字段静默返回空**：不会报错，需通过返回的 item 是否为空判断
- **filterParam.dealStatus 是 TMG 状态码**：入参用 TMGIncidentDealStatusEnum（0/10/20/30/40/50/60/70/80），DAO 通过 `tmgDealStatusConvert` 转换查库。**若误传内部 1-6，因 `tmgDealStatusConvert` 内部 `TMGIncidentDealStatusEnum.build(status)` 会抛 `NoSuchSchemeException`，接口直接返回 500，不是查不到事件那么简单**。注意：`/incidents/trends` 和 `/incidents/durationlist` 接口的 dealStatus 入参使用内部 1-6，调用前需核对每个接口的取值口径

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param startTimestamp cannot be empty | 未传 startTimestamp | 必须传 startTimestamp |
| 400 | param endTimestamp cannot be empty | 未传 endTimestamp | 必须传 endTimestamp |
| 400 | param timeField is invalid value. | timeField 不是 IncidentTimeFieldTypeEnum 合法值 | 改为 startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime |
| 400 | must be at least 1 | limit < 1 | 传入 >= 1 |
| 500 | exception.method.execute | 数据库查询异常 | 检查时间范围/aggBy 字段，联系管理员 |
| - | aggBy 字段不存在 | aggBy 含 Incident 实体类中不存在的字段名 | 改为 hostIp/hostAssetId/hostBranchId 等正确字段名（返回空不报错，需自查） |
| - | aggFuncs.param 字段不存在 | aggFuncs.param 非空白且不在 Incident 字段中 | 改为合法字段名或用 `*` 表示计数（返回空不报错，需自查） |
| - | sort 解析失败 | sort 用空格分隔 | 改为冒号分隔 `count:desc` |

## 最佳实践

1. **aggBy 字段选型**：主机IP用 `hostIp`，资产组用 `hostBranchId`，资产类型用 `hostClassify1Id`，国家用 `hostCountryName`
2. **limit 选型**：按 IP/资产维度基数大，建议 limit 10~50；按资产类型基数小（11 个），传 11 拿全部分布
3. **配合通用聚合**：本接口专注主机资产维度，其他维度（severity、dealStatus、incidentThreatClass）用 `/incidents/aggregation`
4. **配合列表接口**：先用本接口拿到事件最多的资产，再用 `/incidents/list` 配合 hostAssetIds/hostBranchIds 过滤查看明细
5. **distinct 用法**：当需要去重计数（如某资产组内不同主机IP数）时用 `func: "distinct"` + `param: "hostIp"`
6. **aggFuncs.param 注意**：param 非空白时必须是 Incident 字段名，否则静默返回空。建议计数用 `*`，去重用具体字段名
7. **无 meta 数据**：本接口不返回 meta（与 `/incidents/aggregation` 不同），客户端需根据 aggBy + aggFuncs 推断 item 结构
8. **资产类型字段参考**：hostClassify1Id 取值参考 Classify1idEnum（参考 enum-dictionary.md）：0/未知, 1/服务器, 2/终端, 3/内网设备, ...
