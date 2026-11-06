# POST /api/xdr/v1/incidents/reject

## 接口概述

本接口用于 MSS 通过 OpenAPI 驳回或忽略事件（分布式专用），将驳回消息发送到 Pulsar 队列异步处理，支撑 MSS 与 XDR 之间的事件驳回/忽略协同场景。通过本接口，您可以操作以下内容：

### 可操作的驳回信息
- **租户与平台信息**：客户ID（companyId）、平台（platform）、平台类型（platformType）、平台设备ID（platformDevId）
- **资产信息**：资产组ID（branchId）、资产组类型（branchType）
- **消息信息**：消息ID（msgId）
- **驳回数据**：驳回数据列表（data），每项含数据类型（dataType）、事件ID（id）、描述（desc）、操作类型（optType）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | MSS 事件驳回操作 |
| 前置依赖 | 需先调用 `/incidents/list` 获取事件 uuId；分布式 MSS 部署场景 |
| 关联接口 | `/incidents/list` 事件列表 mss 确认消息 |

## 使用场景

1. **MSS 驳回事件**：MSS 服务将误报或不需要处理的事件驳回 XDR
2. **MSS 忽略事件**：MSS 服务将事件标记为忽略
3. **多平台协同**：分布式部署场景下，MSS 与多个 XDR 平台之间的事件驳回协同
4. **驳回回执**：MSS 驳回后将结果同步回 XDR，XDR 侧据此调整事件状态

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/reject |
| Content-Type | application/json |
| 权限要求 | superAdmin、incidentQuery 或 mssEdit（三选一） |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `RejectIncidentQo` 并校验（@Validated）
2. 调用 `openApiIncidentService.rejectIncident(rejectIncidentQo)`
3. Service 内部：
   - 校验租户上下文：从 `TenantInfoContext` 获取 projectId，为空返回失败
   - 构造 `RejectIncidentKafkaDto`：
     - timestamp ← `System.currentTimeMillis() / 1000`（秒级）
     - sender ← "MSS"
     - tenant ← projectId
     - data ← rejectIncidentQo.data
     - msgId ← rejectIncidentQo.msgId
     - companyId ← rejectIncidentQo.companyId
     - platform ← rejectIncidentQo.platform
   - 获取 Pulsar Producer Manager，为空返回失败
   - 将 DTO 序列化为 JSON，通过 `manager.sendMessageByProducer(xdrStatusSyncTopic, msg)` 发送到 `xdrStatusSyncTopic` topic
   - 返回 `OpenApiResponse.ok()`
4. 若发送异常，捕获并返回失败响应

### 数据转换逻辑
- `RejectIncidentQo` → `RejectIncidentKafkaDto`：手动构造，timestamp 取当前秒级时间戳
- data 字段（List<RejectData>）按原样透传到 Kafka/Pulsar 消息

### 默认行为
- timestamp 由服务端生成（`System.currentTimeMillis() / 1000`），不来自入参
- sender 固定为 "MSS"

### 特殊规则
- `companyId` 必填（@NotNull），需符合 `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS` 正则（不允许特殊字符）
- `platform` 可选，需符合 `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS` 正则
- `platformType` 可选，需符合 `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS` 正则
- `data` 必填（@NotEmpty），每项 RejectData 含：
  - `dataType` 必填（@NotNull）
  - `id` 必填（@NotNull），需符合 `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS` 正则
  - `desc` 必填（@NotNull）
  - `optType` 必填（@NotNull）
- 权限要求：`superAdmin`、`incidentQuery`、`mssEdit` 三选一（比其他接口多 mssEdit 选项）
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.reject.incidents.log"）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| branchId | integer | 否 | - | 资产组ID | 101 |
| branchType | integer | 否 | - | 资产组类型 | 1 |
| msgId | string | 否 | - | 消息ID | "msg-001" |
| companyId | string | 是 | - | 客户ID，不允许特殊字符 | "123456" |
| platform | string | 否 | - | 平台，不允许特殊字符 | "platform_001" |
| platformType | string | 否 | - | 平台类型，不允许特殊字符 | "saas" |
| platformDevId | integer | 否 | - | 平台设备ID | 1 |
| data | array[RejectData] | 是 | - | 驳回数据列表，不能为空 | 见下方 |

