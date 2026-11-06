# GET /api/xdr/v1/alerts/gptresult/type

## 接口概述

本接口用于获取XDR系统中告警GPT研判结论（威胁定性）的完整枚举列表，返回所有可用的研判结论编码与中文名称映射。通过本接口，您可以获取以下内容：

### 可查询的GPT研判结论信息
- **研判结论编码**：PrototypeGptResultEnum 枚举的 threatDefine 值（如 0、110、115、120、130、140、150、160、170、180 等）
- **研判结论中文名**：PrototypeGptResultEnum 枚举的 label 值（如"待研判"、"攻击成功"、"主机失陷活动"等）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | GPT研判结论元数据查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询（gptResult 字段值来源于本接口返回的 value）、`/alerts/getGptLogIds` 获取告警GPT日志ID |

## 使用场景

1. **研判结论下拉框**：在告警列表页面初始化时调用，加载所有可用的GPT研判结论，供用户按研判结论过滤告警
2. **告警查询参数构造**：调用告警列表接口前，先调用本接口获取研判结论编码列表，将其作为 threatDefines 参数过滤特定研判结论的告警
3. **研判结论字典**：作为研判结论的字典接口，提供编码与中文名称的映射，用于前端展示和报表生成
4. **研判结论校验**：前端在展示告警 gptResult 字段时，通过本接口获取中文名称映射
5. **配合告警列表使用**：调用 `/alerts/list` 查询告警时，使用本接口返回的 value 作为 threatDefines 过滤条件的取值

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/alerts/gptresult/type |
| Content-Type | 无（GET 请求无请求体） |
| 权限要求 | superAdmin、alertQuery 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求**：Controller 接收 GET 请求，无需任何参数
2. **遍历枚举**：Service 层遍历 `PrototypeGptResultEnum.values()` 获取所有枚举常量
3. **构造 VO**：对每个枚举常量构造一个 OpenApiGptResultVo.Items：
   - name 字段 ← PrototypeGptResultEnum.getLabel()（中文名称，如"攻击成功"）
   - value 字段 ← PrototypeGptResultEnum.getThreatDefine()（编码，如 110）
4. **封装结果**：将构造好的 Items 列表设置到 OpenApiGptResultVo.item，total 设置为列表大小
5. **返回结果**：将 OpenApiGptResultVo 封装到 OpenApiResponse 返回

### 数据转换逻辑

- 数据来源：PrototypeGptResultEnum 枚举类（Java 静态枚举，非数据库查询）
- 字段映射：PrototypeGptResultEnum.label → Items.name；PrototypeGptResultEnum.threatDefine → Items.value
- 枚举顺序：按 PrototypeGptResultEnum.values() 的声明顺序返回

### 默认行为

- 无需任何请求参数，直接返回全量研判结论列表
- 包含所有枚举常量（含已废弃的枚举值）

### 特殊规则

- 接口无入参校验逻辑
- 数据来自 Java 枚举类，调用性能高
- 包含已废弃的枚举值（如 10/20/30/40/50/60/70 等），前端需根据业务需求过滤

## 请求参数

### 请求头

无特殊请求头要求（标准 HTTP GET 请求）。

### 请求参数

无（GET 请求，无路径参数，无查询参数，无请求体）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，见下方 data 结构说明 |

### data 结构说明（来源：OpenApiGptResultVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[Items] | GPT研判结论列表，见下方 Items 结构说明 |
| total | integer | 总数（item 列表长度） |

### item 元素结构说明（来源：OpenApiGptResultVo.Items）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 研判结论中文名（来源 PrototypeGptResultEnum.getLabel()） | - | "攻击成功" |
| value | integer | 研判结论编码（来源 PrototypeGptResultEnum.getThreatDefine()） | - | 110 |

### GPT研判结论完整枚举（来源：PrototypeGptResultEnum，参考 enum-dictionary.md）

| value | name（中文） | 枚举常量名 | 状态 |
|-------|-------------|-----------|------|
| 0 | 等待GPT研判 | PENDING | 当前 |
| 10 | 人工入侵 | TARGETED_ATTACK_EVENTS | 已废弃(2.0.30) |
| 20 | 病毒木马 | VIRUS | 已废弃(2.0.30) |
| 30 | 疑似入侵 | SUSPECTED_TARGETED_ATTACK | 已废弃(2.0.30) |
| 40 | 业务误报 | UNKNOWN_THREAT | 已废弃(2.0.30) |
| 50 | 脆弱性风险 | VULNERABILITY_RISK | 已废弃(2.0.30) |
| 60 | 风险探测 | SCANNER_ATTACKS | 已废弃(2.0.30) |
| 70 | 可疑行为 | BUSINESS_IRREGULARITIES | 已废弃(2.0.30) |
| 110 | 真实攻击成功 | REAL_ATTACK_SUCCESS | 当前 |
| 115 | 主机失陷活动 | HOST_CRASH_ACTIVITY | 当前 |
| 120 | 病毒木马活动 | VIRUS_TROJANS_ACTIVITY | 当前 |
| 130 | 真实攻击未成功 | REAL_ATTACK_NOT_SUCCESS | 当前 |
| 140 | 脆弱性访问 | WEAK_ACCESS | 当前 |
| 150 | 疑似攻击行为 | SUSPICIOUS_ATTACK | 当前 |
| 160 | 误报 | NEW_FALSE_POSITIVE | 当前 |
| 170 | 数据不足 | LAKE_OF_DATA | 当前 |
| 180 | 自定义类型 | CUSTOMIZE_TYPE | 当前 |

