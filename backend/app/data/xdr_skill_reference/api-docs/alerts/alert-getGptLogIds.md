# POST /api/xdr/v1/alerts/getGptLogIds

## 接口概述

本接口用于根据告警UUID列表批量获取告警关联的 GPT 日志ID（gptLogId），从告警的扩展引擎字段（engineExt）中提取 wafGPT 模块的日志ID，优先返回攻击成功日志ID，无攻击成功日志时返回最新日志ID。通过本接口，您可以获取以下内容：

### 可查询的告警GPT日志信息
- **告警标识**：告警UUID（uuId）、告警名称（name）
- **告警属性**：访问方向（direction）、检测引擎名称（engineName）、处置动作（dealAction）
- **GPT日志ID**：从 engineExt.wafGPT 提取的 gptLogId，用于关联 GPT 研判原始日志

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 告警GPT日志关联查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询（uuId 列表来源）、`/alerts/gptresult/type` GPT研判结论查询 |

## 使用场景

1. **GPT研判日志回溯**：根据告警ID获取 GPT 研判的原始日志ID，用于查看 GPT 研判依据和详细分析
2. **批量获取GPT日志ID**：一次性传入最多 1000 个告警 uuId，批量提取 GPT 日志ID，减少接口调用次数
3. **WAF攻击成功日志定位**：优先返回 wafGPT 模块的攻击成功日志ID（attackSuccessLogIds），用于定位 WAF 攻击成功事件
4. **配合告警列表使用**：调用 `/alerts/list` 获取告警 uuId 列表后，使用本接口批量提取 GPT 日志ID
5. **告警调查溯源**：获取 gptLogId 后，关联 GPT 研判日志系统查看 AI 研判的详细推理过程

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/getGptLogIds |
| Content-Type | application/json |
| 权限要求 | superAdmin、incidentQuery 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 uuIds 列表非空（@NotEmpty）
   - 校验 uuIds 列表大小 ≤ 1000（@Size(max=1000)）
   - 校验每个 uuId 元素非空（@NotBlank）且符合 UUID 格式正则（UUID_CHAR_PARTTERN）
   - 校验每个 uuId 元素长度 ≤ 255（@Size(max=255)）
2. **查询告警数据**：调用 `alertService.getHttpAlerts(ids)` 批量查询告警的 HTTP 类型数据（含 engineExt 字段）
   - 查询失败时抛出 IncidentRuntimeException
3. **遍历提取 GPT 日志ID**：对每个告警：
   - 调用 `extractGptLogId(alert.getEngineExt())` 提取 gptLogId
   - 若 gptLogId 为空字符串则跳过该告警（不加入返回列表）
   - 否则构造 GetGptLogIdsVo，设置 uuId、name、engineName、direction、gptLogId、dealAction 字段
4. **返回结果**：将构造好的 VO 列表直接返回（注意：返回类型为 List<GetGptLogIdsVo>，非 OpenApiResponse 包装）

### extractGptLogId 提取逻辑

1. 若 engineExt 为空字符串，直接返回空字符串
2. 将 engineExt JSON 反序列化为 `Map<String, EngineExt>`
3. 取 `wafGPT` 键对应的 EngineExt 对象
4. **优先取攻击成功日志ID**：取 `wafGpt.getAttackSuccessLogIds()`
5. **降级取最新日志ID**：若攻击成功日志ID列表为空，取 `wafGpt.getLogIds()`
6. 取列表的第一个元素作为 gptLogId 返回
7. 任一环节异常时记录日志并返回空字符串

### 数据转换逻辑

- 数据来源：通过 `alertService.getHttpAlerts` 查询 ES 中的 HTTP 类型告警
- engineExt 字段：JSON 字符串，包含多个引擎的扩展信息（如 wafGPT、其他引擎）
- 字段映射：Alert.uuId → VO.uuId；Alert.name → VO.name；Alert.engineName → VO.engineName；Alert.direction → VO.direction；Alert.dealAction → VO.dealAction；提取的 gptLogId → VO.gptLogId

### 默认行为

- engineExt 为空或无 wafGPT 键时，gptLogId 返回空字符串，该告警被跳过（不加入返回列表）
- 攻击成功日志ID和最新日志ID均为空时，gptLogId 返回空字符串，该告警被跳过
- 多个日志ID时取第一个（logIds.get(0)）

