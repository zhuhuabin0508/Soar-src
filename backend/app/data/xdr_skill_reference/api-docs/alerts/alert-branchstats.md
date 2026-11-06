# POST /api/xdr/v1/alerts/branchstats

## 接口概述

本接口用于查询境内外受攻击资产的分组统计数据，根据 aggFuncs.param 自动决定分组维度（srcIpInfos 或 dstIpInfos 的 countryName/provinceName），支持按时间范围、平台、方向、源国家、源省份、处置状态、攻击结果、源 IP、告警等级过滤，并支持排除特定源国家。通过本接口，您可以获取以下内容：

### 可聚合的维度（aggFuncs.param 决定分组字段）
- **源 IP 维度**：aggFuncs.param 全部为 `srcIpInfos.{field}` 时，按 `srcIpInfos.countryName` 分组（若 filterParam.srcProvinceName 非空则按 `srcIpInfos.provinceName` 分组）
- **目的 IP 维度**：aggFuncs.param 不全为 `srcIpInfos.{field}` 时，按 `dstIpInfos.countryName` 分组

### 可过滤的告警维度（filterParam）
- **平台/方向**：platformIds、accessDirections
- **源国家/省份**：srcCountryNames、srcProvinceName（同时决定分组字段）
- **处置状态/攻击结果**：alertDealStatus、attackResults
- **源 IP/告警等级**：srcIps、severities

### 可排除的维度（excludeParam）
- **源国家**：srcCountryNames（排除特定源国家，并过滤空国家）

