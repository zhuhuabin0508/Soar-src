# POST /api/xdr/v1/alerts/asset/aggregation

## 接口概述

本接口用于按 IP 资产维度对安全告警进行分组聚合统计，支持按源 IP 或目的 IP 资产的多字段分组、多种聚合函数（count/sum/avg/cardinality/max/min）以及 Top N 限制。通过本接口，您可以获取以下内容：

### 可聚合的 IP 资产维度（aggBy 白名单，来自 IpInfo 实体类字段）
- **基础网络信息**：ip、port、mac
- **资产归属信息**：assetId、branchId、branchName、platformAssetId、platformBranchId、groupIds、platformGroupIds、responsible
- **地理信息**：countryName、provinceName
- **资产分类**：classifyId、classify1Id
- **用户信息**：xUserName、xUserGroup
- **威胁情报**：intelligenceTags、intelligenceConfidence、intelligenceSeverity
- **关联标识**：isRelateUnit

### 可过滤的告警维度（filterParam）
- **攻击结果**：attackResults
- **加白状态**：whiteStatus
- **访问方向**：accessDirections
- **资产组**：hostBranchIds
- **平台 ID**：platformIds

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口（@Api("告警开放性接口")） |
| 接口分类 | 告警聚合 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/alerts/aggregation` 通用告警聚合、`/api/xdr/v1/alerts/ipinfosstats` 双维度聚合、`/api/xdr/v1/alerts/ipInfos` IP 详情查询 |

## 使用场景

1. **资产维度 Top N 统计**：按 ip 字段分组 + count 聚合，统计告警数最多的 Top N 源/目的 IP 资产
2. **资产组分布统计**：按 branchId/branchName 分组，统计各资产组的告警分布
3. **国家/省份分布统计**：按 countryName 或 provinceName 分组，统计告警的地理分布
4. **资产分类分布**：按 classify1Id（资产父类型）或 classifyId（资产子类型）分组，统计不同资产类型的告警数
5. **威胁情报标签聚合**：按 intelligenceTags 分组，统计各威胁情报标签关联的告警数
6. **多维资产分组**：按多字段（如 countryName + branchId）嵌套分组，统计资产的多维告警分布
7. **源/目的资产对比分析**：分别用 ipType=src 和 ipType=dst 调用，对比攻击源资产与受攻击资产的分布差异

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/asset/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller 层 + Service 层）：
   - Controller 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，未传时按默认规则补全
   - Service 校验时间差值在 [0, 180] 天内，超出抛 `exception.time.range`
   - 校验 `aggBy` 不能为空，为空抛 `exception.aggBy.empty`
   - 校验 `aggBy` 中所有字段必须属于 `IpInfo` 实体类的字段集合，不合法抛 `exception.aggBy.invalid`
   - 校验 `aggFuncs`（若非空）：
     - `name/func/param` 三个字段都不能为空，否则抛 `exception.aggFuncs.empty`
     - `param` 必须是 `IpInfo` 字段，否则抛 `exception.aggFuncs.param.invalid`
     - `name` 不能重复，否则抛 `exception.aggFuncs.name.duplicate`
     - `name` 必须符合 `LEGAL_CHAR_PATTERN`，否则抛 `exception.aggFuncs.name.illegal`
     - `name` 长度 ≤ 95，否则抛 `exception.aggFuncs.name.too.long`
   - 校验 `filterParam.hostBranchIds`（若非空）：每个元素必须 ≥ 0，否则抛 `exception.param.error`
2. **查询 ES**：调用 `alertDao.getAlertAssetAggResult(queryQo)`，按 `ipType`（src→srcIpInfos / dst→dstIpInfos）走 nested 聚合，按 `aggBy` 列表多层 terms 嵌套分组，按 `aggFuncs` 配置 cardinality/value_count/sum/avg/max/min 等聚合
3. **结果解析**：从 `SearchResponse` 中按 `path`（srcIpInfos 或 dstIpInfos）取出 NestedAggregation，取 `aggBy` 第一个字段为顶层 Terms 聚合，调用 `flattenBuckets` 递归拆解多层桶：
   - Terms 子桶递归展开，键名为聚合字段名，键值为桶 key
   - Cardinality 子聚合取去重计数值
   - ValueCount 子聚合取计数值
4. **排序**：调用 `sortResults(itemList, queryQo.getSort())`，按 sort 字段（如 `count:desc`）对结果列表排序
5. **limit 截断**：若结果数 > `limit`，取前 `limit` 条返回（静默截断，不报错）
6. **返回**：封装为 `OpenApiAlertAssetAggVo`，含 `item` 列表

### 数据转换逻辑

- ES Aggregation 桶 → `Map<String, Object>`：桶的 key 作为字段名对应的值，子聚合结果按聚合 name 作为 key 写入
- 时间单位：DAO 层查询时 `startTimestamp/endTimestamp * 1000L` 转毫秒给 ES；本接口入参时间戳为秒级

### 默认行为

- `startTimestamp` / `endTimestamp` 未传时由 `OpenApiTimeRangeUtil.resolveTimestamp` 处理（取最近 7 天）
- `limit` 未传时默认 5，结果超出时静默截断前 5 条
- `sort` 未传时按 ES 返回顺序（聚合桶默认按 doc_count 降序）

### 特殊规则

- `aggBy` 字段必须来自 `IpInfo` 实体类字段白名单，不允许使用 Alert 实体字段
- `ipType` 必传，决定走 srcIpInfos 还是 dstIpInfos 的 nested 聚合路径
- `aggFuncs` 最多 5 个（`@Size(max = 5)`）
- `limit` 范围 [1, 200]
- `sort` 格式必须为 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔，正则校验 `^(\\w+:(asc|desc))(,\\w+:(asc|desc))*$`
- 时间范围最长 180 天

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long，最大 9999999999）。未传时由 Controller 取最近 7 天 | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long，最大 9999999999）。未传时由 Controller 取当前时间 | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，取值见 AlertTimeFieldTypeEnum 枚举表 | "lastTime" |
| filterParam | object | 否 | - | 其他过滤参数，结构见下方 OpenApiAlertAssetAggFilterQo 子结构表 | {"hostBranchIds":[1,2]} |
| aggBy | array[string] | 是 | - | 聚合字段列表，必须使用 IpInfo 实体类字段名（详见下方白名单）。多个字段按列表顺序多层嵌套分组。**实际必填**：为空/缺省时 Service 层校验直接拒绝（`exception.aggBy.empty`），线上表现为 HTTP 200 + code=235「系统繁忙」 | ["countryName","ip"] |
| aggFuncs | array[object] | 否 | - | 聚合操作列表，最多 5 个。结构见下方 AggFuncsDTO 子结构表 | [{"name":"count","func":"count","param":"ip"}] |
| ipType | string | 是 | - | IP 类型，取值见 AlertIpTypeEnum 枚举表（src/dst） | "src" |
| sort | string | 否 | - | 排序规则，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "count:desc" |
| limit | integer | 否 | 5 | 返回分组数量上限 [1, 200]。未传时默认 5，结果超出静默截断不报错；按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N，不要传超大值绕过截断 | 10 |

#### timeField 枚举（AlertTimeFieldTypeEnum，参考 enum-dictionary.md）

| 取值 | 说明 |
|------|------|
| firstTime | 首次发现时间 |
| lastTime | 最近发生时间 |
| updateTime | 更新时间 |
| dealTime | 处置时间 |
| occurTime | 发生时间 |
| uploadTime | 上传时间 |
| _insertTime | 入库时间 |

#### ipType 枚举（AlertIpTypeEnum）

| 取值 | 说明 | 对应 nested 路径 |
|------|------|----------------|
| src | 源 IP | srcIpInfos |
| dst | 目的 IP | dstIpInfos |

#### aggBy 白名单（来自 IpInfo 实体类字段名）

可用分组字段：ip、port、xUserGroup、xUserName、countryName、provinceName、branchId、platformBranchId、groupIds、platformGroupIds、assetId、platformAssetId、classifyId、classify1Id、intelligenceTags、intelligenceConfidence、intelligenceSeverity、isRelateUnit、responsible、branchName

> 必须使用 IpInfo 实体类字段名，不能使用告警字段（如 srcIp）。

#### aggFuncs 支持的函数

| func 值 | 说明 |
|---------|------|
| count | 计数 |
| cardinality | 去重计数 |
| avg | 平均值 |
| max | 最大值 |
| min | 最小值 |
| sum | 求和 |

#### filterParam 子结构（OpenApiAlertAssetAggFilterQo）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| attackResults | array[integer] | 否 | 攻击结果过滤（数据库字段 attackResult），取值参考 AttackResultEnum（0-尝试/1-成功/2-失败/3-失陷） | [1,2] |
| whiteStatus | array[string] | 否 | 加白状态过滤（数据库字段 whiteStatus），取值参考 WhiteStatusEnum | ["未加白"] |
| accessDirections | array[integer] | 否 | 访问方向过滤（数据库字段 direction），取值参考 AttackDirectionEnum（0-无/1-内对外/2-外对内/3-内对内） | [2] |
| hostBranchIds | array[integer] | 否 | 资产组 ID 过滤（数据库字段 hostBranchId），每个元素 ≥ 0 | [1,2,3] |
| platformIds | array[string] | 否 | 平台 ID 过滤 | ["platform1"] |

#### AggFuncsDTO 子结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | 聚合结果名称，不能重复，须符合 LEGAL_CHAR_PATTERN，长度 ≤ 95 | "count" |
| func | string | 是 | 聚合操作名称（count/cardinality/avg/max/min/sum） | "count" |
| param | string | 是 | 聚合字段，必须是 IpInfo 实体类字段 | "ip" |

#### ⚠️ param 字段高频踩坑（必读）

`param` 是本接口**最高频出错**的字段。Service 层在执行前会做白名单校验：

```java
// Service 层白名单校验
if (!ClassUtil.classToMap(IpInfo.class).containsKey(aggFunc.getParam())) {
    throw new IncidentException(I18nUtils.i18n("exception.aggFuncs.param.invalid"));
}
```

错误现象：传 `"param": "*"` 会直接返回 `{"code":"InternalError","message":"聚合操作中, param为非法值"}`，**不会进入 ES 查询阶段**。

| 错误传值 | 后果 | 正确替代 |
|---------|------|---------|
| `"*"` | 校验失败：`聚合操作中, param为非法值` | 用真实 IpInfo 字段，`func=count` 推荐 `"ip"` |
| `"srcIp"` / `"dstIp"` | 校验失败：不是 IpInfo 字段 | 用 `"ip"`（IpInfo 内部字段名就是 `ip`，源/目的由 `ipType` 控制） |
| `"alertName"` 等 Alert 字段 | 校验失败：本接口只接受 IpInfo 字段 | 改用通用聚合接口 `/alerts/aggregation` |
| `"uuId"` | 校验失败 | 用 `"ip"` 或其它 IpInfo 字段 |

DAO 层把 `param` 拼成 ES 字段路径 `path + "." + param`（如 `srcIpInfos.ip`），即便绕过校验，`*` 在 ES 也不存在对应字段，会静默返回空桶。

#### sort 字段行为说明

`sort` 在 DAO 和 Service 两层各有一次处理：

1. **DAO 层 applySorting**：只对 `sortKey === aggBy字段名` 的项生效，控制 ES terms 聚合桶的内部排序（`BucketOrder.key(asc/desc)`）。如 `aggBy=["ip"]` + `sort="ip:asc"` → ES 桶按 IP 字符串升序。
2. **Service 层 sortResults**：对最终结果 `List<Map>` 按 `map.get(sortKey)` 排序。结果 Map 的 key 包含 `aggBy` 字段名 **和** `aggFuncs.name`，所以 `sort="alertCount:desc"`（`alertCount` 为 aggFuncs 的 name）也能生效，按聚合计数降序。

**结论**：
- 想按聚合计数排序 → `sort="<aggFuncs.name>:desc"`（如 `"alertCount:desc"`）
- 想按分组字段值排序 → `sort="<aggBy字段名>:asc"`（如 `"ip:asc"`）
- `sort` 必须是结果 Map 中真实存在的 key（aggBy 字段名或 aggFuncs.name），否则 `map.get(field)` 返回 null，`Comparator.nullsLast` 把所有元素当 null 等价，排序无效但不报错

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（TC-002 实测） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiAlertAssetAggVo） |

### data 结构说明（OpenApiAlertAssetAggVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[object] | 告警主机统计列表，每个元素为聚合桶的扁平化 Map，键名为 aggBy 字段名或 aggFuncs 的 name |

### item 元素结构说明

每个 item 元素的字段由请求的 `aggBy` 和 `aggFuncs` 动态决定：

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| {aggBy字段1} | string | aggBy 列表第一个字段的桶值 | 由 aggBy 字段决定 | "China" |
| {aggBy字段2} | string | aggBy 列表第二个字段的桶值（如有） | 由 aggBy 字段决定 | "10.0.0.1" |
| {aggFuncs.name} | number | 聚合函数计算结果 | 由 func 类型决定 | 100 |

## 调用示例

### 示例1：按源 IP 国家分组统计告警数 Top 10

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "ipType": "src",
  "aggBy": ["countryName"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "ip"
    }
  ],
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
      {"countryName": "China", "count": 1523},
      {"countryName": "United States", "count": 856},
      {"countryName": "Russia", "count": 412},
      {"countryName": "Unknown", "count": 305},
      {"countryName": "Germany", "count": 198},
      {"countryName": "France", "count": 156},
      {"countryName": "Japan", "count": 132},
      {"countryName": "United Kingdom", "count": 98},
      {"countryName": "Brazil", "count": 76},
      {"countryName": "India", "count": 54}
    ]
  }
}
```

