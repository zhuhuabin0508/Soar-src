# POST /api/xdr/v1/alerts/attackrelations/aggregation

## 接口概述

本接口用于统计攻击源与被攻击目标之间的匹配关系数据，按 srcIpInfos 和 dstIpInfos 嵌套字段分组聚合，支持双向嵌套聚合（src→reverse_nested→dst）+ 多种聚合函数（max/severity、max/dealStatus 等），并通过 aggFuncs 配置聚合操作。通过本接口，您可以获取以下内容：

### 可聚合的攻击关系维度（aggBy 白名单，来自 srcIpInfos.{IpInfo字段} 和 dstIpInfos.{IpInfo字段}）
- **源 IP 信息**：srcIpInfos.ip、srcIpInfos.countryName、srcIpInfos.provinceName、srcIpInfos.branchId、srcIpInfos.classify1Id 等
- **目的 IP 信息**：dstIpInfos.ip、dstIpInfos.countryName、dstIpInfos.provinceName、dstIpInfos.branchId、dstIpInfos.classify1Id 等

> aggBy 必须含至少 2 个嵌套字段（格式 `srcIpInfos.xxx` 或 `dstIpInfos.xxx`），第一层为 src 维度，第二层为 dst 维度。

### 可过滤的告警维度（filterParam）
- **资产组/业务组**：hostBranchIds、hostBusinessIds、platformHostBranchIds、platformHostBusinessIds
- **方向/状态/等级**：accessDirections、alertDealStatus、severities、whiteStatus
- **源 IP 信息**：srcIps、srcCountryNames、srcProvinceName
- **平台**：platformIds