### 特殊规则

1. **优先级规则**：attackSuccessLogIds 优先于 logIds，确保优先返回攻击成功日志ID
2. **过滤规则**：gptLogId 为空的告警不返回（减少无效数据传输）
3. **返回类型特殊**：本接口返回 `List<GetGptLogIdsVo>`，未通过 OpenApiResponse 包装（与其他 OpenAPI 接口不同）
4. **仅支持 HTTP 类型告警**：通过 `getHttpAlerts` 查询，仅返回 HTTP 类型告警的 GPT 日志ID
5. **WAF GPT 专用**：仅提取 wafGPT 模块的日志ID，其他引擎的日志ID不提取

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| uuIds | array[string] | 是 | - | 告警UUID列表，最多 1000 个元素。每个元素必须非空（@NotBlank）且符合 UUID 格式（正则：UUID_CHAR_PARTTERN），元素长度 ≤ 255。注意：字段名为 uuIds（首字母 u 小写，Ids 的 I 大写） | ["alert-001", "alert-002"] |

## 返回参数

### 响应结构

**注意**：本接口返回类型为 `List<GetGptLogIdsVo>`，非标准 OpenApiResponse 包装。实际响应可能由全局响应包装器封装。

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息（由全局响应包装器添加） |
| data | array[GetGptLogIdsVo] | 告警GPT日志ID列表，见下方 item 元素结构说明 |

### item 元素结构说明（来源：GetGptLogIdsVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| uuId | string | 告警唯一ID | - | "alert-123456" |
| name | string | 告警名称 | - | "永恒之蓝" |
| direction | integer | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md） | 0/无, 1/内对外, 2/外对内, 3/内对内 | 2 |
| engineName | array[string] | 检测引擎名称列表 | - | ["IPS引擎", "WAF引擎"] |
| gptLogId | string | GPT日志ID（来源 engineExt.wafGPT，优先 attackSuccessLogIds，降级 logIds） | - | "gpt-log-001" |
| dealAction | string | 处置动作 | - | "手动标记" |

## 调用示例

### 示例1：批量获取告警的 GPT 日志ID

**请求示例**：
```json
{
    "uuIds": ["alert-001", "alert-002", "alert-003"]
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": [
        {
            "uuId": "alert-001",
            "name": "永恒之蓝",
            "direction": 2,
            "engineName": ["WAF引擎"],
            "gptLogId": "gpt-log-001",
            "dealAction": "手动标记"
        },
        {
            "uuId": "alert-003",
            "name": "SQL注入",
            "direction": 1,
            "engineName": ["WAF引擎"],
            "gptLogId": "gpt-log-003",
            "dealAction": null
        }
    ]
}
```

**说明**：alert-002 因 engineExt 为空或无 wafGPT 键被过滤，不出现在返回列表中。

### 示例2：单个告警查询

**请求示例**：
```json
{
    "uuIds": ["alert-001"]
}
```

### 示例3：批量查询最多 1000 个告警

**请求示例**：
```json
{
    "uuIds": ["alert-001", "alert-002", "... 共 500 个 ..."]
}
```

### 示例4：所有告警均无 GPT 日志ID时返回空列表