### 返回的统计数据
- **meta**：字段元数据（每个 aggFuncs.name 的类型为 Integer）
- **item**：数据列表（每个元素为分组字段值 + 各 aggFuncs 计数）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 告警聚合 - 境内外资产统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/alerts/aggregation` 通用告警聚合、`/api/xdr/v1/alerts/ipinfosstats` 双维度聚合、`/api/xdr/v1/alerts/asset/aggregation` 资产聚合 |

## 使用场景

1. **境内外受攻击资产统计**：按国家维度分组统计境内外受攻击资产的告警数
2. **源场景统计**：aggFuncs.param 全部为 srcIpInfos.{field} 时，按源国家分组统计攻击源告警数
3. **目的场景统计**：aggFuncs.param 含 dstIpInfos.{field} 时，按目的国家分组统计受攻击资产告警数
4. **省份维度统计**：filterParam.srcProvinceName 非空时，按源省份分组统计
5. **按源IP+国家双维度聚合统计**：filterParam 同时含 srcIps + srcCountryNames 时，按源 IP + 国家双维度聚合统计
6. **排除特定国家**：通过 excludeParam.srcCountryNames 排除特定源国家（如 Unknown）
7. **配合通用聚合接口**：与 `/alerts/aggregation` 配合，本接口专注于境内外资产维度统计

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/branchstats |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Valid + Service 层）：
   - Controller 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，未传时按默认规则补全
   - Service 校验 `startTimestamp > endTimestamp` 时抛 `exception.param.time.scope.error`
   - DAO 校验 `aggFuncs` 不能为空（为空时打警告日志并返回空列表）
2. **构建 ES 查询**：
   - 时间范围：`* 1000L` 转毫秒给 ES
   - filterParam：platformIds（cascade 过滤）、accessDirections、srcCountryNames（nested 过滤）、srcProvinceName（nested 过滤）、alertDealStatus、attackResults、srcIps（格式校验 + size 限制）、severities（按 SeverityEnum 映射）
   - excludeParam.srcCountryNames：nested mustNot 过滤 + 非空国家过滤
3. **构建聚合**：
   - 收集 aggFuncs.param，根据是否全部含 `srcIpInfos.` 决定分组字段：
     - 全部为 `srcIpInfos.{field}` 且 filterParam.srcProvinceName 非空 → 按 `srcIpInfos.provinceName` 分组
     - 全部为 `srcIpInfos.{field}` 且 filterParam.srcProvinceName 为空 → 按 `srcIpInfos.countryName` 分组
     - 否则 → 按 `dstIpInfos.countryName` 分组（skipCountryFilter = true，不进行国家过滤）
   - 构建 nested 聚合 + composite 聚合（size 10000）+ aggFuncs 子聚合（count/cardinality）
4. **执行 ES 查询**：调用 ES SearchRequest，按 `applyDateRoutingFromSeconds` 路由索引
5. **结果解析**：`extractBranchCompositeAggBuckets` 解析 composite 桶，应用 excludeCountryList（排除特定国家）和 filterCountryList（过滤特定国家/省份），生成 `List<Map<String, Integer>>`
6. **结果封装**：
   - 数据为空时返回 `OpenApiAggResult`（meta 和 item 都为空列表）
   - 调用 `pkgBranchAggItems` 组装 items
   - 每个 aggFuncs.name 创建一个 `OpenApiAggResultMeta`，type 固定为 "Integer"
7. **返回**：封装为 `OpenApiResponse<OpenApiAggResult>`

### 数据转换逻辑

- ES composite 桶 → `Map<String, Integer>`：桶 key 为分组字段值，aggFuncs 子聚合结果按 name 写入
- aggFuncs.type 固定为 "Integer"（meta 中声明）
- 时间单位：入参秒级 Long，DAO 层 `* 1000L` 转毫秒给 ES

### 默认行为
- `startTimestamp` / `endTimestamp` 未传时由 Controller `OpenApiTimeRangeUtil.resolveTimestamp` 处理（取最近 7 天）
- `timeField` 为空时默认 lastTime
- `limit` 未传时默认 5
- `aggByAlias` 可为空（使用 aggBy 字段名作为别名）
- `aggFuncs` 为空时返回空结果（不报错）

### 特殊规则
- **分组字段由 aggFuncs.param 自动决定，不接受用户传入的 aggBy**
- aggFuncs.param 全部为 `srcIpInfos.{field}` 时按源国家/省份分组，否则按目的国家分组
- filterParam.srcProvinceName 非空时按源省份分组（覆盖源国家分组）
- excludeParam.srcCountryNames 排除特定源国家，并过滤空国家（mustNot + 非空过滤）
- srcIps 格式校验：每个元素须符合 IPV4_V6 正则，size 限制为 ARRAY_MAX_LENGTH
- severities 按 SeverityEnum.buildByScoreNum 映射为 midScore
- `aggFuncs` 中 func 仅支持 count/cardinality（其他函数被忽略）
- composite 聚合 size 固定为 10000（ES_10000_LIMIT）
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
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long，[0, 9999999999]）。未传时由 Controller 取最近 7 天 | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long，[0, 9999999999]）。未传时由 Controller 取当前时间 | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，取值见 AlertTimeFieldTypeEnum 枚举表 | "lastTime" |
| filterParam | object | 否 | - | 其他过滤字段，结构见下方 OpenApiAlertAggFilterQo 子结构表 | {"accessDirections":[2]} |
| fuzzyParam | object | 否 | - | 模糊参数，结构见下方 OpenApiAlertAggFuzzyParam 子结构表 | {"alertName":{"value":"SQL"}} |
| excludeParam | object | 否 | - | 排除字段，结构见下方 OpenApiAlertAggExcludeQo 子结构表 | {"srcCountryNames":["Unknown"]} |
| aggBy | array[string] | 否 | - | 分组字段（**本接口忽略用户传入的 aggBy，由 aggFuncs.param 自动决定**），最多 8 个 | ["srcIpInfos.countryName"] |
| aggByAlias | array[string] | 否 | - | 分组别名 | ["srcCountry"] |
| aggFuncs | array[object] | 是 | - | 聚合操作列表，结构见下方 AggFuncsDTO 子结构表。**param 决定分组维度** | [{"name":"count","func":"count","param":"srcIpInfos.ip"}] |
| sort | string | 否 | - | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "count:desc" |
| limit | integer | 否 | 5 | TOP 数量 ≥ 1。未传时默认 5 静默截断不报错；按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N | 10 |

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

#### aggFuncs 支持的函数（本接口实际仅生效 count/cardinality）

| func 值 | 说明 |
|---------|------|
| count | 计数（生效） |
| cardinality | 去重计数（生效） |
| avg | 平均值（不生效，被忽略） |
| max | 最大值（不生效，被忽略） |
| min | 最小值（不生效，被忽略） |
| sum | 求和（不生效，被忽略） |

#### aggFuncs.param 决定分组字段

| aggFuncs.param 取值 | 决定的分组字段 |
|---------------------|---------------|
| 全部为 `srcIpInfos.{field}` 且 filterParam.srcProvinceName 非空 | srcIpInfos.provinceName |
| 全部为 `srcIpInfos.{field}` 且 filterParam.srcProvinceName 为空 | srcIpInfos.countryName |
| 含 `dstIpInfos.{field}` 或其他 | dstIpInfos.countryName |

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
| platformIds | array[string] | 否 | 平台 ID（cascade 过滤） | ["platform1"] |
| severities | array[integer] | 否 | 告警等级过滤（数据库字段 severity），取值参考 SeverityEnum，按 buildByScoreNum 映射为 midScore | [3,4] |
| read | boolean | 否 | 告警是否已读 | false |
| whiteStatus | array[string] | 否 | 加白状态过滤，取值参考 WhiteStatusEnum | ["未加白"] |
| manages | array[string] | 否 | 上报设备 ID | ["dev-001"] |
| devUids | array[integer] | 否 | 数据源 | [1] |
| attackResults | array[integer] | 否 | 攻击结果过滤（数据库字段 attackResult），取值参考 AttackResultEnum | [1,2] |
| srcCountryNames | array[string] | 否 | 攻击源国家过滤（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["China"] |
| engineNames | array[string] | 否 | 检测引擎过滤（数据库字段 engineName），最多 10 个 | ["engine1"] |
| srcProvinceName | array[string] | 否 | 省份过滤（数据库字段 provinceName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN。**非空时决定按 provinceName 分组** | ["Beijing"] |
| srcIps | array[string] | 否 | 攻击源 IP 过滤（数据库字段 srcIp），每个元素须符合 IPV4_V6 正则，size 限制为 ARRAY_MAX_LENGTH | ["8.8.8.8"] |
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

#### fuzzyParam 子结构（OpenApiAlertAggQo.OpenApiAlertAggFuzzyParam）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| alertName | object | 否 | 告警名称模糊搜索，结构见 OpenApiFuzzyParamGroupQo | {"value":"SQL"} |

#### excludeParam 子结构（OpenApiAlertAggExcludeQo）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| manages | array[string] | 否 | 排除上报设备 ID | ["dev-001"] |
| proofType | array[string] | 否 | 排除 protobuf 协议 | ["type1"] |
| columns | array[string] | 否 | 排除不存在的字段 | ["field1"] |
| srcCountryNames | array[string] | 否 | 排除攻击源国家（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN。**同时过滤空国家** | ["Unknown"] |
| alertDealActions | array[string] | 否 | 排除处置动作（数据库字段 dealAction） | ["autoSuppress"] |
| hostBranchIds | array[integer] | 否 | 排除资产组 ID（数据库字段 hostBranchId） | [3] |
| dstCountryNames | array[string] | 否 | 排除目的 IP 国家，最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Unknown"] |
| srcIps | array[string] | 否 | 排除攻击源 IP（数据库字段 srcIp） | ["1.1.1.1"] |

#### AggFuncsDTO 子结构（OpenApiAlertAggQo.AggFuncsDTO）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 否 | 聚合结果名称，长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | "alertCount" |
| func | string | 是 | 聚合操作名称（count/cardinality，其他被忽略），长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | "count" |
| param | string | 是 | 聚合字段，长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN。**决定分组维度（srcIpInfos.{field} 或 dstIpInfos.{field}）** | "srcIpInfos.ip" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiAggResult） |

### data 结构说明（OpenApiAggResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| meta | array[object] | 元数据列表，每个元素含 name + type（固定为 "Integer"） |
| item | array[object] | 数据列表，每个元素为分组字段值 + 各 aggFuncs 计数 |

#### meta 子结构（OpenApiAggResultMeta）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 字段名称（aggFuncs.name） | - | "alertCount" |
| type | string | 字段类型（固定为 "Integer"） | "Integer" | "Integer" |

#### item 元素结构说明

每个 item 元素的字段由分组字段和 aggFuncs 决定：

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| {分组字段名} | string | 分组字段值（srcIpInfos.countryName 或 dstIpInfos.countryName 或 srcIpInfos.provinceName） | - | "China" |
| {aggFuncs.name} | integer | 聚合计数结果 | - | 1234 |

## 调用示例

### 示例1：按源国家分组统计告警数（源场景）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggFuncs": [
    {"name": "alertCount", "func": "count", "param": "srcIpInfos.ip"},
    {"name": "uniqueIps", "func": "cardinality", "param": "srcIpInfos.ip"}
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
    "meta": [
      {"name": "alertCount", "type": "Integer"},
      {"name": "uniqueIps", "type": "Integer"}
    ],
    "item": [
      {"srcIpInfos.countryName": "China", "alertCount": 1234, "uniqueIps": 567},
      {"srcIpInfos.countryName": "United States", "alertCount": 856, "uniqueIps": 234},
      {"srcIpInfos.countryName": "Russia", "alertCount": 412, "uniqueIps": 156}
    ]
  }
}
```