### 可排除的维度（excludeParam）
- **源国家**：srcCountryNames
- **目的国家**：dstCountryNames
- **资产组**：hostBranchIds
- **源 IP**：srcIps

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 告警聚合 - 攻击关系统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/alerts/aggregation` 通用告警聚合、`/api/xdr/v1/alerts/ipinfosstats` 双维度聚合、`/api/xdr/v1/alerts/asset/aggregation` 资产聚合 |

## 使用场景

1. **攻击源-目的 IP 关系矩阵**：按 srcIpInfos.ip + dstIpInfos.ip 双层聚合，统计每个源 IP 攻击的目的 IP 分布
2. **国家间攻击关系统计**：按 srcIpInfos.countryName + dstIpInfos.countryName 双层聚合，统计国家间攻击关系
3. **源国家-目的资产组关系**：按 srcIpInfos.countryName + dstIpInfos.branchId 双层聚合，统计源国家攻击的资产组分布
4. **资产组间攻击关系**：按 srcIpInfos.branchId + dstIpInfos.branchId 双层聚合，统计资产组间的攻击关系
5. **配合 max 聚合提取最大严重等级**：在 aggFuncs 中配置 `max` 聚合 severity，统计每个攻击关系的最大严重等级
6. **配合 max 聚合提取最大处置状态**：在 aggFuncs 中配置 `max` 聚合 dealStatus，统计每个攻击关系的最大处置状态

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/attackrelations/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Valid + Service 层）：
   - Controller 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，未传时按默认规则补全
   - DAO 校验 `aggBy` 至少 2 个字段（`MIN_AGGREGATION_FIELDS`），否则抛 `IllegalArgumentException("aggBy must contain at least two fields for nested aggregation")`
   - 校验 aggBy 每个字段必须含 `.`（嵌套字段标识），第一字段必须是 `srcIpInfos.xxx` 或 `dstIpInfos.xxx`，否则抛 `IllegalArgumentException`
   - 校验 aggByAlias 与 aggBy 长度匹配（不匹配时打警告日志但继续执行）
2. **构建 ES 查询**：
   - `buildBoolQueryBuilder`：时间范围（`* 1000L` 转毫秒给 ES）+ filterParam（hostBranchIds/hostBusinessIds/accessDirections/severities/whiteStatus/srcCountryNames/srcProvinceName/srcIps/platformIds 等）+ RegionFilter
   - `buildAggregationPipeline`：嵌套聚合管道
     - Step 1：第一层 nested（srcIpInfos 或 dstIpInfos）+ terms 聚合（按 aggBy[0] 分组）+ 可选 filter 聚合（含 srcCountryNames/srcProvinceName 过滤 + excludeParam.srcCountryNames 排除）
     - Step 2：reverse_nested 退出第一层
     - Step 3：第二层 nested（dstIpInfos 或 srcIpInfos）+ terms 聚合（按 aggBy[1] 分组）
     - Step 4：reverse_nested 退出第二层
     - Step 5：在 reverse_nested 下添加 aggFuncs 配置的子聚合（如 max(severity)、max(dealStatus)）
3. **执行 ES 查询**：调用 ES SearchRequest，按 `applyDateRoutingFromSeconds` 路由索引
4. **结果解析**：`executeAndParse` 解析嵌套桶，生成 `Map<String, Object>` 含 item 列表
5. **返回**：封装为 `OpenApiResponse<Map<String, Object>>`

### 数据转换逻辑

- ES 嵌套聚合桶 → `Map<String, Object>`：每层桶 key 作为分组字段值，docCount 作为计数
- aggFuncs 子聚合结果按 name 作为 key 写入
- 时间单位：入参秒级 Long，DAO 层 `* 1000L` 转毫秒给 ES

### 默认行为
- `startTimestamp` / `endTimestamp` 未传时由 `OpenApiTimeRangeUtil.resolveTimestamp` 处理（取最近 7 天）
- `limit` 未传时默认 5
- `flatReturn` 未传时默认 false（非平铺结构返回）
- `aggByAlias` 可为空（使用 aggBy 字段名作为别名）

### 特殊规则
- `aggBy` 必须含至少 2 个字段（`@Size(min=1, max=3)` 但 DAO 要求 ≥ 2）
- `aggBy` 每个字段必须含 `.`，格式为 `srcIpInfos.xxx` 或 `dstIpInfos.xxx`
- 第一层 aggBy 决定 src 维度（srcIpInfos. 或 dstIpInfos.），第二层决定 dst 维度（与第一层相反）
- `aggFuncs` 可为空（默认含 docCount 计数）
- `limit` 控制每层 terms 聚合返回的桶数
- `sort` 格式为 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔
- `filterParam` 中 srcCountryNames/srcProvinceName 同时作用于查询过滤和聚合内过滤
- `excludeParam.srcCountryNames` 在聚合内 mustNot 排除特定国家
- DAO 异常时抛 `exception.method.execute`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long）。未传时由 Controller 取最近 7 天 | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long）。未传时由 Controller 取当前时间 | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，取值见 AlertTimeFieldTypeEnum 枚举表 | "lastTime" |
| filterParam | object | 否 | - | 其他过滤字段，结构见下方 OpenApiAlertAggFilterQo 子结构表 | {"hostBranchIds":[1]} |
| excludeParam | object | 否 | - | 排除字段，结构见下方 OpenApiAlertAggExcludeQo 子结构表 | {"srcCountryNames":["Unknown"]} |
| aggBy | array[string] | 否 | - | 分组字段列表，[1, 3] 个元素。每个字段必须为 `srcIpInfos.{field}` 或 `dstIpInfos.{field}` 格式。**DAO 要求至少 2 个字段** | ["srcIpInfos.countryName","dstIpInfos.branchId"] |
| aggByAlias | array[string] | 否 | - | 分组别名，长度需与 aggBy 一致 | ["srcCountry","dstBranch"] |
| aggFuncs | array[object] | 否 | - | 聚合操作列表，结构见下方 AggFuncsDTO 子结构表 | [{"name":"maxSeverity","func":"max","param":"severity"}] |
| sort | string | 否 | - | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "count:desc" |
| limit | integer | 否 | 5 | TOP 数量 ≥ 1。未传时默认 5 静默截断不报错；按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N | 10 |
| flatReturn | boolean | 否 | false | 是否返回平铺结构结果 | false |

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

#### aggBy 白名单（来自 srcIpInfos.{IpInfo字段} 和 dstIpInfos.{IpInfo字段}）

可用分组字段（每个 aggBy 元素必须以 `srcIpInfos.` 或 `dstIpInfos.` 开头，后接 IpInfo 实体类字段名）：
- srcIpInfos.ip / dstIpInfos.ip
- srcIpInfos.countryName / dstIpInfos.countryName
- srcIpInfos.provinceName / dstIpInfos.provinceName
- srcIpInfos.branchId / dstIpInfos.branchId
- srcIpInfos.classify1Id / dstIpInfos.classify1Id
- srcIpInfos.classifyId / dstIpInfos.classifyId
- srcIpInfos.assetId / dstIpInfos.assetId
- srcIpInfos.xUserName / dstIpInfos.xUserName
- srcIpInfos.xUserGroup / dstIpInfos.xUserGroup
- srcIpInfos.intelligenceTags / dstIpInfos.intelligenceTags
- srcIpInfos.responsible / dstIpInfos.responsible

> 必须使用 `srcIpInfos.{field}` 或 `dstIpInfos.{field}` 格式，不能直接用 IpInfo 字段名。

#### aggFuncs 支持的函数

| func 值 | 说明 |
|---------|------|
| count | 计数 |
| cardinality | 去重计数 |
| avg | 平均值 |
| max | 最大值 |
| min | 最小值 |
| sum | 求和 |

#### filterParam 子结构（OpenApiAlertAggFilterQo）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| alertDealStatus | array[integer] | 否 | 处置状态过滤（数据库字段 dealStatus），取值参考 DealStatusEnum | [1,2] |
| alertDealActions | array[string] | 否 | 处置动作过滤（数据库字段 dealAction） | ["manualMarking"] |
| accessDirections | array[integer] | 否 | 访问方向过滤（数据库字段 direction），取值参考 AttackDirectionEnum | [2] |
| assetIds | array[string] | 否 | 资产 ID 过滤（数据库字段 assetId） | ["101"] |
| hostIps | array[string] | 否 | 主机 IP 过滤（数据库字段 hostIp） | ["192.168.1.10"] |
| gptResults | array[integer] | 否 | GPT 研判结果过滤（数据库字段 gptResult），取值参考 PrototypeGptResultEnum | [110,120] |
| hostBranchIds | array[integer] | 否 | 资产组 ID 过滤（数据库字段 hostBranchId） | [1,2] |
| platformHostBranchIds | array[string] | 否 | 平台资产组 ID | ["pf-branch-1"] |
| threatDefines | array[integer] | 否 | 告警定性过滤（数据库字段 threatDefine） | [110] |
| hostBusinessIds | array[integer] | 否 | 所属业务过滤（数据库字段 hostGroupIds） | [10] |
| platformHostBusinessIds | array[string] | 否 | 所属业务平台 | ["pf-biz-1"] |
| platformIds | array[string] | 否 | 平台 ID | ["platform1"] |
| severities | array[integer] | 否 | 告警等级过滤（数据库字段 severity），取值参考 SeverityEnum | [3,4] |
| read | boolean | 否 | 告警是否已读 | false |
| whiteStatus | array[string] | 否 | 加白状态过滤，取值参考 WhiteStatusEnum | ["未加白"] |
| manages | array[string] | 否 | 上报设备 ID | ["dev-001"] |
| devUids | array[integer] | 否 | 数据源 | [1] |
| attackResults | array[integer] | 否 | 攻击结果过滤（数据库字段 attackResult），取值参考 AttackResultEnum | [1,2] |
| srcCountryNames | array[string] | 否 | 攻击源国家过滤（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["China"] |
| engineNames | array[string] | 否 | 检测引擎过滤（数据库字段 engineName），最多 10 个 | ["engine1"] |
| srcProvinceName | array[string] | 否 | 省份过滤（数据库字段 provinceName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Beijing"] |
| srcIps | array[string] | 否 | 攻击源 IP 过滤（数据库字段 srcIp） | ["8.8.8.8"] |
| dstIps | array[string] | 否 | 目的 IP 过滤（数据库字段 dstIp） | ["192.168.1.10"] |
| dstIpsClassify1idList | array[integer] | 否 | 目的 IP 资产类型 | [0,1,3] |
| stages | array[integer] | 否 | 告警阶段 | [0,10,30] |
| alarmClassifications | array[string] | 否 | 告警分类 ID 字符串数组。元素格式 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`（数字 ID，逗号分隔，最多 3 级）。**严禁传中文名**——后端会逐段 `Integer.parseInt`，传中文名会抛 NumberFormatException 导致 500。详见 enum-dictionary-pending.md 第 10 节 | ["1"] |
| alertNames | array[string] | 否 | 告警名称，须符合 INCIDENT_NAME_CHAR_PATTERN | ["SQL注入"] |
| proofType | array[string] | 否 | 举证类型，须符合 COMMON_LEGAL_CHAR_PATTERN | ["type1"] |
| combineType | array[integer] | 否 | 组合类型 | [1] |
| devSourceNames | array[string] | 否 | 设备来源名称 | ["sensor1"] |
| dstCountryNames | array[string] | 否 | 目的 IP 国家，最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["China"] |
| dstBranchIds | array[integer] | 否 | 目的 IP 资产组（数据库字段 dstIpInfos.branchId） | [1,2] |
| attckTechniques | array[string] | 否 | ATTCK 技术 | ["TA0001.T0001"] |