**请求示例**：
```json
{
    "uuIds": ["alert-no-gpt-1", "alert-no-gpt-2"]
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

**说明**：所有告警均无 wafGPT 模块或日志ID为空时，返回空列表。

### 示例5：错误响应示例 - uuIds 为空

**请求示例**（无效参数）：
```json
{
    "uuIds": []
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param.invalid.alertIds.format",
    "data": null
}
```

### 示例6：错误响应示例 - uuIds 元素超过 1000 个

**请求示例**（无效参数）：
```json
{
    "uuIds": ["alert-001", "... 共 1001 个 ..."]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param.invalid.alertIds.format",
    "data": null
}
```

### 示例7：错误响应示例 - uuId 元素格式不合法

**请求示例**（无效参数）：
```json
{
    "uuIds": ["invalid uuid with spaces"]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param.invalid.alertIds.format",
    "data": null
}
```

### 示例8：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **uuIds 限制**
   - 必填（@NotEmpty）
   - 最多 1000 个元素（@Size(max=1000)）
   - 每个元素必须非空（@NotBlank）
   - 每个元素必须符合 UUID 格式正则（UUID_CHAR_PARTTERN）
   - 每个元素长度 ≤ 255（@Size(max=255)）

2. **校验失败 message**
   - 所有校验失败均返回相同的 message："param.invalid.alertIds.format"（无法区分具体错误原因）

### 参数依赖关系

- uuIds 必填，不能为空数组
- 仅 HTTP 类型告警有 engineExt 字段，非 HTTP 类型告警会被跳过

### 权限要求

- 需要 `superAdmin`、`incidentQuery` 或 `alertQuery` 三者之一权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin','incidentQuery','alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.alerts.getGptLogIds.log"）

### 性能建议

1. **合理控制 uuIds 数量**
   - 虽然最多支持 1000 个，建议单次查询 100~500 个，避免响应过大
   - 大量告警需分批查询时，每批次建议 200~500 条

2. **HTTP 类型告警限制**
   - 仅 HTTP 类型告警含 wafGPT 模块的日志ID，其他类型告警会被跳过
   - 调用前可先通过 `/alerts/list` 过滤 HTTP 类型告警

3. **空结果处理**
   - 大量告警无 GPT 日志ID时，返回列表远小于输入列表
   - 前端需处理空列表场景

### 数据一致性说明

1. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 本接口无时间戳入参和返回字段

2. **GPT 日志ID提取规则**
   - 优先级：attackSuccessLogIds > logIds
   - 取列表第一个元素（logIds.get(0)）
   - engineExt 为空或无 wafGPT 键时返回空字符串，告警被过滤

3. **数据来源**
   - 告警数据来自 ES（通过 alertService.getHttpAlerts）
   - gptLogId 来自 engineExt.wafGPT 模块的 JSON 字段
   - engineExt 为 JSON 字符串，包含多引擎扩展信息

4. **过滤行为**
   - gptLogId 为空的告警不返回（过滤逻辑在 Service 层）
   - 非 HTTP 类型告警无 engineExt 字段，会被过滤

5. **返回类型差异**
   - 本接口返回 `List<GetGptLogIdsVo>`，非标准 OpenApiResponse<T> 包装
   - 实际响应可能由全局响应包装器自动封装为 {code, message, data} 格式

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param.invalid.alertIds.format | uuIds 为空数组 | 提供非空的 uuIds 列表 |
| 400 | param.invalid.alertIds.format | uuIds 元素超过 1000 个 | 减少 uuIds 元素数量至 1000 以内 |
| 400 | param.invalid.alertIds.format | uuId 元素格式不符合 UUID 规范 | 使用符合 UUID 格式的字符串 |
| 400 | param.invalid.alertIds.format | uuId 元素为空白字符串 | 移除空白元素 |
| 400 | param.invalid.alertIds.format | uuId 元素长度超过 255 | 缩短 uuId 字符串 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin、incidentQuery 或 alertQuery 权限 |
| 500 | getHttpAlertsByUuId failed | 服务端查询告警失败（如 ES 连接异常） | 联系技术支持，检查 ES 集群状态 |

## 最佳实践

1. **首次使用建议**
   - 先用 1~5 个已知含 GPT 日志的告警 uuId 测试接口
   - 验证权限配置是否正确

2. **配合告警列表使用**
   - 先调用 `/alerts/list` 获取告警 uuId 列表
   - 再调用本接口批量提取 GPT 日志ID
   - 注意过滤掉非 HTTP 类型告警（无 GPT 日志ID）

3. **批量查询优化**
   - 单次查询 200~500 个 uuId，平衡性能和数据量
   - 大量告警需分批查询时，每批次建议 200~500 条

4. **空结果处理**
   - 返回列表可能远小于输入列表（大量告警无 GPT 日志ID）
   - 前端需通过 uuId 对比识别哪些告警无 GPT 日志

5. **GPT 日志ID用途**
   - gptLogId 用于关联 GPT 研判日志系统
   - 通过 gptLogId 可查看 AI 研判的详细推理过程和原始日志

6. **优先级理解**
   - attackSuccessLogIds 优先：优先返回攻击成功事件的日志ID
   - logIds 降级：无攻击成功日志时返回最新日志ID
   - 业务上应优先关注攻击成功事件

7. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功
   - 400 错误统一返回 "param.invalid.alertIds.format"，需根据输入排查
   - 500 错误建议短暂间隔后重试