### 示例2：按目的国家分组统计（目的场景）

**请求示例**：
```json
{
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "filterParam": {
    "accessDirections": [2],
    "severities": [3, 4],
    "srcCountryNames": ["China", "Russia"]
  },
  "excludeParam": {
    "srcCountryNames": ["Unknown"]
  },
  "aggFuncs": [
    {"name": "alertCount", "func": "count", "param": "dstIpInfos.ip"}
  ],
  "limit": 5
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [
      {"name": "alertCount", "type": "Integer"}
    ],
    "item": [
      {"dstIpInfos.countryName": "China", "alertCount": 1234},
      {"dstIpInfos.countryName": "United States", "alertCount": 856}
    ]
  }
}
```

### 示例3：按源省份分组统计（srcProvinceName 决定分组）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "filterParam": {
    "srcProvinceName": ["Beijing", "Shanghai"]
  },
  "aggFuncs": [
    {"name": "alertCount", "func": "count", "param": "srcIpInfos.ip"}
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
    "meta": [
      {"name": "alertCount", "type": "Integer"}
    ],
    "item": [
      {"srcIpInfos.provinceName": "Beijing", "alertCount": 1234},
      {"srcIpInfos.provinceName": "Shanghai", "alertCount": 567}
    ]
  }
}
```

### 示例4：错误响应 - aggFuncs 为空

**请求示例**（aggFuncs 为空）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggFuncs": []
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [],
    "item": []
  }
}
```