#### excludeParam 子结构（OpenApiAlertAggExcludeQo）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| manages | array[string] | 否 | 排除上报设备 ID | ["dev-001"] |
| proofType | array[string] | 否 | 排除 protobuf 协议 | ["type1"] |
| columns | array[string] | 否 | 排除不存在的字段 | ["field1"] |
| srcCountryNames | array[string] | 否 | 排除攻击源国家（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Unknown"] |
| alertDealActions | array[string] | 否 | 排除处置动作（数据库字段 dealAction） | ["autoSuppress"] |
| hostBranchIds | array[integer] | 否 | 排除资产组 ID（数据库字段 hostBranchId） | [3] |
| dstCountryNames | array[string] | 否 | 排除目的 IP 国家，最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Unknown"] |
| srcIps | array[string] | 否 | 排除攻击源 IP（数据库字段 srcIp） | ["1.1.1.1"] |

#### AggFuncsDTO 子结构（OpenApiAlertAggQo.AggFuncsDTO）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 否 | 聚合结果名称，长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | "maxSeverity" |
| func | string | 是 | 聚合操作名称（count/cardinality/avg/max/min/sum），长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | "max" |
| param | string | 是 | 聚合字段，长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | "severity" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（Map<String, Object>） |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[object] | 攻击关系聚合结果列表，每个元素为嵌套聚合桶的扁平化 Map |
| message | string | 错误时附加的错误信息（如 "error: ..."） |

