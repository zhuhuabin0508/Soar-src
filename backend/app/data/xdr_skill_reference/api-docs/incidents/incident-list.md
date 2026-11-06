# POST /api/xdr/v1/incidents/list

## 接口概述

本接口用于分页查询 XDR 系统中的安全事件列表，支持按时间范围、处置状态、事件等级、资产组、平台、数据源、加白状态、事件来源、标签、研判结论、事件分类等多维度过滤，并支持按时间字段排序与按事件名称/主机IP/事件引擎模糊搜索。通过本接口，您可以获取/操作以下内容：

### 可查询的事件基础信息
- **事件标识**：事件ID（uuId）、事件名称（name）、事件描述（description）、产生事件的规则ID（eventRuleId）
- **时间信息**：事件最早发生时间（startTime）、事件最近发生时间（endTime）、事件插入时间（insertTime）、事件更新时间（updateTime）
- **等级与状态**：事件等级（severity）、处置状态（dealStatus）、加白状态（whiteStatus）、审核类型（auditType）、处置动作（dealAction）
- **关联告警**：事件关联告警ID列表（alertIds）

### 可查询的资产信息
- **主机信息**：主机IP（hostIp）、主机资产ID（hostAssetId）、主机资产组（hostBranch）、主机资产父类型（hostClassify1）、主机业务组（hostGroups）、资产组名（branchName）

### 可查询的威胁与研判信息
- **威胁分类**：事件大类（incidentThreatClass）、事件小类（incidentThreatType）、事件类型（eventType）
- **威胁定性**：事件威胁定性（threatDefineName）、GPT研判结论（gptResult）、研判结论中文描述（gptResultDescription）、攻击结果（attackResult）
- **风险标签**：事件标签（riskTag，已通过 RiskSubTagEnum 国际化为中文标签）、攻击意图（attackIntent）

### 可查询的来源信息
- **数据源**：数据来源（dataSource）、数据源类型（dataSourceType）、事件来源（incidentSource）、上报设备ID（manages）、设备来源（devSourceName）、事件引擎（engineName）