### 示例2：按资产组+源 IP 双层分组统计

**请求示例**：
```json
{
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "ipType": "src",
  "filterParam": {
    "attackResults": [1, 2],
    "accessDirections": [2]
  },
  "aggBy": ["branchId", "ip"],
  "aggFuncs": [
    {
      "name": "alertCount",
      "func": "count",
      "param": "ip"
    },
    {
      "name": "uniqueIps",
      "func": "cardinality",
      "param": "ip"
    }
  ],
  "sort": "alertCount:desc",
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
      {"branchId": "1", "ip": "192.168.1.10", "alertCount": 234, "uniqueIps": 1},
      {"branchId": "1", "ip": "192.168.1.11", "alertCount": 198, "uniqueIps": 1},
      {"branchId": "2", "ip": "10.0.0.5", "alertCount": 156, "uniqueIps": 1},
      {"branchId": "2", "ip": "10.0.0.6", "alertCount": 132, "uniqueIps": 1},
      {"branchId": "3", "ip": "172.16.0.1", "alertCount": 98, "uniqueIps": 1}
    ]
  }
}
```

### 示例3：按目的 IP 资产父类型分布统计

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "ipType": "dst",
  "aggBy": ["classify1Id"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "assetId"
    }
  ],
  "limit": 11
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"classify1Id": "1", "count": 1234},
      {"classify1Id": "2", "count": 856},
      {"classify1Id": "5", "count": 412},
      {"classify1Id": "8", "count": 198},
      {"classify1Id": "0", "count": 156}
    ]
  }
}
```

### 示例4：错误响应 - aggBy 字段不在白名单

**请求示例**（aggBy 字段非法）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "ipType": "src",
  "aggBy": ["srcIp"],
  "aggFuncs": [{"name": "count", "func": "count", "param": "ip"}]
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "聚合字段不合法",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp` / `endTimestamp`：秒级 Long，最大 9999999999（10 位）
- `limit`：[1, 200]，默认 5
- `aggFuncs`：最多 5 个元素
- `aggFuncs.name`：长度 ≤ 95，须符合 LEGAL_CHAR_PATTERN，不能重复
- 时间范围：[0, 180] 天