> 注：OTHER_THREAT_DEFINE = [100, 600, 700, 800] 为组合查询值，非单枚举常量，本接口不返回。
> 告警域字段名为 threatDefine；事件域字段名为 gptResult。

## 苓用示例

### 示例1：获取所有GPT研判结论

**请求示例**：
```
GET /api/xdr/v1/alerts/gptresult/type
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "name": "等待GPT研判",
                "value": 0
            },
            {
                "name": "人工入侵",
                "value": 10
            },
            {
                "name": "病毒木马",
                "value": 20
            },
            {
                "name": "疑似入侵",
                "value": 30
            },
            {
                "name": "业务误报",
                "value": 40
            },
            {
                "name": "脆弱性风险",
                "value": 50
            },
            {
                "name": "风险探测",
                "value": 60
            },
            {
                "name": "可疑行为",
                "value": 70
            },
            {
                "name": "真实攻击成功",
                "value": 110
            },
            {
                "name": "主机失陷活动",
                "value": 115
            },
            {
                "name": "病毒木马活动",
                "value": 120
            },
            {
                "name": "真实攻击未成功",
                "value": 130
            },
            {
                "name": "脆弱性访问",
                "value": 140
            },
            {
                "name": "疑似攻击行为",
                "value": 150
            },
            {
                "name": "误报",
                "value": 160
            },
            {
                "name": "数据不足",
                "value": 170
            },
            {
                "name": "自定义类型",
                "value": 180
            }
        ],
        "total": 17
    }
}
```

### 示例2：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

### 示例3：服务端异常响应

```json
{
    "code": "InternalError",
    "message": "exception.method.execute",
    "data": null
}
```

## 注意事项与限制

### 参数限制

- 本接口为无参数 GET 请求，无入参限制

### 参数依赖关系

- 无入参依赖

### 权限要求

- 需要 `superAdmin`、`alertQuery` 或 `incidentQuery` 三者之一权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery', 'incidentQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.alerts.aggregation.log"）

### 性能建议

- 接口数据来自 Java 枚举类，调用性能高，可频繁调用
- 研判结论枚举更新频率低，可在前端做适度缓存（如 30 分钟），避免重复请求

### 数据一致性说明

- 数据来源于 Java 静态枚举类 PrototypeGptResultEnum，非实时查询数据库
- 枚举值变更需重启服务才能生效
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字（本接口不涉及时间戳）

### 已废弃枚举值说明

- value=10/20/30/40/50/60/70 在 2.0.30 版本已废弃，仅为兼容旧数据保留
- 前端展示时建议过滤已废弃值，仅展示当前可用值（0、110、115、120、130、140、150、160、170、180）
- 告警查询时若需兼容旧数据，可包含已废弃值

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin、alertQuery 或 incidentQuery 权限 |
| 500 | exception.method.execute | 服务端执行异常 | 联系技术支持 |

## 最佳实践

1. **首次使用建议**
   - 直接调用本接口获取全量研判结论列表
   - 验证权限配置是否正确

2. **配合告警查询使用**
   - 调用本接口获取研判结论列表后，将 value 字段作为告警查询接口 `threatDefines` 参数的过滤值
   - 用于按研判结论过滤告警列表

3. **前端缓存策略**
   - 研判结论枚举更新频率低，建议前端缓存 30 分钟~1 小时
   - 避免每次告警查询前都调用本接口

4. **已废弃值处理**
   - 前端展示研判结论下拉框时，建议过滤已废弃值（value=10/20/30/40/50/60/70）
   - 告警查询兼容旧数据时，可包含已废弃值
   - 已废弃值对应历史告警的研判结论，新告警不会使用这些值

5. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功，其他为失败
   - 403 错误需联系管理员添加权限，不可重试
   - 500 错误建议短暂间隔后重试

6. **字段使用建议**
   - name 字段为研判结论中文名，用于前端展示
   - value 字段为研判结论编码，用于告警查询接口的过滤参数
   - 两者一一对应，不可混淆使用