**RejectData 结构说明**（来源：RejectIncidentQo.RejectData）：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| dataType | integer | 是 | 数据类型 | 1 |
| id | string | 是 | 事件ID，不允许特殊字符 | "incident-001" |
| desc | string | 是 | 描述 | "误报驳回" |
| optType | integer | 是 | 操作类型 | 1 |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（成功时为 null） |

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": null
}
```

## 调用示例

### 示例1：MSS 驳回单个事件

**请求示例**：
```json
{
    "companyId": "123456",
    "platform": "platform_001",
    "msgId": "msg-001",
    "data": [
        {
            "dataType": 1,
            "id": "incident-001",
            "desc": "误报驳回",
            "optType": 1
        }
    ]
}
```

### 示例2：MSS 批量驳回多个事件

**请求示例**：
```json
{
    "companyId": "123456",
    "data": [
        {
            "dataType": 1,
            "id": "incident-001",
            "desc": "误报驳回",
            "optType": 1
        },
        {
            "dataType": 1,
            "id": "incident-002",
            "desc": "已处置",
            "optType": 2
        }
    ]
}
```

### 示例3：错误响应 - companyId 为空

**请求示例**：
```json
{
    "data": [
        {"dataType": 1, "id": "incident-001", "desc": "误报", "optType": 1}
    ]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param companyId illegal",
    "data": null
}
```

### 示例4：错误响应 - data 为空

**请求示例**：
```json
{
    "companyId": "123456",
    "data": []
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "data cannot be empty",
    "data": null
}
```

### 示例5：错误响应 - 租户上下文为空

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "rejectIncident projectId is failed!",
    "data": null
}
```

### 示例6：错误响应 - Pulsar 发送失败

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "send msg to pulsar failed!",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `companyId` 必填，不允许特殊字符（@Pattern `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS`）
- `data` 必填，不能为空（@NotEmpty）
- 每个 RejectData 中 `dataType`/`id`/`desc`/`optType` 必填
- `id` 不允许特殊字符
- `platform`/`platformType` 可选但若传则不允许特殊字符

### 参数依赖关系
- `data.id` 应为 XDR 中存在的有效事件ID（来自 `/incidents/list`）
- `msgId` 应保证唯一，便于消息追踪
- `platform`/`platformType`/`platformDevId` 用于多平台分布式场景

### 权限要求
- 需要 `superAdmin`、`incidentQuery` 或 `mssEdit` 权限（三选一，比其他接口多 mssEdit 选项）
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.reject.incidents.log"）

### 使用注意事项
- **分布式专用**：本接口为分布式 MSS 部署场景专用，单机部署可能不适用
- **异步处理**：消息写入 Pulsar 队列后立即返回成功，实际处理异步进行
- **timestamp 服务端生成**：消息中的 timestamp 由服务端取 `System.currentTimeMillis() / 1000` 生成，不来自入参
- **sender 固定 MSS**：消息中 sender 固定为 "MSS"，不来自入参
- **特殊字符限制**：companyId/platform/platformType/id 不允许特殊字符，调用方需注意

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无返回时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 消息中 timestamp 由服务端取 `System.currentTimeMillis() / 1000` 生成（秒级）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param companyId illegal | companyId 为空或含特殊字符 | 传入合法的 companyId |
| 400 | param platform illegal | platform 含特殊字符 | 使用合法字符 |
| 400 | param platformType illegal | platformType 含特殊字符 | 使用合法字符 |
| 400 | param id illegal | RejectData.id 含特殊字符 | 使用合法字符 |
| 400 | data cannot be empty | data 为空 | 传入非空 data 列表 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin/incidentQuery/mssEdit 权限 |
| 500 | rejectIncident projectId is failed! | 租户上下文 projectId 为空 | 检查租户上下文配置 |
| 500 | send msg to pulsar failed! | Pulsar 发送失败 | 联系技术支持，检查 Pulsar 状态 |
| 500 | pulsar init fail, cannot find pulsarProducerManager bean | Pulsar Producer 未初始化 | 联系技术支持 |

## 最佳实践

1. **msgId 唯一**：msgId 使用 UUID 或时间戳+序列号，保证唯一性便于追踪
2. **data.id 有效性**：调用前确认 data.id 在 XDR 中存在（通过 `/incidents/list` 验证），避免无效驳回
3. **批量驳回**：单次 data 列表可含多个 RejectData，批量驳回提高效率
4. **desc 完整**：desc 字段建议完整描述驳回原因，便于审计追溯
5. **mssEdit 权限**：MSS 服务账号建议授权 mssEdit 权限，避免依赖 superAdmin
6. **Pulsar 健康检查**：500 错误多为 Pulsar 故障，建议重试机制 + 告警