### 参数依赖关系
- `aggBy` 与 `aggFuncs.param` 必须都使用 `IpInfo` 实体类字段名，不能使用告警实体字段
- `ipType` 决定 nested 聚合路径（srcIpInfos / dstIpInfos）
- `sort` 字段名需与 `aggBy` 字段名或 `aggFuncs.name` 对应

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `limit` 不要传超大值，按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数（如 classify1Id 共 11 个 → limit=11），非已知枚举时通过会话让业务方给出 N
- 时间范围建议 ≤ 30 天，超过会显著增加 ES 聚合开销
- `aggBy` 字段数建议 ≤ 3，多层嵌套聚合会指数级增长桶数

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.time.range | 时间范围超过 180 天或结束时间早于开始时间 | 检查 startTimestamp/endTimestamp 差值在 [0, 180] 天 |
| 500 | exception.aggBy.empty | aggBy 字段为空 | 至少传一个 IpInfo 字段作为 aggBy |
| 500 | exception.aggBy.invalid | aggBy 字段不在 IpInfo 白名单 | 使用 IpInfo 实体类字段名（如 ip、countryName、branchId） |
| 500 | exception.aggFuncs.empty | aggFuncs 中 name/func/param 有空值 | 三个字段都必填 |
| 500 | exception.aggFuncs.param.invalid | aggFuncs.param 不是 IpInfo 字段 | 改用 IpInfo 字段名 |
| 500 | exception.aggFuncs.name.duplicate | aggFuncs.name 重复 | 每个 aggFuncs 元素的 name 必须唯一 |
| 500 | exception.aggFuncs.name.illegal | aggFuncs.name 含非法字符 | name 须符合 LEGAL_CHAR_PATTERN |
| 500 | exception.aggFuncs.name.too.long | aggFuncs.name 长度 > 95 | 缩短 name |
| 500 | exception.param.error | filterParam.hostBranchIds 含负值 | hostBranchIds 元素 ≥ 0 |
| 400 | param.startTimestamp.null | startTimestamp 未传 | 必传 startTimestamp |
| 400 | param.endTimestamp.null | endTimestamp 未传 | 必传 endTimestamp |
| 400 | param.timeField.null | timeField 未传 | 必传 timeField |
| 400 | param.timeField.invalid | timeField 不在 AlertTimeFieldTypeEnum | 使用枚举值（firstTime/lastTime 等） |
| 400 | param.ipType.null | ipType 未传 | 必传 ipType |
| 400 | param.ipType.invalid | ipType 不在 AlertIpTypeEnum | 使用 src 或 dst |
| 400 | param.limit.min | limit < 1 | limit ≥ 1 |
| 400 | param.limit.max | limit > 200 | limit ≤ 200 |
| 400 | param.sort.invalid | sort 格式不合法 | 使用 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 |

## 最佳实践

1. **ipType 选择**：分析攻击源用 `ipType=src`，分析受攻击资产用 `ipType=dst`
2. **limit 取值**：聚合字段为已知有限枚举（如 classify1Id 共 11 个）时传枚举总数；非已知枚举（如 ip）时按业务需求给 N（如 Top 10），不要传超大值绕过截断
3. **aggBy 字段数控制**：建议 ≤ 3 个，多层嵌套聚合桶数指数增长，影响性能和结果可读性
4. **aggFuncs 配合 aggBy**：count 配 cardinality 去重计数，sum/avg/max/min 配数值字段（如 port）
5. **sort 排序**：按聚合结果排序时使用 `aggFuncs.name:desc`（如 `count:desc`），按分组字段排序时使用 `aggBy字段名:asc`
6. **时间范围优化**：尽量使用 lastTime 字段并限制 ≤ 30 天，避免全量扫描
7. **filterParam 过滤**：合理使用 hostBranchIds 过滤目标资产组，减少聚合数据量
