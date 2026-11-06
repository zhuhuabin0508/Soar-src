# POST /api/xdr/v1/alerts/disposition/dns

## 接口概述

本接口用于分页查询DNS威胁实体（处置响应实体）列表，支持按时间范围、事件ID、威胁情报标签过滤，返回DNS威胁实体的处置详情（含告警关联、威胁分类、处置建议、操作策略等）。通过本接口，您可以获取以下内容：

### 可查询的DNS威胁实体信息
- **基础标识**：事件ID（eventId）、告警ID列表（alertIds）、DNS名（dnsName）、告警角色（alertRole）
- **时间信息**：插入时间（insertTime）、更新时间（updateTime）
- **威胁信息**：威胁分类（threatCategory）、威胁级别（threatClass）、威胁情报标签（intelligenceTag）
- **处置信息**：状态（status）、处置建议（dealSuggestion）、业务影响（businessAffection）、操作描述（operationDescription）、操作策略（operationPolicy）、响应动作类型（responseActionType）
- **平台信息**：平台ID（platformId）、区域ID（regionId）、节点ID（nodeId）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 威胁实体查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询（通过 alertIds 关联） |

## 使用场景

1. **DNS威胁实体清单**：分页查询DNS维度的威胁处置实体列表，用于威胁运营中心展示
2. **事件关联查询**：通过 eventIds 过滤特定事件下的DNS威胁实体，用于事件调查
3. **威胁情报标签筛选**：通过 intelligenceTags 过滤特定威胁情报标签的DNS实体，用于情报驱动调查
4. **处置历史审计**：按时间范围查询DNS处置记录，审计处置操作和策略
5. **配合告警接口使用**：获取DNS实体关联的 alertIds 后，调用 `/alerts/list` 获取告警详情

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/disposition/dns |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 page ≥ 1（默认 1）
   - 校验 pageSize 取值范围 5~200（默认 5）
   - 校验 eventIds 元素数量 ≤ 200，每个元素符合 UUID 格式（UUID_CHAR_PARTTERN）
   - 校验 timeField 取值范围 insertTime 或 updateTime（默认 insertTime）
2. **时间范围补全**：Controller 层通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理 startTimestamp/endTimestamp 空值（默认补全为最近 7 天）
3. **查询原始数据**：调用 `responseDispositionDao.queryDispositionDnsList(qo)` 查询 ResponseDisposition 实体，返回 DnsDispositionDto（含 total 和数据列表）
4. **构造分页对象**：创建 OpenApiPageResult，设置 page、pageSize、total
5. **空列表安全处理**：使用 `Optional.ofNullable(dto.getResponseDispositionDataList()).orElse(List.of())` 防止返回 null
6. **映射 VO**：遍历 ResponseDisposition 列表，逐字段映射到 OpenApiDispositionDnsListVo：
   - 直接映射字段：eventId、alertIds、businessAffection、dealSuggestion、insertTime、updateTime、operationDescription、status、threatCategory、threatClass、operationPolicy、responseActionType、platformId、regionId
   - 嵌套字段映射：从 `r.getOperationTarget().getNodeInfo()` 提取 nodeId、dnsName、alertRole、intelligenceTag
   - intelligenceTag 为空时返回空列表（不返回 null）
7. **封装结果返回**：将 VO 列表设置到 pageResult.item，封装到 OpenApiResponse 返回

### 数据转换逻辑

- 数据来源：ResponseDisposition 实体（处置响应表，存储于 MongoDB）
- 直接字段映射：ResponseDisposition 字段名与 VO 字段名一致的字段直接 setter 拷贝
- 嵌套结构展开：ResponseDisposition.operationTarget.nodeInfo 嵌套结构展开到 VO 顶层字段（nodeId、dnsName、alertRole、intelligenceTag）
- 空值保护：operationTarget 或 nodeInfo 为 null 时，对应嵌套字段不设置（保持默认 null）；intelligenceTag 为 null 时转为空列表

### 默认行为

- page 默认 1，pageSize 默认 5
- timeField 默认 insertTime（按插入时间过滤）
- startTimestamp/endTimestamp 未指定时，Controller 层自动补全为最近 7 天
- intelligenceTags 默认空列表（不按威胁情报标签过滤）
- eventIds 默认 null（不按事件ID过滤）
- 查询结果为空时返回空 item 列表（不返回 null）

### 特殊规则