### item 元素结构说明

每个 item 元素的字段由请求的 `aggBy`、`aggByAlias` 和 `aggFuncs` 动态决定：

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| {aggBy[0] 或 aggByAlias[0]} | string | 第一层聚合桶值（src 维度） | 由 aggBy[0] 字段决定 | "China" |
| {aggBy[0] + "Cnt"} | long | 第一层聚合桶的 docCount | - | 1234 |
| {aggBy[1] 或 aggByAlias[1]} | string | 第二层聚合桶值（dst 维度） | 由 aggBy[1] 字段决定 | "1" |
| {aggBy[1] + "Cnt"} | long | 第二层聚合桶的 docCount | - | 234 |
| {aggFuncs.name} | number | 聚合函数计算结果（如 max(severity)） | 由 func 类型决定 | 85 |

## 调用示例

### 示例1：按源国家-目的资产组统计攻击关系

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggBy": ["srcIpInfos.countryName", "dstIpInfos.branchId"],
  "aggByAlias": ["srcCountry", "dstBranch"],
  "aggFuncs": [
    {"name": "maxSeverity", "func": "max", "param": "severity"},
    {"name": "maxDealStatus", "func": "max", "param": "dealStatus"}
  ],
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
      {
        "srcCountry": "China",
        "srcCountryCnt": 1234,
        "dstBranch": "1",
        "dstBranchCnt": 567,
        "maxSeverity": 85,
        "maxDealStatus": 3
      },
      {
        "srcCountry": "United States",
        "srcCountryCnt": 856,
        "dstBranch": "2",
        "dstBranchCnt": 234,
        "maxSeverity": 75,
        "maxDealStatus": 2
      }
    ]
  }
}
```

### 示例2：按源 IP-目的 IP 统计攻击关系（带过滤和排除）

**请求示例**：
```json
{
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "filterParam": {
    "hostBranchIds": [1, 2],
    "accessDirections": [2],
    "severities": [3, 4],
    "srcCountryNames": ["China", "Russia"]
  },
  "excludeParam": {
    "srcCountryNames": ["Unknown"]
  },
  "aggBy": ["srcIpInfos.ip", "dstIpInfos.ip"],
  "aggByAlias": ["srcIp", "dstIp"],
  "aggFuncs": [
    {"name": "alertCount", "func": "count", "param": "_id"}
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
      {"srcIp": "8.8.8.8", "srcIpCnt": 1234, "dstIp": "192.168.1.10", "dstIpCnt": 234, "alertCount": 234},
      {"srcIp": "5.5.5.5", "srcIpCnt": 856, "dstIp": "192.168.1.11", "dstIpCnt": 198, "alertCount": 198}
    ]
  }
}
```

### 示例3：错误响应 - aggBy 字段数不足

**请求示例**（aggBy 仅 1 个字段）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggBy": ["srcIpInfos.countryName"],
  "aggFuncs": [{"name":"count","func":"count","param":"_id"}]
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "aggBy must contain at least two fields for nested aggregation",
  "data": null
}
```

