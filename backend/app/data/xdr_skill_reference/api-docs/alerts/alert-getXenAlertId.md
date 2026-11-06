# POST /api/xdr/v1/alerts/getXenAlertId

## 接口概述

本接口用于根据实体信息（资产ID/源目的IP/XFF/DNS/MD5/外网IP）反向查询关联的告警UUID列表，支持6种实体类型，按类型路由到不同的查询逻辑（ES 或 MongoDB）。通过本接口，您可以获取以下内容：

### 可查询的关联告警信息
- **告警UUID列表**：与指定实体关联的告警 uuId 列表

### 支持的实体类型
- **type=0**：资产ID（assetIds）- 查询 ES 告警表
- **type=1**：源/目的IP（ips）- 查询 ES 告警表
- **type=2**：X-Forwarded-For（ips）- 查询 ES 告警表
- **type=3**：DNS（dnsNames）- 查询 MongoDB 处置响应表
- **type=4**：MD5（md5s）- 查询 MongoDB 处置响应表
- **type=5**：外网IP（ips）- 查询 MongoDB 处置响应表

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | XEN 实体-告警关联查询（反向） |
| 前置依赖 | 无（可直接调用，需具备相应权限） |

## 使用场景

1. **实体调查溯源**：在XEN实体调查页面，根据已知实体（IP/域名/MD5/资产ID）反向查询关联的告警列表，用于威胁狩猎
2. **资产影响分析**：根据资产ID查询该资产涉及的所有告警，评估资产受影响范围
3. **DNS/MD5 威胁关联**：根据恶意域名或文件MD5查询关联告警，识别威胁扩散范围
4. **XFF溯源**：根据 X-Forwarded-For 头中的真实IP查询关联告警，用于代理场景下的溯源
5. **配合告警详情使用**：本接口返回告警 uuId 列表后，可用于获取告警详情

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/getXenAlertId |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 type 必填（@NotNull）
   - startTime、endTime 为可选时间范围参数
   - ips/assetIds/dnsNames/md5s 根据 type 取对应字段
2. **限流控制**：Controller 层通过 `atomicCotRelateLimit` 进行限流（默认 5，配置项 `ngsoc.limit.cotRelate`）
   - 每次请求 decrement，执行完 increment
   - 剩余配额 < 0 时抛出 HttpStatus.TOO_MANY_REQUESTS (429) 异常
3. **路由查询逻辑**：根据 type 路由到不同的 DAO：
   - **type=0/1/2（资产ID/源目的IP/XFF）**：调用 `alertDao.getXenAlertIds(qo)`，查询 ES 告警表
   - **type=3/4/5（DNS/MD5/外网IP）**：调用 `responseDispositionDao.getXenAlertIds(qo)`，查询 MongoDB 处置响应表
   - **其他 type 值**：默认分支不做任何操作，返回空列表
4. **返回结果**：将查询到的 uuId 列表封装到 OpenApiResponse 返回

### 数据转换逻辑

- 数据来源：
  - type=0/1/2：ES 告警表（通过 alertDao.getXenAlertIds）
  - type=3/4/5：MongoDB ResponseDisposition 集合（通过 responseDispositionDao.getXenAlertIds）
- 返回字段：仅返回 uuId 字符串列表，无字段映射

### 默认行为

- 未识别的 type 值返回空列表
- startTime/endTime 为可选，未指定时由 DAO 层默认处理
- 限流配额耗尽时返回 429 错误

### 特殊规则

