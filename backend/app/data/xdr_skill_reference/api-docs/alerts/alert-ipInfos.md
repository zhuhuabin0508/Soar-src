# POST /api/xdr/v1/alerts/ipInfos

## 接口概述

本接口用于按时间范围和过滤条件聚合查询告警IP信息（源IP/目的IP维度），支持按 aggBy 指定字段分组，返回 IP、资产ID、资产组、地理位置、资产分类等聚合结果。通过本接口，您可以获取以下内容：

### 可查询的IP聚合信息
- **IP地址**：聚合后的 IP（ip）
- **资产信息**：资产ID（assetId）、资产组ID（branchId）、资产大类ID（classify1Id）、资产小类ID（classifyId）
- **地理位置**：国家名称（countryName）、省份名称（provinceName）
- **聚合计数**：该 IP 的告警数量（value）

### 可用的过滤维度
- **访问方向**：accessDirections（0/1/2/3）
- **资产组**：hostBranchIds
- **业务组**：hostGroupIds
- **告警等级**：severities
- **加白状态**：whiteStatus
- **数据源**：devUids
- **告警分类**：alarmClassifications
- **攻击结果**：attackResults
- **目的IP资产类型**：dstIpClassify1Ids
- **源IP**：srcIps
- **平台相关**：platformIds、platformHostBranchIds、platformHostBusinessIds

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 告警IP聚合查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询、`/alerts/ipinfosstats` 攻击源与受攻击资产聚合查询、`/alerts/aggregation` 通用告警聚合查询 |

## 使用场景

1. **攻击源IP统计**：按源IP聚合统计告警数量，识别高频攻击源IP
2. **受攻击资产IP统计**：按目的IP聚合统计告警数量，识别高频受攻击资产
3. **IP地理分布分析**：聚合IP并按国家/省份分组，分析攻击源地理分布
4. **资产维度告警统计**：按资产ID/资产组聚合，统计各资产的告警数量
5. **配合告警列表使用**：聚合获取高频IP后，调用 `/alerts/list` 按 srcIps 过滤获取详细告警

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/ipInfos |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 startTimestamp、endTimestamp 必填（@NotNull）
   - 校验 timeField 必填（@NotNull），取值必须为 AlertTimeFieldTypeEnum 枚举值（firstTime/lastTime/updateTime/dealTime/occurTime/uploadTime/_insertTime）
   - 校验 aggBy 必填（@NotNull），分组字段列表
   - 校验 limit 必填（@NotNull），返回条数限制
2. **时间范围补全**：Controller 层通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理 startTimestamp/endTimestamp 空值（默认补全为最近 7 天）
3. **aggBy 字段合法性校验**：Service 层通过 `classToMap(IpInfo.class)` 获取 IpInfo 类的字段映射，校验 aggBy 字段是否存在于 IpInfo 类中
   - aggBy 字段需以 `srcIpInfos.` 或 `dstIpInfos.` 为前缀（根据字段名首字母判断：s 开头用 srcIpInfos.，否则用 dstIpInfos.）
   - 移除前缀后的字段名必须在 IpInfo 类的字段集合中
   - 校验失败时返回空 item 列表
4. **查询 ES**：调用 `alertDao.getAlertIpInfosResult(openApiAlertIpInfosQo)` 执行聚合查询
5. **空结果处理**：查询结果为空时返回空 item 列表
6. **返回结果**：将聚合结果封装到 OpenApiIpInfosResultVo.item 返回

### 数据转换逻辑

- 数据来源：ES 告警表（通过 alertDao.getAlertIpInfosResult）
- aggBy 字段映射：aggBy 字段需带 srcIpInfos. 或 dstIpInfos. 前缀，对应 ES 嵌套文档字段
- 返回字段：聚合结果直接映射为 OpenApiIpInfosResultVo.Items，使用 @JsonProperty 注解指定 JSON 字段名
- 空值处理：使用 @JsonInclude(JsonInclude.Include.NON_NULL) 注解，null 字段不序列化

### 默认行为

- 不指定时间范围时，Controller 层自动补全为最近 7 天
- aggBy 字段校验失败时返回空 item 列表（不抛异常）
- 查询结果为空时返回空 item 列表
- limit 控制返回的聚合桶数量

### 特殊规则