- timeField 必须为 insertTime 或 updateTime，其他值会校验失败
- eventIds 元素必须符合 UUID 格式正则（UUID_CHAR_PARTTERN），最多 200 个元素
- pageSize 上限 200，超过会校验失败
- 嵌套字段 intelligenceTag 为 null 时映射为空列表，避免前端 null 处理

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| page | integer | 否 | 1 | 页码，最小值 1 | 1 |
| pageSize | integer | 否 | 5 | 每页大小，取值范围 5~200 | 20 |
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long）。未指定时默认取最近 7 天 | 1782864000 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long）。未指定时默认取今天结束时间 | 1783473600 |
| timeField | string | 否 | insertTime | 时间字段，指定时间范围查询依据的时间字段。可选值：insertTime、updateTime | "insertTime" |
| eventIds | array[string] | 否 | - | 事件ID列表，最多 200 个元素，每个元素必须符合 UUID 格式（正则：UUID_CHAR_PARTTERN） | ["evt-123", "evt-456"] |
| intelligenceTags | array[string] | 否 | [] | 威胁情报标签列表，用于按标签过滤DNS威胁实体 | ["C2", "Malware"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，见下方 data 结构说明 |

### data 结构说明（来源：OpenApiPageResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | long | 满足条件的总记录数 |
| page | integer | 当前页码 |
| pageSize | integer | 每页大小 |
| item | array[OpenApiDispositionDnsListVo] | DNS威胁实体记录列表，见下方 item 元素结构说明 |

### item 元素结构说明（来源：OpenApiDispositionDnsListVo）

#### 基础标识信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| eventId | string | 事件ID | - | "evt-123456" |
| alertIds | array[string] | 告警ID列表，关联到告警接口的 uuId | - | ["alert-001", "alert-002"] |
| dnsName | string | DNS名（来源 ResponseDisposition.operationTarget.nodeInfo.dnsName） | - | "malicious.example.com" |
| alertRole | string | 告警角色（来源嵌套 nodeInfo） | - | "src" |

#### 时间信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| insertTime | long | 插入时间（秒级时间戳，10 位 Long） | - | 1782864000 |
| updateTime | long | 最新一次更新时间（秒级时间戳，10 位 Long） | - | 1783473600 |

#### 威胁信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| threatCategory | string | 威胁分类 | - | "C2通信" |
| threatClass | string | 威胁级别 | - | "high" |
| intelligenceTag | array[string] | 威胁情报标签列表（来源嵌套 nodeInfo，为空时返回空列表） | - | ["C2", "Botnet"] |

#### 处置信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| status | string | 状态 | - | "disposed" |
| dealSuggestion | string | 处置建议 | - | "封锁该域名" |
| businessAffection | string | 业务影响 | - | "影响生产业务" |
| operationDescription | string | 操作描述 | - | "已添加黑名单" |
| operationPolicy | integer | 操作策略 | - | 1 |
| responseActionType | integer | 响应动作类型 | - | 2 |

#### 平台信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| platformId | string | 平台ID | - | "platform_001" |
| regionId | string | 区域ID | - | "region_east" |
| nodeId | string | 节点ID（来源嵌套 operationTarget.nodeId） | - | "node_123" |

## 调用示例

### 示例1：查询最近 7 天的 DNS 威胁实体列表

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "page": 1,
    "pageSize": 20
}
```

> 注：示例时间戳按 2026-07-05 当前时间 - 7 天计算：2026-06-28 00:00:00 UTC ≈ 1782864000（秒级），2026-07-05 00:00:00 UTC ≈ 1783473600（秒级）。

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 35,
        "page": 1,
        "pageSize": 20,
        "item": [
            {
                "eventId": "evt-123456",
                "alertIds": ["alert-001", "alert-002"],
                "businessAffection": "影响生产业务",
                "dealSuggestion": "封锁该域名",
                "insertTime": 1751400000,
                "updateTime": 1751500000,
                "operationDescription": "已添加黑名单",
                "status": "disposed",
                "threatCategory": "C2通信",
                "threatClass": "high",
                "operationPolicy": 1,
                "responseActionType": 2,
                "platformId": "platform_001",
                "regionId": "region_east",
                "nodeId": "node_123",
                "dnsName": "malicious.example.com",
                "intelligenceTag": ["C2", "Botnet"],
                "alertRole": "src"
            }
        ]
    }
}
```

### 示例2：按事件ID精确查询

**请求示例**：
```json
{
    "eventIds": ["evt-123456", "evt-789012"],
    "page": 1,
    "pageSize": 20
}
```

### 示例3：按威胁情报标签过滤

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "intelligenceTags": ["C2", "Botnet"],
    "page": 1,
    "pageSize": 50
}
```

### 示例4：按更新时间查询

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "updateTime",
    "page": 1,
    "pageSize": 20
}
```

**说明**：使用 timeField=updateTime 指定按更新时间进行范围查询，可获取近期有处置状态变更的实体。

### 示例5：使用默认参数（不传任何参数）

**请求示例**：
```json
{}
```

**说明**：使用全默认参数时，page=1、pageSize=5、timeField=insertTime，时间范围自动补全为最近 7 天。

### 示例6：错误响应示例 - pageSize 超过 200

**请求示例**（无效参数）：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
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

### 示例7：错误响应示例 - timeField 值无效