1. **限流控制**：通过 atomicCotRelateLimit 限制并发调用数（默认 5），防止关联查询过载
2. **路由分治**：ES 和 MongoDB 分别处理不同类型的实体查询，避免跨存储联合查询
3. **type 必填**：type 字段标注 @NotNull，未指定时校验失败
4. **无返回字段映射**：仅返回 uuId 字符串列表，无复杂 VO 结构

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| type | integer | 是 | - | 实体类型，必填（@NotNull）。取值范围：0/资产ID, 1/源目的IP, 2/XFF, 3/DNS, 4/MD5, 5/外网IP | 1 |
| ips | array[string] | 否 | - | IP列表。type=1（源目的IP）、type=2（XFF）、type=5（外网IP）时使用 | ["192.168.1.1"] |
| assetIds | array[long] | 否 | - | 资产ID列表。type=0（资产ID）时使用 | [1001, 1002] |
| dnsNames | array[string] | 否 | - | DNS名列表。type=3（DNS）时使用 | ["malicious.example.com"] |
| md5s | array[string] | 否 | - | MD5列表。type=4（MD5）时使用 | ["e90afc86c7b1ab55e9dffa631cef0821"] |
| startTime | long | 否 | - | 查询开始时间戳（秒级，10 位 Long）。可选参数 | 1782864000 |
| endTime | long | 否 | - | 查询结束时间戳（秒级，10 位 Long）。可选参数 | 1783473600 |

### type 枚举值说明（来源：QueryAlertIdEnum）

| 值 | 枚举常量名 | 说明 | 使用字段 | 数据源 |
|----|-----------|------|----------|--------|
| 0 | ASSET_ID | 根据资产id查询 | assetIds | ES 告警表 |
| 1 | SRC_DST_IP | 根据源和目的IP查询 | ips | ES 告警表 |
| 2 | XFF | 根据X-Forwarded-For查询 | ips | ES 告警表 |
| 3 | DNS | 根据处置实体域名查询 | dnsNames | MongoDB ResponseDisposition |
| 4 | MD5 | 根据处置实体md5查询 | md5s | MongoDB ResponseDisposition |
| 5 | IP | 根据处置实体外网IP查询 | ips | MongoDB ResponseDisposition |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | array[string] | 关联告警UUID列表 |

### data 结构说明

data 为字符串数组，每个元素为关联的告警 uuId。

## 调用示例

### 示例1：根据源/目的IP查询关联告警

**请求示例**：
```json
{
    "type": 1,
    "ips": ["192.168.1.1", "10.0.0.1"],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

> 注：示例时间戳按 2026-07-05 当前时间 - 7 天计算：2026-06-28 00:00:00 UTC ≈ 1782864000（秒级），2026-07-05 00:00:00 UTC ≈ 1783473600（秒级）。

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": [
        "alert-001",
        "alert-002",
        "alert-003"
    ]
}
```

### 示例2：根据资产ID查询关联告警