### 示例4：错误响应 - aggBy 字段格式不合法

**请求示例**（aggBy 字段不含 `.`）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggBy": ["countryName", "branchId"],
  "aggFuncs": [{"name":"count","func":"count","param":"_id"}]
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "first aggBy field must be a nested field (e.g., srcIpInfos.xxx)",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp`/`endTimestamp`：秒级 Long
- `aggBy`：[1, 3] 个元素（DAO 要求 ≥ 2），每个必须含 `.`，格式 `srcIpInfos.{field}` 或 `dstIpInfos.{field}`
- `aggByAlias`：长度需与 aggBy 一致
- `aggFuncs`：每个元素的 name 长度 ≤ 64，func/param 必填且长度 ≤ 64
- `limit`：≥ 1，默认 5
- `filterParam.srcCountryNames`/`srcProvinceName`/`dstCountryNames`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- `excludeParam.srcCountryNames`/`dstCountryNames`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- 时间范围：建议 ≤ 30 天

### 参数依赖关系
- `aggBy` 必须含至少 2 个嵌套字段，第一层决定 src 维度（srcIpInfos./dstIpInfos.），第二层决定 dst 维度
- `aggByAlias` 长度应与 aggBy 一致，不一致时使用 aggBy 字段名作为别名
- `filterParam.srcCountryNames` 同时作用于查询过滤和聚合内过滤
- `excludeParam.srcCountryNames` 在聚合内 mustNot 排除特定国家

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `limit` 不要传超大值，按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N
- `aggBy` 字段数建议 2-3 个，多层嵌套聚合会指数级增长桶数
- 时间范围建议 ≤ 30 天，避免长范围查询影响响应速度
- `aggFuncs` 配置 max(severity)/max(dealStatus) 等可提取每个攻击关系的最大严重等级和处置状态

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- 聚合结果中的 `{aggBy字段}Cnt` 为该层桶的 docCount（告警数），非去重计数

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.method.execute | DAO 执行异常 | 检查 aggBy 字段格式和过滤参数 |
| 500 | aggBy must contain at least two fields for nested aggregation | aggBy 字段数 < 2 | 至少传 2 个嵌套字段 |
| 500 | first aggBy field must be a nested field (e.g., srcIpInfos.xxx) | aggBy[0] 不含 `.` 或不是嵌套字段 | 使用 `srcIpInfos.{field}` 或 `dstIpInfos.{field}` 格式 |
| 500 | second aggBy field must be a nested field (e.g., dstIpInfos.xxx) | aggBy[1] 不含 `.` 或不是嵌套字段 | 使用 `srcIpInfos.{field}` 或 `dstIpInfos.{field}` 格式 |
| 400 | param timeField is invalid value. | timeField 不在 AlertTimeFieldTypeEnum | 使用枚举值（firstTime/lastTime 等） |
| 400 | aggBy must have at least 1 and at most 3 elements | aggBy 元素数不在 [1, 3] | 调整 aggBy 数量 |
| 400 | startTimestamp field length less than 0 | startTimestamp < 0 | startTimestamp ≥ 0 |
| 400 | startTimestamp field length over than 9999999999 | startTimestamp > 9999999999 | startTimestamp ≤ 9999999999 |

## 最佳实践

1. **aggBy 字段格式**：必须使用 `srcIpInfos.{field}` 或 `dstIpInfos.{field}` 格式，第一层为 src 维度，第二层为 dst 维度
2. **aggByAlias 配合**：传 aggByAlias 可让返回字段名更可读（如 srcCountry 而非 srcIpInfos.countryName）
3. **aggFuncs 配置 max**：在攻击关系统计中常配置 max(severity) 和 max(dealStatus)，提取每个攻击关系的最大严重等级和处置状态
4. **filterParam 与 excludeParam 配合**：先按 srcCountryNames 包含过滤特定国家，再用 excludeParam.srcCountryNames 排除其中的特定国家（如 Unknown）
5. **limit 取值**：聚合字段为已知有限枚举时传枚举总数（如 classify1Id 共 11 个 → limit=11），非已知枚举时按业务需求给 N
6. **时间范围优化**：建议查询 ≤ 30 天数据，避免长范围查询影响响应速度
7. **aggBy 字段数控制**：建议 2-3 个，多层嵌套聚合桶数指数增长，影响性能和结果可读性