### 可查询的处置信息
- **处置建议**：处置建议（recommendation）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件列表查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/incidents/dealstatus/list` 查询处置状态、`/incidents/aggregation` 事件聚合、`/incidents/trends` 事件趋势 |

## 使用场景

1. **安全事件监控**：实时获取系统中的安全事件，用于 SOC 大屏事件列表刷新
2. **事件数据分析**：批量获取事件数据，按等级、处置状态、资产组等维度筛选与分析
3. **事件状态同步**：获取事件处置状态，与外部系统（工单/SIEM）同步
4. **威胁狩猎**：根据源IP、标签、事件分类等条件查询相关事件
5. **事件调查前置**：查询事件获取 uuId 后，配合 `/incidents/aggregation` 深入分析
6. **批量处置前置**：查询事件获取 uuId 列表，配合处置接口批量更新处置状态

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `IncidentsListQo` 并校验
2. 通过 `OpenApiTimeRangeUtil.resolveTimestampAllTime` 处理时间范围：
   - `accurateQuery = !CollectionUtils.isEmpty(incidentsListQo.getUuIds())`
   - accurateQuery=true（uuIds 非空）时进入精确查询模式，时间范围自动设为全量
   - accurateQuery=false 时按入参时间范围查询，时间范围默认最近 7 天
3. 调用 `openApiIncidentService.getIncidentList(incidentsListQo)`
4. Service 内部：
   - 调用 `incidentDao.queryIncidentListV2(incidentsListQo)` 从 MongoDB 分页查询事件
   - 若查询结果为空，返回空 `OpenApiPageResult`
   - 获取资产组ID→名称映射（`groupNameCache.getAssetGroupIdToNameMap`）和资产组ID→名称映射（`branchNameCache`）
   - 遍历事件列表，对每条 Incident 构造 `IncidentData`：
     - 主机业务组名称：通过 hostGroupIds 查 `groupIdToNameMap` 映射
     - 资产组名：通过 hostBranchId 查 `branchNameCache` 映射
     - dealStatus：通过 `DealStatusUtil.dealStatusConvert(incident.getDealStatus())` 转换为内部 IncidentDealStatusEnum statusCode
     - riskTag：通过 `RiskSubTagEnum.getLabelByRiskSubTag` 国际化为中文标签
     - 其他字段直接拷贝
5. 返回 `OpenApiPageResult<IncidentData>`，含 total/page/pageSize/item

### 数据转换逻辑
- `Incident` → `IncidentData`：手动映射字段，部分字段做转换：
  - dealStatus：内部状态码（IncidentDealStatusEnum，1-6）
  - riskTag：原始标签 → 中文标签（通过 RiskSubTagEnum.getLabelByRiskSubTag）
  - hostGroups：hostGroupIds → 业务组名称列表（通过 groupNameCache）
  - hostBranch：hostBranchId → 资产组名（通过 branchNameCache）
- VO 加 `@JsonInclude(NON_NULL)`，未填充字段不输出

### 默认行为
- `timeField` 默认 `endTime`（来源：`IncidentTimeFieldTypeEnum.END_TIME`）
- `sortField` 默认 `endTime`（来源：`IncidentSortFieldTypeEnum.END_TIME`）
- `sortOrder` 默认 `desc`（来源：`SortOrder.DESC.toString()`，ES SortOrder 的 toString 返回小写）
- `pageSize` 默认 5，取值范围 5~200
- `page` 默认 1
- `uuIds` 非空时进入精确查询模式，时间范围自动设为全量
- `excludeWhite` 无（本接口无此字段）

### 特殊规则
- `uuIds` 列表最多 200 个元素（@Size(max=200)），每个元素必须符合 `UUID_CHAR_PARTTERN` 正则
- `dealStatus` 必须为 `TMGIncidentDealStatusEnum` 合法值（0/10/20/30/40/50/60/70/80），否则返回 400 (`dealStatus is illegal`)
- `severities` 必须为 `IncidentSeverityEnum` 合法值（-1/0/1/2/3/4），否则返回 400 (`severities is illegal`)
- `timeField` 必须为 `IncidentTimeFieldTypeEnum` 合法值，否则返回 400 (`param.incident.list.timeField.invalid`)
- `sortField` 必须为 `IncidentSortFieldTypeEnum` 合法值（startTime/endTime/auditTime/updateTime/uploadTime/occurTime/insertTime），否则返回 400 (`param.incident.list.sortField.invalid`)
- `sortOrder` 必须为 `SortOrder` 合法值（asc/desc，小写，ES `SortOrder.toString()` 返回值），否则返回 400 (`param.incident.list.sortOrder.invalid`)
- `sort` 字段格式为 `fieldName:asc` 或 `fieldName:desc`，多字段用逗号分隔（来源：`OPENAPI_SORT_PATTERN` 正则）
- `dataSourceType` 必须为 `DataSourceTypeEnum` 合法值（1/2/3），否则返回 400
- `hostAssetIds` JSON 字段名通过 `@JsonProperty("hostAssetIds")` 指定
- `incidentThreatTypes` JSON 字段名通过 `@JsonProperty("incidentThreatTypes")` 指定
- `excludeParam` JSON 字段名通过 `@JsonProperty("excludeParam")` 指定，含 `hostBranchIds` 字段（@JsonProperty("hostBranchIds")，复数）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long）。uuIds 非空时自动设为 0（全量） | 1750464000 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long） | 1782604800 |
| timeField | string | 否 | endTime | 时间字段，IncidentTimeFieldTypeEnum 合法值 | "endTime" |
| sortField | string | 否 | endTime | 排序字段，IncidentSortFieldTypeEnum 合法值 | "endTime" |
| sortOrder | string | 否 | desc | 排序类型，asc 或 desc（小写，ES SortOrder.toString() 返回值） | "desc" |
| sort | string | 否 | - | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔 | "endTime:desc" |
| pageSize | integer | 否 | 5 | 每页条数，5~200 | 20 |
| page | integer | 否 | 1 | 页码，最小 1 | 1 |
| uuIds | array[string] | 否 | [] | 事件ID列表，最多 200 个元素，每个元素符合 UUID_CHAR_PARTTERN。非空时进入精确查询模式 | ["abc123"] |

#### 状态与等级过滤

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| dealStatus | array[integer] | 否 | [] | 处置状态，TMGIncidentDealStatusEnum 合法值：0/10/20/30/40/50/60/70/80 | [40] |
| severities | array[integer] | 否 | [] | 事件等级，IncidentSeverityEnum 合法值：-1/0/1/2/3/4 | [3, 4] |
| threatDefines | array[integer] | 否 | [] | 事件定性 | [110] |
| gptResults | array[integer] | 否 | [] | 研判结论 | [110] |
| whiteStatus | array[string] | 否 | [] | 加白状态 | ["已加白"] |

#### 资产过滤

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| hostBranchId | array[integer] | 否 | [] | 资产组ID列表 | [101, 102] |
| platformHostBranchIds | array[string] | 否 | - | 平台资产组ID列表 | ["platform-branch-001"] |
| hostBusinessIds | array[integer] | 否 | - | 所属业务（数据库字段：hostGroupIds） | [301] |
| platformHostBusinessIds | array[string] | 否 | - | 所属业务平台（数据库字段：platformHostGroupIds） | ["platform-group-001"] |
| platformIds | array[string] | 否 | - | 平台ID列表 | ["platform_001"] |
| hostAssetIds | array[long] | 否 | - | 资产ID列表（JSON 字段名 hostAssetIds，由 @JsonProperty("hostAssetIds") 指定） | [1001] |

#### 来源过滤

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| dataSources | array[string] | 否 | [] | 数据源列表 | ["sta"] |
| dataSourceType | integer | 否 | - | 数据源类型，DataSourceTypeEnum 合法值：1/2/3 | 1 |
| incidentSources | array[string] | 否 | [] | 事件来源列表 | ["manual"] |
| riskTags | array[string] | 否 | [] | 标签列表 | ["A001_B001"] |
| manages | array[string] | 否 | - | 上报设备ID列表 | ["device_001"] |
| excludeManages | array[string] | 否 | - | 排除上报设备ID列表 | ["device_002"] |
| devSourceNames | array[string] | 否 | - | 设备来源名称列表 | ["sta"] |

#### 分类过滤

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| incidentThreatClasses | array[string] | 否 | [] | 安全事件一级分类列表 | ["0101"] |
| incidentThreatTypes | array[string] | 否 | - | 安全事件二级分类列表（JSON 字段名 incidentThreatTypes，由 @JsonProperty 指定） | ["0101_1"] |

#### 模糊参数（fuzzyParam）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| fuzzyParam | object | 否 | 模糊查询参数，见下方 fuzzyParam 结构说明 | {"name": {"and": [{"value": "永恒", "matchType": "like", "likeType": "contains"}]}} |

**fuzzyParam 结构说明**（来源：IncidentsListQo.FuzzyParam）：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| eventEngine | object | 否 | 事件引擎模糊搜索条件组（OpenApiFuzzyParamGroupQo 类型） | 见下方 |
| name | object | 否 | 事件名称模糊搜索条件组 | 见下方 |
| hostIp | object | 否 | 主机IP模糊搜索条件组 | 见下方 |

**OpenApiFuzzyParamGroupQo 结构**：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| and | array[FilterCondition] | 否 | AND匹配条件列表 | [{"value": "扫描", "matchType": "like", "likeType": "contains"}] |
| or | array[FilterCondition] | 否 | OR匹配条件列表 | [{"value": "攻击", "matchType": "like", "likeType": "prefix"}] |

**FilterCondition 结构**（来源：OpenApiFuzzyParamGroupQo.FilterCondition）：

| 参数名 | 类型 | 必填 | 说明 | 取值范围/示例 |
|--------|------|------|------|---------------|
| value | string | 是 | 匹配值 | "扫描" |
| matchType | string | 是 | 匹配类型 | "="、"!="、"like"、"not like" |
| likeType | string | 条件性 | 匹配方式（matchType 为 like/not like 时必填） | "contains"、"prefix"、"suffix" |

#### 排除参数（excludeParam）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| excludeParam | object | 否 | 排除字段（JSON 字段名 excludeParam，由 @JsonProperty 指定），见下方结构 | {"hostBranchIds": [101]} |

**excludeParam 结构说明**（来源：OpenApiIncidentExcludeQo）：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| hostBranchIds | array[integer] | 否 | 资产组ID列表（JSON 字段名 hostBranchIds，复数，由 @JsonProperty("hostBranchIds") 指定） | [101] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：OpenApiPageResult<IncidentData>）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | long | 满足条件的总记录数 |
| page | integer | 当前页码 |
| pageSize | integer | 每页大小 |
| item | array[IncidentData] | 事件列表，见下方 item 元素结构说明 |

### item 元素结构说明（来源：IncidentData）

> 注意：VO 加 `@JsonInclude(NON_NULL)`，未填充字段不输出。

#### 基础信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| uuId | string | 事件ID | "incident-001" |
| name | string | 事件名称 | "永恒之蓝攻击事件" |
| description | string | 事件描述 | "检测到永恒之蓝攻击" |
| eventType | string | 事件类型 | "malware" |
| eventRuleId | string | 产生事件的规则ID | "rule-001" |

#### 等级与状态

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| severity | integer | 事件等级 | IncidentSeverityEnum，参考 enum-dictionary.md。-1/0-信息, 1-低危, 2-中危, 3-高危, 4-严重 | 4 |
| incidentSeverity | integer | 事件等级（同 severity，冗余字段） | 同 severity | 4 |
| dealStatus | integer | 处置状态 | IncidentDealStatusEnum（已转换），参考 enum-dictionary.md。1-待处置, 2-处置中, 3-处置完成, 4-挂起, 5-已忽略, 6-已遏制 | 1 |
| whiteStatus | string | 加白状态 | WhiteStatusEnum，参考 enum-dictionary.md | "未加白" |
| auditType | string | 事件审核类型 | - | "manual" |
| dealAction | string | 处置动作 | - | "标记处置" |

#### 时间信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| startTime | long | 事件最早发生时间（秒级时间戳） | 1750809600 |
| endTime | long | 事件最近发生时间（秒级时间戳） | 1782604800 |
| insertTime | long | 事件插入时间（秒级时间戳） | 1782604800 |
| updateTime | long | 事件更新时间（秒级时间戳） | 1782604800 |
| startTimeStamp | long | 事件最早发生时间（秒级时间戳，冗余字段） | 1750809600 |
| endTimeStamp | long | 事件最近发生时间（秒级时间戳，冗余字段） | 1782604800 |

#### 资产信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| hostIp | string | 主机IP | "192.168.1.100" |
| hostAssetId | long | 主机资产ID | 1001 |
| hostBranch | string | 主机资产组名 | "财务组" |
| hostClassify1 | string | 主机资产父类型 | "服务器" |
| hostGroups | array[string] | 主机业务组列表 | ["研发中心"] |
| branchName | string | 资产组名 | "财务组" |

#### 关联告警与数据源

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| alertIds | array[string] | 事件关联告警ID列表 | ["alert-001", "alert-002"] |
| dataSource | array[string] | 数据来源 | ["sta"] |
| devSourceName | array[string] | 设备来源 | ["sta (86a45542)"] |
| engineName | array[string] | 事件引擎 | ["IPS引擎"] |
| incidentSource | string | 事件来源 | "manual" |
| phishing | boolean | 是否为钓鱼事件 | false |

#### 威胁与研判

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| riskTag | array[string] | 事件标签（已通过 RiskSubTagEnum 国际化为中文标签，参考 enum-dictionary.md） | - | ["漏洞攻击"] |
| attackIntent | string | 攻击意图 | - | "横向移动" |
| threatDefineName | array[string] | 事件威胁定性 | - | ["攻击成功"] |
| gptResult | integer | GPT研判结论 | PrototypeGptResultEnum，参考 enum-dictionary.md | 110 |
| gptResultDescription | string | 研判结论中文描述 | - | "攻击成功" |
| attackResult | integer | 攻击结果 | - | 0 |
| incidentThreatClass | string | 事件大类 | - | "0101" |
| incidentThreatType | string | 事件小类 | - | "0101_1" |

#### 处置信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| recommendation | string | 处置建议 | "隔离主机并查杀" |
| fileId | string | XTH威胁狩猎文件 | "file-001" |

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
                "uuId": "incident-001",
                "name": "永恒之蓝攻击事件",
                "description": "检测到永恒之蓝攻击",
                "severity": 4,
                "incidentSeverity": 4,
                "eventType": "malware",
                "riskTag": ["漏洞攻击"],
                "hostIp": "192.168.1.100",
                "hostAssetId": 1001,
                "hostBranch": "财务组",
                "hostClassify1": "服务器",
                "hostGroups": ["研发中心"],
                "startTime": 1750809600,
                "endTime": 1782604800,
                "insertTime": 1782604800,
                "updateTime": 1782604800,
                "alertIds": ["alert-001", "alert-002"],
                "dataSource": ["sta"],
                "dealStatus": 1,
                "whiteStatus": "未加白",
                "auditType": "manual",
                "recommendation": "隔离主机并查杀",
                "attackIntent": "横向移动",
                "incidentSource": "manual",
                "engineName": ["IPS引擎"],
                "dealAction": "标记处置",
                "devSourceName": ["sta (86a45542)"],
                "branchName": "财务组",
                "incidentThreatClass": "0101",
                "incidentThreatType": "0101_1",
                "gptResult": 110,
                "gptResultDescription": "攻击成功",
                "attackResult": 0,
                "threatDefineName": ["攻击成功"]
            }
        ]
    }
}
```

