# POST /api/xdr/v1/incidents/dealstatus/list

## 接口概述

本接口用于根据安全事件ID列表批量查询事件当前的处置状态，支撑事件状态同步、批量校验与状态展示场景。通过本接口，您可以获取/操作以下内容：

### 可查询的处置状态信息
- **事件标识**：事件ID（uuId）
- **处置状态**：处置状态（dealStatus，整数编码，对应 IncidentDealStatusEnum：1-待处置、2-处置中、3-处置完成、4-挂起、5-已忽略、6-已遏制）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件处置状态查询 |
| 前置依赖 | 需先调用 `/incidents/list` 获取事件 uuId |
| 关联接口 | `/incidents/list` 事件列表、`/incidents/dealstatus/count` 处置状态数量统计 |

## 使用场景

1. **状态同步**：将 XDR 事件处置状态同步至外部系统（如工单系统、SIEM）
2. **批量校验**：批量处置前校验事件当前状态，避免重复处置
3. **状态展示**：在第三方大屏/报表中展示事件当前处置状态
5. **状态变更监控**：定期查询事件状态，监控状态变化

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/dealstatus/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 `uuIds` 列表（直接 `@RequestBody`，非 QO 类包裹）并校验
   - `@NotNull` 校验非空
   - `@Size(max = 1000)` 校验最多 1000 个元素
   - `@StrCollectionValidate(regexp = UUID_CHAR_PARTTERN)` 校验每个元素符合 UUID 格式
2. 调用 `openApiIncidentService.queryDealStatusByIds(uuIds)`
3. Service 内部：
   - 调用 `incidentDao.findDealStatusByIds(ids)` 从 MongoDB 批量查询事件处置状态
   - 若查询结果为空，返回空 `IncidentEntityResult`（item 为 null）
   - 遍历查询结果，对每个 `Incident` 构造 `OpenApiDealStatusVo(uuId, dealStatus)`
   - 返回 `OpenApiResponse<IncidentEntityResult<OpenApiDealStatusVo>>`
4. Controller 返回标准 OpenApiResponse

### 数据转换逻辑
- `Incident` → `OpenApiDealStatusVo`：通过构造器 `new OpenApiDealStatusVo(incident.getUuId(), incident.getDealStatus())` 仅取 uuId 与 dealStatus 两个字段
- dealStatus 为 Integer，对应内部 `IncidentDealStatusEnum`（1-6），非 TMG 状态码

### 默认行为
- 无分页参数，单次返回所有匹配事件的状态
- 无匹配事件时返回空 `IncidentEntityResult`（item 为 null）

### 特殊规则
- `uuIds` 列表最多 1000 个元素（@Size(max=1000)），每个元素必须符合 `UUID_CHAR_PARTTERN` 正则
- 返回的 dealStatus 是内部 `IncidentDealStatusEnum` 状态码（1-6），不是 TMG 状态码（0/10/20/30/40/50/60/70/80）
- 返回结构 `IncidentEntityResult` 只有 `item` 字段，无分页元数据

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

> 注意：本接口请求体直接为 `List<String>`（uuIds 列表），非 QO 类包裹的 JSON 对象。

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| (root) | array[string] | 是 | - | 安全事件ID列表，最多 1000 个元素，每个元素需符合 UUID_CHAR_PARTTERN 正则 | ["abc123", "def456"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明（来源：IncidentEntityResult<OpenApiDealStatusVo>）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[OpenApiDealStatusVo] | 处置状态列表 |

### item 元素结构说明（来源：OpenApiDealStatusVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| uuId | string | 告警事件ID | - | "incident-001" |
| dealStatus | integer | 处置状态 | IncidentDealStatusEnum，参考 enum-dictionary.md。1-待处置, 2-处置中, 3-处置完成, 4-挂起, 5-已忽略, 6-已遏制 | 3 |

**IncidentDealStatusEnum 处置状态对照表**（参考 enum-dictionary.md）：

| 值 | 枚举常量名 | 国际化值（中文） | ifTreated |
|----|-----------|------------------|-----------|
| 1 | PENDING | 待处置 | false |
| 2 | DISPOSING | 处置中 | false |
| 3 | DISPOSED | 处置完成 | true |
| 4 | HANGUP | 挂起 | false |
| 5 | IGNORED | 已忽略 | true |
| 6 | SUPPRESS | 已遏制 | true |

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "uuId": "incident-001",
                "dealStatus": 3
            },
            {
                "uuId": "incident-002",
                "dealStatus": 1
            }
        ]
    }
}
```

## 调用示例

### 示例1：批量查询事件处置状态

**请求示例**：
```json
["incident-001", "incident-002", "incident-003"]
```

### 示例2：查询单个事件处置状态

**请求示例**：
```json
["incident-001"]
```

### 示例3：错误响应 - uuIds 为空

**请求示例**：
```json
[]
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "uuIds cannot be null",
    "data": null
}
```

### 示例4：错误响应 - uuId 格式不合法

**请求示例**：
```json
["!!!invalid"]
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "uuId format invalid",
    "data": null
}
```

### 示例5：错误响应 - uuIds 超过 1000

**请求示例**：
```json
["id1", "id2", "...", "id1001"]
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "uuIds size exceeds 1000",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- `uuIds` 列表最多 1000 个元素（@Size(max=1000)）
- 每个 uuId 元素必须符合 `UUID_CHAR_PARTTERN` 正则校验
- 请求体直接为 `List<String>`（JSON 数组），非 QO 类包裹的 JSON 对象

### 参数依赖关系
- `uuIds` 中的元素应来自 `/incidents/list` 接口返回的 uuId
- 查询不到的事件不会出现在返回结果中（返回结果只含匹配的事件）

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.get.incidents.dealStatus.log"）

### 性能建议
- 单次查询建议不超过 100 个 uuId，避免单次查询压力过大
- 1000 上限为硬限制，超界直接返回 400

### 使用注意事项
- **dealStatus 是内部状态码**：返回值是 `IncidentDealStatusEnum`（1-6），不是 TMG 状态码（0/10/20/30/40/50/60/70/80）态码，二者需区分
- **未匹配事件无提示**：查询不到的事件不会出现在结果中，也不会报错；客户端需自行对比 uuIds 列表与返回结果识别缺失项

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
- 返回结构 `IncidentEntityResult` 不含分页元数据

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | uuIds cannot be null | uuIds 为 null 或空 | 传入非空列表 |
| 400 | uuIds size exceeds 1000 | uuIds 元素超过 1000 | 控制元素数量在 1000 以内 |
| 400 | uuId format invalid | uuId 不符合 UUID_CHAR_PARTTERN 正则 | 使用合法的 uuId（来自 `/incidents/list`） |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | internal error | 服务端异常 | 联系技术支持 |

## 最佳实践

1. **先列事件再查状态**：先调用 `/incidents/list` 拿到 uuId，再调本接口查状态
2. **状态码区分**：注意本接口返回的是内部状态码（1-6），（处置状态更新接口未开放）
3. **批量分批**：单批 100 个以内，避免单次查询压力过大
4. **缺失项识别**：客户端对比传入 uuIds 与返回 item 的 uuId，识别缺失项（可能已被删除或租户不匹配）