### 示例5：错误响应 - startTimestamp > endTimestamp

**请求示例**（时间范围非法）：
```json
{
  "startTimestamp": 1783209600,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggFuncs": [{"name":"count","func":"count","param":"srcIpInfos.ip"}]
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "时间范围不合法",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp`/`endTimestamp`：秒级 Long，[0, 9999999999]
- `aggFuncs`：必填，每个元素的 name 长度 ≤ 64，func/param 必填且长度 ≤ 64
- `limit`：≥ 1，默认 5
- `aggBy`：最多 8 个元素（**但本接口忽略用户传入的 aggBy，由 aggFuncs.param 自动决定**）
- `filterParam.srcIps`：每个元素须符合 IPV4_V6 正则，size 限制为 ARRAY_MAX_LENGTH
- `filterParam.srcCountryNames`/`srcProvinceName`/`dstCountryNames`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- `excludeParam.srcCountryNames`/`dstCountryNames`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- composite 聚合 size 固定为 10000

### 参数依赖关系
- **aggFuncs.param 决定分组字段**：全部为 `srcIpInfos.{field}` 时按源国家/省份分组，否则按目的国家分组
- **filterParam.srcProvinceName 非空时覆盖源国家分组**：按 srcIpInfos.provinceName 分组
- **excludeParam.srcCountryNames 排除特定源国家并过滤空国家**
- `filterParam.srcIps` 格式校验失败抛 `exception.srcIp.error.format`，size 超限抛 `exception.srcIp.size.limit`

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `limit` 不要传超大值，按 OpenAPI 接口选型推荐指南：聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N
- 时间范围建议 ≤ 30 天，避免长范围查询影响响应速度
- `aggFuncs` 仅 count/cardinality 生效，其他函数被忽略

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- 返回的 `item` 中分组字段名为完整 ES 字段名（如 `srcIpInfos.countryName`），非别名
- `meta.type` 固定为 "Integer"，aggFuncs 结果均按整数返回

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.method.execute | DAO 执行异常 | 检查参数格式和时间范围 |
| 500 | exception.param.time.scope.error | startTimestamp > endTimestamp | 确保 startTimestamp ≤ endTimestamp |
| 500 | exception.srcIp.error.format | srcIps 元素格式非法 | 每个元素须符合 IPV4_V6 正则 |
| 500 | exception.srcIp.size.limit | srcIps size 超限 | 减少 srcIps 数量 |
| 400 | param timeField is invalid value. | timeField 不在 AlertTimeFieldTypeEnum | 使用枚举值（firstTime/lastTime 等） |
| 400 | param.invalid.focus.on.aggBy.size | aggBy 元素数 > 8 | 减少 aggBy 数量（本接口忽略 aggBy，可不传） |
| 400 | startTimestamp field length less than 0 | startTimestamp < 0 | startTimestamp ≥ 0 |
| 400 | startTimestamp field length over than 9999999999 | startTimestamp > 9999999999 | startTimestamp ≤ 9999999999 |
| 400 | name fields length out of range | aggFuncs.name 长度 > 64 | 缩短 name |
| 400 | name invalid field format | aggFuncs.name 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |
| 400 | func fields length out of range | aggFuncs.func 长度 > 64 | 缩短 func |
| 400 | func invalid field format | aggFuncs.func 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |
| 400 | param fields length out of range | aggFuncs.param 长度 > 64 | 缩短 param |
| 400 | param invalid field format | aggFuncs.param 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |
| 400 | srcCountryNames fields size out of range | srcCountryNames 元素数 > 10 | 减少 srcCountryNames 数量 |
| 400 | srcCountryNames invalid field format | srcCountryNames 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |

## 最佳实践

1. **aggFuncs.param 决定分组维度**：源场景用 `srcIpInfos.{field}`，目的场景用 `dstIpInfos.{field}`，本接口自动按 countryName 分组
2. **srcProvinceName 决定按省份分组**：filterParam.srcProvinceName 非空时，按 srcIpInfos.provinceName 分组（覆盖源国家分组）
3. **aggFuncs 仅 count/cardinality 生效**：其他函数（avg/max/min/sum）被忽略，如需复杂聚合用 `/alerts/aggregation` 接口
4. **limit 取值**：聚合字段为已知有限枚举时传枚举总数（如国家约 200 个 → limit=200），非已知枚举时按业务需求给 N
5. **srcCountryNames 与 excludeParam 配合**：先按 srcCountryNames 包含过滤特定国家，再用 excludeParam.srcCountryNames 排除其中的特定国家（如 Unknown）
6. **时间范围优化**：建议查询 ≤ 30 天数据，避免长范围查询影响响应速度
7. **复合接口选择**：本接口专注于境内外资产维度统计，复杂聚合用 `/alerts/aggregation`，IP 详情用 `/alerts/ipInfos`