## 调用示例

### 示例1：分页查询最近 7 天的事件

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "timeField": "endTime",
    "sortField": "endTime",
    "sortOrder": "desc",
    "page": 1,
    "pageSize": 20
}
```

### 示例2：精确查询 - 根据 uuIds 查询

**请求示例**：
```json
{
    "uuIds": ["incident-001", "incident-002"]
}
```

**说明**：uuIds 非空时进入精确查询模式，时间范围自动设为全量。

### 示例3：按等级和处置状态筛选

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "severities": [3, 4],
    "dealStatus": [0, 10],
    "page": 1,
    "pageSize": 50
}
```

### 示例4：按资产组筛选

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "hostBranchId": [101, 102],
    "page": 1,
    "pageSize": 20
}
```

### 示例5：模糊搜索事件名称

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "fuzzyParam": {
        "name": {
            "and": [
                {"value": "永恒", "matchType": "like", "likeType": "contains"}
            ]
        }
    },
    "page": 1,
    "pageSize": 20
}
```

### 示例6：排除特定资产组

**请求示例**：
```json
{
    "startTimestamp": 1750464000,
    "endTimestamp": 1782604800,
    "excludeParam": {
        "hostBranchIds": [101]
    },
    "page": 1,
    "pageSize": 20
}
```