**请求示例**（无效参数）：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "createTime"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "Invalid timeField value. Use 'insertTime' or 'updateTime'.",
    "data": null
}
```

### 示例8：错误响应示例 - eventIds 元素超过 200 个

**请求示例**（无效参数）：
```json
{
    "eventIds": ["evt-001", "evt-002", "... 共 201 个元素 ..."]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param eventIds max size is 200",
    "data": null
}
```

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

1. **分页限制**
   - page 最小值 1
   - pageSize 取值范围 5~200

2. **eventIds 限制**
   - 最多 200 个元素
   - 每个元素必须符合 UUID 格式规范（正则：UUID_CHAR_PARTTERN）
   - 元素不能为空白字符串（@NotBlank）

3. **timeField 限制**
   - 仅支持 insertTime 或 updateTime 两个值
   - 其他值会校验失败

4. **时间范围**
   - 时间戳为秒级（10 位 Long）
   - 不指定时间范围时默认取最近 7 天
   - endTimestamp 未指定时默认取今天结束时间

### 参数依赖关系

1. **timeField 与时间戳配合**
   - timeField=insertTime（默认）：按插入时间过滤，startTimestamp/endTimestamp 用于 insertTime 字段
   - timeField=updateTime：按更新时间过滤，startTimestamp/endTimestamp 用于 updateTime 字段

2. **eventIds 与时间范围**
   - 同时指定 eventIds 和时间范围时，两者为 AND 关系
   - 仅指定 eventIds 时，时间范围可省略（默认最近 7 天）

3. **intelligenceTags 与其他过滤条件**
   - intelligenceTags 与时间范围、eventIds 等条件为 AND 关系
   - intelligenceTags 为空数组时表示不按标签过滤

### 权限要求

- 需要 `superAdmin` 或 `alertQuery` 权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.DispositionDns.List.log"）

### 性能建议

1. **合理设置时间范围**
   - 时间范围过大可能导致查询超时
   - 建议单次查询时间范围不超过 30 天

2. **合理设置分页大小**
   - pageSize 不建议设置为最大值 200，通常 20~50 为宜
   - 大量数据返回可能导致响应延迟

3. **使用 eventIds 精确查询**
   - 已知事件ID时优先使用 eventIds 精确查询，性能优于纯时间范围查询

4. **避免过多过滤条件**
   - 过滤条件越多，查询复杂度越高
   - 合理组合过滤条件，避免冗余

### 数据一致性说明

1. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 返回的 insertTime、updateTime 为秒级时间戳

2. **嵌套字段映射**
   - dnsName、alertRole、intelligenceTag 三个字段来源于 ResponseDisposition 嵌套结构 operationTarget.nodeInfo
   - 当 operationTarget 或 nodeInfo 为 null 时，对应字段不设置（保持默认 null）
   - intelligenceTag 为 null 时映射为空列表，避免前端处理 null

3. **字段命名**
   - 入参字段名为小驼峰（如 startTimestamp、timeField、intelligenceTags）
   - 返回字段名为小驼峰（如 eventId、alertIds、dnsName）

4. **数据来源**
   - 数据来源于 MongoDB 的 ResponseDisposition 集合（处置响应表）
   - 处置记录在调用处置接口时由系统写入

5. **空值处理**
   - 查询结果为空时返回空 item 列表（不返回 null）
   - intelligenceTag 为 null 时返回空列表（不返回 null）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param page min size is 1 | page 参数小于 1 | 设置 page >= 1 |
| 400 | param pageSize min is 5 | pageSize 参数小于 5 | 设置 pageSize >= 5 |
| 400 | param pageSize max is 200 | pageSize 参数大于 200 | 设置 pageSize <= 200 |
| 400 | param eventIds max size is 200 | eventIds 元素超过 200 个 | 减少 eventIds 元素数量 |
| 400 | Invalid timeField value. Use 'insertTime' or 'updateTime'. | timeField 值无效 | 使用 insertTime 或 updateTime |
| 400 | must match "UUID_CHAR_PARTTERN" | eventIds 元素格式不符合 UUID 规范 | 使用符合 UUID 格式的字符串 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端查询执行异常（如 MongoDB 连接失败） | 联系技术支持，检查 MongoDB 状态 |

## 最佳实践

1. **首次使用建议**
   - 先使用小范围时间（如最近 1 天）和小分页（pageSize=5）测试接口
   - 确认返回数据格式和字段含义后再扩大查询范围

2. **配合告警接口使用**
   - 获取 DNS 实体后，通过 alertIds 调用 `/alerts/list` 获取关联告警明细
   

3. **时间字段选择**
   - 日常监控场景使用默认 insertTime（按插入时间查询新增实体）
   - 处置变更审计场景使用 updateTime（按更新时间查询近期变更的实体）

4. **分页策略**
   - 日常查询使用 pageSize=20~50
   - 全量数据导出场景使用 pageSize=200 并分批拉取

5. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功，其他为失败
   - 400 错误根据 message 字段定位具体参数问题
   - 403 错误需联系管理员添加权限
   - 500 错误建议短暂间隔后重试

6. **空值处理**
   - 前端处理时对 intelligenceTag 字段需做空列表兼容（接口已保证返回空列表而非 null）
   - 对 dnsName、alertRole 等嵌套字段需做 null 兼容