1. **aggBy 前缀规则**：
   - 字段名以 "s" 开头（如 srcIp）使用 `srcIpInfos.` 前缀
   - 其他字段使用 `dstIpInfos.` 前缀
   - 前缀判断逻辑：`aggBy.get(0).toLowerCase().startsWith("s")`
2. **aggBy 字段必须在 IpInfo 类中存在**：移除前缀后的字段名必须是 IpInfo 类的字段
3. **timeField 枚举校验**：通过 @Enum 注解校验，必须为 AlertTimeFieldTypeEnum 枚举值
4. **JSON 字段名**：所有 QO 和 VO 字段使用 @JsonProperty 注解指定 JSON 字段名
5. **空值序列化**：VO 中 null 字段不序列化（@JsonInclude(NON_NULL)）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long） | 1782864000 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1783473600 |
| timeField | string | 是 | - | 过滤的时间字段，必填。取值范围（AlertTimeFieldTypeEnum）：firstTime、lastTime、updateTime、dealTime、occurTime、uploadTime、_insertTime | "lastTime" |
| aggBy | array[string] | 是 | - | 分组字段列表，必填。字段需以 srcIpInfos. 或 dstIpInfos. 为前缀，移除前缀后必须是 IpInfo 类的字段 | ["srcIpInfos.ip"] |
| limit | integer | 是 | - | 返回条数限制，必填。控制返回的聚合桶数量 | 10 |

#### timeField 枚举值说明（来源：AlertTimeFieldTypeEnum，参考 enum-dictionary.md）

| 枚举值 | 说明 |
|--------|------|
| firstTime | 最早发生时间 |
| lastTime | 最近发生时间 |
| updateTime | 更新时间 |
| dealTime | 处置时间 |
| occurTime | 发生时间 |
| uploadTime | 上传时间 |
| _insertTime | 入库时间（ES 内部字段名，带下划线前缀） |

#### filterParam 结构说明（来源：OpenApiAlertIpInfosFilterQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| accessDirections | array[integer] | 否 | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md）：0/无, 1/内对外, 2/外对内, 3/内对内 | [1, 2] |
| hostBranchIds | array[integer] | 否 | 资产组ID列表（数据库字段：hostBranchId） | [101, 102] |
| hostGroupIds | array[integer] | 否 | 业务组ID列表（数据库字段：hostGroupIds） | [301] |
| severities | array[integer] | 否 | 告警等级（SeverityEnum 的 scoreNum）：-1/未知, 0/信息, 1/低危, 2/中危, 3/高危, 4/严重 | [3, 4] |
| whiteStatus | array[string] | 否 | 加白状态（WhiteStatusEnum，参考 enum-dictionary.md）：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2" | ["未加白"] |
| devUids | array[integer] | 否 | 数据源ID列表（数据库字段：devUId） | [2001] |
| alarmClassifications | array[string] | 否 | 告警分类 ID 字符串数组。元素格式 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`（数字 ID，逗号分隔，最多 3 级）。**严禁传中文名**——后端会逐段 `Integer.parseInt`，传 `"web攻击"` 会抛 NumberFormatException 导致 500。详见 enum-dictionary-pending.md 第 10 节 | ["1"] |
| platformIds | array[string] | 否 | 平台ID列表 | ["platform_1"] |
| platformHostBranchIds | array[string] | 否 | 平台资产组ID列表 | ["branch_001"] |
| platformHostBusinessIds | array[string] | 否 | 平台业务组ID列表 | ["biz_001"] |
| attackResults | array[integer] | 否 | 攻击结果（AttackResultEnum，参考 enum-dictionary.md）：0/尝试, 1/成功, 2/失败, 3/失陷 | [1] |
| dstIpClassify1Ids | array[integer] | 否 | 目的IP资产类型（Classify1idEnum，参考 enum-dictionary.md） | [1, 2] |
| srcIps | array[string] | 否 | 攻击源IP列表（数据库字段：srcIp） | ["192.168.1.1"] |

#### aggBy 字段说明

aggBy 字段需以 `srcIpInfos.` 或 `dstIpInfos.` 为前缀，常用字段包括：

| aggBy 字段 | 说明 |
|-----------|------|
| srcIpInfos.ip | 源IP地址 |
| srcIpInfos.assetId | 源IP资产ID |
| srcIpInfos.branchId | 源IP资产组ID |
| srcIpInfos.classify1Id | 源IP资产大类ID |
| srcIpInfos.classifyId | 源IP资产小类ID |
| srcIpInfos.countryName | 源IP国家名称 |
| srcIpInfos.provinceName | 源IP省份名称 |
| dstIpInfos.ip | 目的IP地址 |
| dstIpInfos.assetId | 目的IP资产ID |
| dstIpInfos.branchId | 目的IP资产组ID |
| dstIpInfos.classify1Id | 目的IP资产大类ID |
| dstIpInfos.classifyId | 目的IP资产小类ID |
| dstIpInfos.countryName | 目的IP国家名称 |
| dstIpInfos.provinceName | 目的IP省份名称 |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，见下方 data 结构说明 |

### data 结构说明（来源：OpenApiIpInfosResultVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[Items] | IP聚合结果列表，见下方 Items 结构说明 |

### item 元素结构说明（来源：OpenApiIpInfosResultVo.Items）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| ip | string | IP地址（null 不序列化） | - | "192.168.1.1" |
| assetId | long | 资产ID（null 不序列化） | - | 1001 |
| value | long | 聚合计数（告警数量） | - | 25 |
| branchId | integer | 资产组ID（null 不序列化） | - | 1 |
| classifyId | integer | 资产小类ID（null 不序列化） | - | 101 |
| classify1Id | integer | 资产大类ID（Classify1idEnum，参考 enum-dictionary.md，null 不序列化） | 0/未知, 1/服务器, 2/终端, 3/内网设备, 4/互联网设备, 5/网络设备, 6/IoT设备, 7/移动设备, 8/网络安全产品, 9/云平台, 10/企业应用软件 | 1 |
| provinceName | string | 省份名称（null 不序列化） | - | "广东" |
| countryName | string | 国家名称（null 不序列化） | - | "中国" |

> 注：null 字段不序列化（@JsonInclude(NON_NULL)），实际返回字段根据 aggBy 选择确定。

## 调用示例

### 示例1：按源IP聚合统计告警数量

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["srcIpInfos.ip"],
    "limit": 10
}
```