**请求示例**：
```json
{
    "type": 0,
    "assetIds": [1001, 1002],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

### 示例3：根据XFF查询关联告警

**请求示例**：
```json
{
    "type": 2,
    "ips": ["10.0.0.1"],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

### 示例4：根据DNS查询关联告警

**请求示例**：
```json
{
    "type": 3,
    "dnsNames": ["malicious.example.com"],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

### 示例5：根据MD5查询关联告警

**请求示例**：
```json
{
    "type": 4,
    "md5s": ["e90afc86c7b1ab55e9dffa631cef0821"],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

### 示例6：根据外网IP查询关联告警（处置实体维度）

**请求示例**：
```json
{
    "type": 5,
    "ips": ["8.8.8.8"],
    "startTime": 1782864000,
    "endTime": 1783473600
}
```

### 示例7：不指定时间范围查询

**请求示例**：
```json
{
    "type": 1,
    "ips": ["192.168.1.1"]
}
```

**说明**：startTime、endTime 为可选，不指定时由 DAO 层默认处理（可能为全量查询或默认时间范围）。

### 示例8：错误响应示例 - type 未指定

**请求示例**（无效参数）：
```json
{
    "ips": ["192.168.1.1"]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "type must not be null",
    "data": null
}
```

### 示例9：限流响应（HTTP 429）

**响应示例**（HTTP 状态码 429，响应体 `code` 为语义字符串）：
```json
{
    "code": "Unknown",
    "message": "Too Many Requests",
    "data": null
}
```

**说明**：并发调用超过限流配额（默认 5）时返回 **HTTP 429**，建议间隔后重试。注意：限流的 429 是 HTTP 状态码，响应体外层 `code` 仍为字符串（非整数 429）。

### 示例10：未识别的 type 值返回空列表

**请求示例**：
```json
{
    "type": 99,
    "ips": ["192.168.1.1"]
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": []
}
```

### 示例11：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **type 必填**
   - @NotNull 校验，未指定时返回 400 错误
   - 取值范围 0~5，其他值返回空列表

2. **实体字段与 type 对应**
   - type=0：必须提供 assetIds
   - type=1/2/5：必须提供 ips
   - type=3：必须提供 dnsNames
   - type=4：必须提供 md5s
   - 提供错误的字段不会报错，但查询结果为空

3. **时间范围**
   - startTime/endTime 为可选参数
   - 时间戳为秒级（10 位 Long）

### 参数依赖关系

- type 字段决定使用哪个实体字段和哪个数据源
- type 与实体字段必须对应，否则查询无结果
- startTime 与 endTime 配合使用

### 权限要求

- 需要 `superAdmin` 或 `alertQuery` 权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.xen.alerts.entity.log"）

### 性能建议

1. **限流控制**
   - 接口并发上限默认 5（配置项 ngsoc.limit.cotRelate）
   - 高并发场景建议前端做请求队列，避免 429 错误
   - 429 错误建议间隔 1~2 秒后重试

2. **时间范围优化**
   - 指定 startTime/endTime 可缩小查询范围，提升性能
   - 不指定时间范围时可能触发全量查询，性能较差

3. **批量实体查询**
   - ips/assetIds/dnsNames/md5s 支持数组，建议单次查询 10~50 个实体
   - 过多实体会增加查询压力

### 数据一致性说明

1. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 本接口仅入参为时间戳，返回数据无时间戳字段

2. **数据源分治**
   - type=0/1/2：查询 ES 告警表（alertDao.getXenAlertIds）
   - type=3/4/5：查询 MongoDB 处置响应表（responseDispositionDao.getXenAlertIds）
   - 不同数据源的查询性能和延迟可能不同

3. **限流配置**
   - 限流配额通过 `ngsoc.limit.cotRelate` 配置项控制（默认 5）
   - 高并发调用任一接口会占用同一配额

4. **type 路由规则**
   - type 转换为 QueryAlertIdEnum，按枚举值路由
   - 未识别的 type 值（getQueryAlertIdEnumByType 返回 null）触发 NPE，由 default 分支处理
   - default 分支不做任何操作，返回空列表

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | type must not be null | type 字段未指定 | 提供非 null 的 type 值（0~5） |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 429 | Too Many Requests | 并发调用超过限流配额（默认 5） | 间隔 1~2 秒后重试，或减少并发调用 |
| 500 | exception.method.execute | 服务端查询执行异常（如 ES/MongoDB 连接失败） | 联系技术支持，检查后端服务状态 |

## 最佳实践

1. **首次使用建议**
   - 先用已知实体的 type=1（源目的IP）测试接口
   - 验证权限配置是否正确
   - 确认限流配额是否满足业务需求

2. **配合告警详情使用**
   - 调用本接口获取关联告警 uuId 列表
   - 再根据返回的告警 uuId 列表获取告警详情

3. **type 与实体字段对应**
   - 严格按 type 取对应实体字段，避免提供错误字段导致空结果
   - type=0：assetIds；type=1/2/5：ips；type=3：dnsNames；type=4：md5s

4. **限流应对策略**
   - 高并发场景前端做请求队列，控制调用频率
   - 429 错误时退避重试（间隔 1~2 秒）
   - 与关联接口共享限流配额，需协调调用

5. **时间范围设置**
   - 已知告警时间范围时，传入 startTime/endTime 提升查询性能
   - 未知时间范围时可省略，但性能会下降

6. **XEN双向关联**
   - 反向：本接口根据实体查询关联告警ID

7. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功
   - 400 错误根据 message 字段定位参数问题
   - 429 错误需退避重试
   - 500 错误建议短暂间隔后重试