### 示例7：错误响应 - dealStatus 不合法

**请求示例**：
```json
{
    "dealStatus": [999]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "dealStatus is illegal",
    "data": null
}
```

### 示例8：错误响应 - pageSize 超出范围

**请求示例**：
```json
{
    "pageSize": 500
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param pageSize max is 200",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `uuIds` 最多 200 个元素，每个元素必须符合 `UUID_CHAR_PARTTERN` 正则
- `pageSize` 取值范围 5~200（@Min(5)/@Max(200)）
- `page` 最小 1
- `hostBranchId`/`hostBusinessIds` 元素为 Integer
- `hostAssetIds` 元素为 Long（JSON 字段名 hostAssetIds）
- `platformHostBranchIds`/`platformHostBusinessIds`/`platformIds` 元素为 String

### 参数依赖关系
- **精确查询模式**：`uuIds` 非空时进入精确查询模式（accurateQuery=true），时间范围自动设为全量（startTimestamp=0）
- **时间字段与排序字段**：`timeField` 决定时间范围查询依据的字段，`sortField` 决定排序字段；建议二者一致以获得更好性能
- **dealStatus vs 返回 dealStatus**：入参 `dealStatus` 使用 TMG 状态码（0/10/.../80），返回值 `dealStatus` 是内部状态码（1-6），二者不同
- **sort 与 sortField/sortOrder**：`sort` 是组合排序参数（`fieldName:asc`），`sortField`+`sortOrder` 是分字段排序参数；二者择一使用

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.lists.log"）

### 性能建议
- 时间范围建议不超过 7 天，过大可能查询超时
- `pageSize` 建议 20~50，过大响应延迟
- 已知 uuId 时优先使用 `uuIds` 精确查询，性能优于范围查询

### 使用注意事项
- **dealStatus 入参/返回值不同**：入参用 TMG 状态码（0/10/20/30/40/50/60/70/80），返回值用内部状态码（1-6），调用方需自行映射
- **riskTag 国际化**：返回的 riskTag 已通过 `RiskSubTagEnum.getLabelByRiskSubTag` 国际化为中文标签；国际版环境返回英文标签
- **hostBranch/hostGroups 映射**：通过缓存映射资产组名与业务组名，缓存可能延迟，最新名称需调用资产接口
- **sort 字段格式**：`sort` 字段格式为 `fieldName:asc` 或 `fieldName:desc`，多字段逗号分隔（冒号分隔，非空格）

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 返回 `IncidentData` 加 `@JsonInclude(NON_NULL)`，未填充字段不输出
- `severity` 与 `incidentSeverity` 是同义冗余字段，均表示事件等级

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param.incident.list.timeField.invalid | timeField 不在枚举范围 | 使用合法值：startTime/endTime/auditTime/updateTime/uploadTime/occurTime/disposeTime/durationTimestamp/insertTime |
| 400 | param.incident.list.sortField.invalid | sortField 不在枚举范围 | 使用合法值：startTime/endTime/auditTime/updateTime/uploadTime/occurTime/insertTime |
| 400 | param.incident.list.sortOrder.invalid | sortOrder 不合法 | 使用 asc 或 desc（小写） |
| 400 | param.sort.invalid | sort 格式不合法 | 使用 `fieldName:asc` 或 `fieldName:desc` 格式 |
| 400 | dealStatus is illegal | dealStatus 不在 TMGIncidentDealStatusEnum 枚举范围 | 使用合法值：0/10/20/30/40/50/60/70/80 |
| 400 | severities is illegal | severities 不在 IncidentSeverityEnum 枚举范围 | 使用合法值：-1/0/1/2/3/4 |
| 400 | param.incident.interpretation.dataSourceType.illegal | dataSourceType 不合法 | 使用合法值：1/2/3 |
| 400 | param pageSize min is 5 | pageSize < 5 | 设置 pageSize >= 5 |
| 400 | param pageSize max is 200 | pageSize > 200 | 设置 pageSize <= 200 |
| 400 | uuId format invalid | uuId 不符合 UUID_CHAR_PARTTERN 正则 | 使用合法的 uuId |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | internal error | 服务端异常 | 联系技术支持 |

## 最佳实践

1. **首次调用**：先用 `pageSize=5`、最近 1 小时测试，确认返回结构后再扩大查询范围
2. **精确查询优先**：已知 uuId 时优先使用 `uuIds` 精确查询，性能优于范围查询
3. **时间范围控制**：单次查询时间范围不超过 7 天，历史回溯按天分批
4. **状态码区分**：注意入参 dealStatus 是 TMG 状态码，返回 dealStatus 是内部状态码，调用方需做映射
5. **模糊搜索**：fuzzyParam 支持 eventEngine/name/hostIp 三个字段模糊搜索，matchType=like 时需指定 likeType
6. **配合其他接口**：获取 uuId 后可调 `/incidents/aggregation` 聚合分析