> 注：示例时间戳按 2026-07-05 当前时间 - 7 天计算：2026-06-28 00:00:00 UTC ≈ 1782864000（秒级），2026-07-05 00:00:00 UTC ≈ 1783473600（秒级）。

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "ip": "192.168.1.1",
                "value": 25
            },
            {
                "ip": "10.0.0.1",
                "value": 18
            },
            {
                "ip": "8.8.8.8",
                "value": 12
            }
        ]
    }
}
```

### 示例2：按源IP国家聚合统计

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["srcIpInfos.countryName"],
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
            {
                "countryName": "中国",
                "value": 150
            },
            {
                "countryName": "美国",
                "value": 80
            }
        ]
    }
}
```

### 示例3：按目的IP聚合并按告警等级过滤

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["dstIpInfos.ip"],
    "filterParam": {
        "severities": [3, 4]
    },
    "limit": 10
}
```

### 示例4：按源IP聚合并按访问方向过滤

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["srcIpInfos.ip"],
    "filterParam": {
        "accessDirections": [2]
    },
    "limit": 10
}
```

**说明**：accessDirections=[2] 表示只统计外对内方向的告警。

### 示例5：按目的资产聚合并按资产组过滤

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["dstIpInfos.assetId"],
    "filterParam": {
        "hostBranchIds": [1, 2]
    },
    "limit": 50
}
```

### 示例6：按目的IP国家+省份聚合

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["dstIpInfos.countryName", "dstIpInfos.provinceName"],
    "limit": 100
}
```

**说明**：多字段聚合时，返回的 item 中同时包含 countryName 和 provinceName 字段。

### 示例7：错误响应示例 - timeField 值无效

**请求示例**（无效参数）：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "invalidField",
    "aggBy": ["srcIpInfos.ip"],
    "limit": 10
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param timeField is invalid value. ",
    "data": null
}
```

### 示例8：aggBy 字段不合法时返回空列表

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "lastTime",
    "aggBy": ["invalidField"],
    "limit": 10
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": []
    }
}
```

**说明**：aggBy 字段不合法时不报错，返回空 item 列表。

### 示例9：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **必填字段**
   - startTimestamp、endTimestamp、timeField、aggBy、limit 均为必填（@NotNull）
   - 任一缺失会校验失败

2. **aggBy 字段限制**
   - 字段需以 `srcIpInfos.` 或 `dstIpInfos.` 为前缀
   - 移除前缀后必须是 IpInfo 类的字段
   - 字段不合法时返回空列表（不报错）

3. **timeField 枚举校验**
   - 必须为 AlertTimeFieldTypeEnum 枚举值
   - 其他值会校验失败

4. **时间范围**
   - 时间戳为秒级（10 位 Long）
   - 不指定时间范围时默认取最近 7 天

### 参数依赖关系

- aggBy 字段前缀规则：以 "s" 开头用 srcIpInfos.，否则用 dstIpInfos.
- filterParam 与 aggBy 配合使用，filterParam 过滤告警范围，aggBy 指定聚合维度
- limit 控制返回的聚合桶数量

### 权限要求

- 需要 `superAdmin` 或 `alertQuery` 权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.alerts.trends.log"）

### 性能建议

1. **合理设置时间范围**
   - 时间范围过大可能导致 ES 聚合性能下降
   - 建议单次查询时间范围不超过 30 天

2. **合理设置 limit**
   - limit 越大返回数据量越大，建议日常使用 10~50
   - 报表场景可适当放大到 100~500

3. **aggBy 字段选择**
   - 单字段聚合性能优于多字段聚合
   - 多字段聚合时建议不超过 2 个字段

### 数据一致性说明

1. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 本接口仅入参为时间戳，返回数据无时间戳字段

2. **JSON 字段名**
   - 所有 QO 和 VO 字段使用 @JsonProperty 注解指定 JSON 字段名
   - filterParam 字段名：accessDirections、hostBranchIds、hostGroupIds、severities、whiteStatus、devUids、alarmClassifications、platformIds、platformHostBranchIds、platformHostBusinessIds、attackResults、dstIpClassify1Ids、srcIps
   - VO 字段名：item、ip、assetId、value、branchId、classifyId、classify1Id、provinceName、countryName

3. **空值序列化**
   - VO 中 null 字段不序列化（@JsonInclude(NON_NULL)）
   - 实际返回字段根据 aggBy 选择确定

4. **aggBy 前缀规则**
   - 字段名以 "s" 开头（如 srcIp、srcIpInfos）使用 `srcIpInfos.` 前缀
   - 其他字段使用 `dstIpInfos.` 前缀
   - 校验失败时返回空列表，不抛异常

5. **数据来源**
   - 数据来源于 ES 告警表（通过 alertDao.getAlertIpInfosResult）
   - aggBy 字段对应 ES 嵌套文档字段（srcIpInfos.xxx / dstIpInfos.xxx）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | must not be null | startTimestamp/endTimestamp/timeField/aggBy/limit 任一为 null | 提供所有必填字段 |
| 400 | param timeField is invalid value. | timeField 值不在 AlertTimeFieldTypeEnum 枚举中 | 使用 firstTime/lastTime/updateTime/dealTime/occurTime/uploadTime/_insertTime |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端查询执行异常（如 ES 连接失败） | 联系技术支持，检查 ES 集群状态 |

## 最佳实践

1. **首次使用建议**
   - 先用 srcIpInfos.ip 单字段聚合 + limit=10 测试接口
   - 确认返回数据格式和字段含义后再扩大查询范围

2. **aggBy 字段选择**
   - 攻击源分析：srcIpInfos.ip、srcIpInfos.countryName、srcIpInfos.provinceName
   - 受攻击资产分析：dstIpInfos.ip、dstIpInfos.assetId、dstIpInfos.branchId
   - 资产类型分析：dstIpInfos.classify1Id、dstIpInfos.classifyId

3. **过滤条件配合**
   - 使用 filterParam 缩小告警范围，提升聚合结果准确性
   - 常用过滤维度：severities（告警等级）、accessDirections（访问方向）、hostBranchIds（资产组）

4. **配合告警列表使用**
   - 聚合获取高频 IP 后，调用 `/alerts/list` 按 srcIps 过滤获取详细告警
   - 配合 `/alerts/ipinfosstats` 接口进行双维度聚合分析

5. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功
   - aggBy 字段不合法时返回空列表，需检查字段前缀和名称
   - 500 错误建议短暂间隔后重试

6. **limit 设置**
   - 日常统计使用 limit=10~50
   - 全量分析场景使用 limit=100~500
   - limit 过大可能影响响应性能
