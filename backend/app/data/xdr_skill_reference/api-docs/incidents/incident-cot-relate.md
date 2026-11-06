# POST /api/xdr/v1/incidents/cot/relate

## 接口概述

本接口用于根据事件 uuId 及关联的告警 ID 列表，查询事件上下文关联信息（用于 GPT 研判/CoT 推理输入），包含 NDR/EDR/关键/非关键告警明细、资产历史事件/告警数量、源/目的 IP 历史告警、事件规则 ID 关联事件、突发性引擎告警、关联告警、多厂商告警、安全事件实体统计、ATT&CK 技术等。通过本接口，您可以获取以下内容：

### 可查询的关联信息
- **告警明细**：ndrAlerts（NDR 告警）、edrAlerts（EDR 告警）、keyAlerts（关键告警）、noKeyAlerts（非关键告警）
- **资产历史关联**：assetRelateIncidentList（当前资产历史 7 天事件）、assetRelateAlertList（当前资产历史 7 天告警）
- **IP 历史告警**：srcIpRelateAlertList（hostIp 作为 srcIp 历史 7 天告警）、dstIpRelateAlertList（hostIp 作为 dstIp 历史 7 天告警）
- **规则关联事件**：eventRuleIdRelateIncidentList（7 天内相同事件规则 ID 的事件）
- **突发性引擎**：suddenEngineLog（突发性引擎告警，含 logCount 和最近发生时间）
- **关联告警**：incidentRelateAlerts（事件关联的告警）
- **多厂商告警**：multiDevicesAlerts（不同厂商的告警维度+数量）
- **实体统计**：disposalStatics（安全事件的实体数量）
- **ATT&CK**：attckTechniques（安全事件的 ATT&CK 技术）
- **分类信息**：classifyId（资产分类 ID）、classify1Id（资产二级分类 ID）

### 可设置的过滤维度
- **事件 uuId**：uuId（必填，需符合不允许特殊字符的正则）
- **告警 ID 列表**：ndrAlertIds / edrAlertIds / keyAlertIds / noKeyAlertIds / incidentRelateAlertIds / multiDevicesAlertIds（每个列表最多 1000 个元素，每元素最长 255 字符，需符合 UUID 正则）
- **关联查询开关**：assetRelateIncident / assetRelateAlert / srcIpRelateAlert / dstIpRelateAlert / eventRuleIdRelateIncident（boolean，缺省 false）
- **突发性引擎 hostIp**：suddenEngineHostIp（按 hostIp 查询最近 7 天事件）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口 - 安全事件（incidents） |
| 接口分类 | 事件关联查询（GPT 研判/CoT 推理输入） |
| 前置依赖 | 需先通过 `/incidents/list` 拿到事件 uuId 和关联告警 ID |
| 关联接口 | `/api/xdr/v1/incidents/list` 事件列表（获取 uuId）、`/api/xdr/v1/alerts/list` 告警列表（获取告警 ID） |

## 使用场景

1. **GPT 研判输入构造**：GPT/CoT 推理需要事件+告警+资产+IP 等多维关联信息，本接口一次返回所有上下文
2. **事件下钻分析**：在事件详情页展示 NDR/EDR/关键/非关键告警明细，辅助安全运营人员研判
3. **资产风险评估**：通过 assetRelateIncidentList / assetRelateAlertList 查看当前资产历史 7 天的事件/告警数，评估资产风险
4. **IP 维度狩猎**：通过 srcIpRelateAlertList / dstIpRelateAlertList 查看 hostIp 作为源/目的 IP 的历史告警，识别攻击源/目的
5. **规则关联事件**：通过 eventRuleIdRelateIncidentList 查看相同事件规则 ID 的历史事件，发现规则命中规律
6. **突发性引擎监测**：通过 suddenEngineLog 监测突发性引擎告警，定位短时间内激增的告警
7. **多厂商设备对比**：通过 multiDevicesAlerts 查看不同厂商设备的告警维度+数量，对比设备覆盖情况
8. **ATT&CK 战术分析**：通过 attckTechniques 查看事件关联的 ATT&CK 技术，辅助威胁狩猎

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/incidents/cot/relate |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery 或 alertQuery（三者任一） |

## 业务逻辑

### 核心处理流程

1. **入参 buildEmpty**：Controller 调用 `qo.buildEmpty()`，对所有告警 ID 列表做去重 + 限制最多 5 个元素（`distinct().limit(5)`），null 列表转为空列表
2. **限流检查**：从 `atomicCotRelateLimit` 减 1 取剩余配额（初始值由配置 `ngsoc.limit.cotRelate:5` 决定），若 `left < 0` 抛 `HttpClientErrorException(429 TOO_MANY_REQUESTS)` 拒绝执行
3. **Service 调用**：调用 `incidentService.getIncidentForGpt(qo)`，根据 qo 的开关字段分别查询：
   - NDR/EDR/关键/非关键告警明细（按 ID 列表批量查询）
   - 资产历史 7 天事件/告警数（assetRelateIncident/assetRelateAlert 开关）
   - 源/目的 IP 历史 7 天告警（srcIpRelateAlert/dstIpRelateAlert 开关）
   - 事件规则 ID 关联事件（eventRuleIdRelateIncident 开关）
   - 突发性引擎告警（suddenEngineHostIp 非空时）
   - 关联告警 + 多厂商告警（按 ID 列表批量查询）
   - 实体统计 + ATT&CK 技术（按事件 uuId 查询）
   - 资产分类 ID（classifyId / classify1Id）
4. **异常处理**：
   - 限流异常抛 `429 TOO_MANY_REQUESTS`
   - `QueryIncidentException` 被捕获后返回 `OpenApiConstants.ResponseCode.COMMON_FAILURE` + 异常 message + null data
5. **finally 释放配额**：`atomicCotRelateLimit.incrementAndGet()` 归还限流配额
6. **构造返回**：返回 `OpenApiResponse<IncidentGptVo>`，含上述所有上下文信息

### 数据转换逻辑

- 各告警列表查询结果封装为 `Map<alertId, XXXAlertVo>`，便于按 ID 查询
- 历史关联查询结果封装为 `IncidentListCountVo` / `AlertListCountVo`，含数量+明细
- 实体统计封装为 `DisposalStaticsVo`
- ATT&CK 技术封装为 `List<CotAttckTechniqueVo>`
- 资产分类直接返回 `classifyId` / `classify1Id` 整型字段

### 默认行为

- 各告警 ID 列表缺省时为空列表（buildEmpty 转换）
- 关联查询开关缺省时为 `false`（不查询对应历史关联）
- `suddenEngineHostIp` 缺省时不查询突发性引擎告警
- 限流配额缺省为 5（由 `ngsoc.limit.cotRelate` 配置决定）
- 各告警 ID 列表去重后最多取前 5 个（buildEmpty 限制）

### 特殊规则

- **限流**：本接口有原子计数器限流，并发超过 `ngsoc.limit.cotRelate`（默认 5）时返回 429 TOO_MANY_REQUESTS
- **uuId 必填**：必须符合 `STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS` 正则（不允许特殊字符）
- **告警 ID 列表限制**：每个列表最多 1000 个元素（@Size(max=1000)），但 buildEmpty 后实际只用前 5 个（去重 + limit(5)）
- **告警 ID 格式**：每个元素需符合 `CommonConstants.VerifyConstants.UUID_CHAR_PARTTERN` 正则，最长 255 字符
- **异常透传**：QueryIncidentException 返回 COMMON_FAILURE + 异常 message，不抛 500
- **关联查询开关**：每个历史关联查询需显式传 true 才会查询，避免无意义查询

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数（IncidentDetailFotGtpQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| uuId | string | 是 | - | 事件的 uuId，需符合不允许特殊字符的正则 | "inc-uuid-12345" |
| ndrAlertIds | array[string] | 否 | - | NDR 告警 ID 列表，最多 1000 个元素，每元素最长 255 字符且需符合 UUID 正则。**buildEmpty 后去重最多取前 5 个** | ["alert-1", "alert-2"] |
| edrAlertIds | array[string] | 否 | - | EDR 告警 ID 列表，限制同上 | ["alert-3"] |
| keyAlertIds | array[string] | 否 | - | 关键告警 ID 列表，限制同上 | ["alert-4"] |
| noKeyAlertIds | array[string] | 否 | - | 非关键告警 ID 列表，限制同上 | ["alert-5"] |
| assetRelateIncident | boolean | 否 | false | 是否查询当前资产历史 7 天事件数量 | true |
| assetRelateAlert | boolean | 否 | false | 是否查询当前资产历史 7 天告警数量 | true |
| srcIpRelateAlert | boolean | 否 | false | 是否查询 hostIp 作为 srcIp 历史 7 天告警数量 | false |
| dstIpRelateAlert | boolean | 否 | false | 是否查询 hostIp 作为 dstIp 历史 7 天告警数量 | false |
| eventRuleIdRelateIncident | boolean | 否 | false | 是否查询 7 天内相同事件规则 ID 的事件数量 | false |
| suddenEngineHostIp | string | 否 | - | 突发性引擎 hostIp，按此 hostIp 查询最近 7 天事件（不含当前事件），随机取第一个安全事件的第一个安全告警的 logCount | "192.168.1.10" |
| incidentRelateAlertIds | array[string] | 否 | - | 事件关联告警 ID 列表（查询事件关联 3 个告警名称），限制同 ndrAlertIds | ["alert-6"] |
| multiDevicesAlertIds | array[string] | 否 | - | 不同厂商的告警 ID 列表，限制同 ndrAlertIds | ["alert-7"] |

> **注意**：所有 array[string] 字段均无 @JsonProperty 注解，使用 Java 字段名作为 JSON 字段名。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 `"Success"`（字符串）；限流时 HTTP 429；业务失败时为整数 `1` + `message` |
| message | string | 响应消息 |
| data | object | 响应数据（IncidentGptVo） |

### data 结构说明（IncidentGptVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| ndrAlerts | map<string, IncidentGptNdrAlertVo> | NDR 告警列表，key 为告警 ID，value 为告警明细 | {"alert-1": {...}} |
| edrAlerts | map<string, IncidentGptEdrAlertVo> | EDR 告警列表 | {"alert-3": {...}} |
| keyAlerts | map<string, IncidentGptKeyAlertVo> | 关键告警列表 | {"alert-4": {...}} |
| noKeyAlerts | map<string, IncidentGptNoKeyAlertVo> | 非关键告警列表 | {"alert-5": {...}} |
| classifyId | integer | 资产分类 ID | 1 |
| classify1Id | integer | 资产二级分类 ID | 8 |
| assetRelateIncidentList | IncidentListCountVo | 当前资产历史 7 天事件数量 | {"count": 5, "items": [...]} |
| assetRelateAlertList | AlertListCountVo | 当前资产历史 7 天告警数量 | {"count": 25, "items": [...]} |
| srcIpRelateAlertList | AlertListCountVo | hostIp 作为 srcIp 历史 7 天告警数量 | {"count": 12, "items": [...]} |
| dstIpRelateAlertList | AlertListCountVo | hostIp 作为 dstIp 历史 7 天告警数量 | {"count": 8, "items": [...]} |
| eventRuleIdRelateIncidentList | IncidentListCountVo | 7 天内相同事件规则 ID 的事件数量 | {"count": 3, "items": [...]} |
| suddenEngineLog | IncidentGptVoSuddenEngineLogVo | 突发性引擎告警，含 logCount 和最近发生时间 | {"logCount": 100, "lastTime": 1783123200} |
| incidentRelateAlerts | AlertListCountVo | 关联的告警 | {"count": 3, "items": [...]} |
| multiDevicesAlerts | AlertListCountVo | 不同厂商的告警维度+数量 | {"count": 5, "items": [...]} |
| disposalStatics | DisposalStaticsVo | 安全事件的实体数量 | {"totalEntities": 10, ...} |
| attckTechniques | array[CotAttckTechniqueVo] | 安全事件的 ATT&CK 技术 | [{"techniqueId": "T1059", "tactic": "TA0002"}] |

> 子结构（IncidentGptNdrAlertVo / IncidentGptEdrAlertVo / IncidentGptKeyAlertVo / IncidentGptNoKeyAlertVo / IncidentListCountVo / AlertListCountVo / IncidentGptVoSuddenEngineLogVo / DisposalStaticsVo / CotAttckTechniqueVo）的字段细节请参考各自源码定义。

## 调用示例

### 示例1：查询事件基础关联（含告警明细）

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345",
  "ndrAlertIds": ["alert-1", "alert-2"],
  "edrAlertIds": ["alert-3"],
  "keyAlertIds": ["alert-4"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "ndrAlerts": {
      "alert-1": {"alertName": "NDR告警1", "srcIp": "192.168.1.10", "dstIp": "10.0.0.5"},
      "alert-2": {"alertName": "NDR告警2", "srcIp": "192.168.1.10", "dstIp": "10.0.0.6"}
    },
    "edrAlerts": {
      "alert-3": {"alertName": "EDR告警1", "hostIp": "192.168.1.10"}
    },
    "keyAlerts": {
      "alert-4": {"alertName": "关键告警1", "severity": 4}
    },
    "noKeyAlerts": {},
    "classifyId": 1,
    "classify1Id": 8,
    "attckTechniques": [{"techniqueId": "T1059", "tactic": "TA0002"}]
  }
}
```

### 示例2：查询资产历史关联（开关联查）

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345",
  "assetRelateIncident": true,
  "assetRelateAlert": true,
  "srcIpRelateAlert": true,
  "dstIpRelateAlert": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "classifyId": 1,
    "classify1Id": 8,
    "assetRelateIncidentList": {"count": 5, "items": [{"name": "事件A", "time": 1751000000}]},
    "assetRelateAlertList": {"count": 25, "items": [{"name": "告警A", "time": 1751010000}]},
    "srcIpRelateAlertList": {"count": 12, "items": [{"name": "告警B", "time": 1751020000}]},
    "dstIpRelateAlertList": {"count": 8, "items": [{"name": "告警C", "time": 1751030000}]}
  }
}
```

### 示例3：查询突发性引擎 + 规则关联

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345",
  "suddenEngineHostIp": "192.168.1.10",
  "eventRuleIdRelateIncident": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "classifyId": 1,
    "classify1Id": 8,
    "suddenEngineLog": {"logCount": 100, "lastTime": 1783123200},
    "eventRuleIdRelateIncidentList": {"count": 3, "items": [{"name": "事件D", "time": 1751100000}]}
  }
}
```

### 示例4：查询多厂商告警 + 关联告警

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345",
  "incidentRelateAlertIds": ["alert-6", "alert-7", "alert-8"],
  "multiDevicesAlertIds": ["alert-9", "alert-10"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "classifyId": 1,
    "classify1Id": 8,
    "incidentRelateAlerts": {"count": 3, "items": [{"name": "关联告警1"}, {"name": "关联告警2"}, {"name": "关联告警3"}]},
    "multiDevicesAlerts": {"count": 5, "items": [{"vendor": "vendorA", "count": 3}, {"vendor": "vendorB", "count": 2}]}
  }
}
```

### 示例5：完整上下文查询（所有开关全开）

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345",
  "ndrAlertIds": ["alert-1"],
  "edrAlertIds": ["alert-3"],
  "keyAlertIds": ["alert-4"],
  "noKeyAlertIds": ["alert-5"],
  "assetRelateIncident": true,
  "assetRelateAlert": true,
  "srcIpRelateAlert": true,
  "dstIpRelateAlert": true,
  "eventRuleIdRelateIncident": true,
  "suddenEngineHostIp": "192.168.1.10",
  "incidentRelateAlertIds": ["alert-6"],
  "multiDevicesAlertIds": ["alert-9"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "ndrAlerts": {"alert-1": {...}},
    "edrAlerts": {"alert-3": {...}},
    "keyAlerts": {"alert-4": {...}},
    "noKeyAlerts": {"alert-5": {...}},
    "classifyId": 1,
    "classify1Id": 8,
    "assetRelateIncidentList": {"count": 5, "items": [...]},
    "assetRelateAlertList": {"count": 25, "items": [...]},
    "srcIpRelateAlertList": {"count": 12, "items": [...]},
    "dstIpRelateAlertList": {"count": 8, "items": [...]},
    "eventRuleIdRelateIncidentList": {"count": 3, "items": [...]},
    "suddenEngineLog": {"logCount": 100, "lastTime": 1783123200},
    "incidentRelateAlerts": {"count": 1, "items": [...]},
    "multiDevicesAlerts": {"count": 1, "items": [...]},
    "disposalStatics": {"totalEntities": 10},
    "attckTechniques": [{"techniqueId": "T1059", "tactic": "TA0002"}]
  }
}
```

### 示例6：错误响应示例（限流 429）

**请求示例**：
```json
{
  "uuId": "inc-uuid-12345"
}
```

**错误响应示例**（并发超限）：
```json
{
  "code": 429,
  "message": "TOO_MANY_REQUESTS",
  "data": null
}
```

### 示例7：错误响应示例（uuId 缺失）

**请求示例**（缺少 uuId）：
```json
{
  "ndrAlertIds": ["alert-1"]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "param.invalid.uuId.format",
  "data": null
}
```

### 示例8：错误响应示例（告警 ID 格式错误）

**请求示例**（ndrAlertIds 含非法字符）：
```json
{
  "uuId": "inc-uuid-12345",
  "ndrAlertIds": ["alert-with-special-char$"]
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

### 示例9：业务失败（QueryIncidentException）

**请求示例**（事件 uuId 不存在）：
```json
{
  "uuId": "inc-uuid-not-exist"
}
```

**响应示例**：
```json
{
  "code": 1,
  "message": "incident not found",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `uuId` 必填，需符合不允许特殊字符的正则
- 各告警 ID 列表最多 1000 个元素（@Size(max=1000)），每元素最长 255 字符且需符合 UUID 正则
- buildEmpty 后实际只用前 5 个元素（去重 + limit(5)），多余的被静默丢弃
- 关联查询开关缺省 false，需显式传 true 才会查询对应历史关联

### 参数依赖关系
- `uuId` 决定主事件上下文（classifyId / classify1Id / disposalStatics / attckTechniques）
- 各告警 ID 列表决定对应告警明细查询
- 关联查询开关 + 主事件 uuId 决定历史关联查询范围
- `suddenEngineHostIp` 单独决定突发性引擎告警查询

### 权限要求
- 需具备 `superAdmin`、`incidentQuery`、`alertQuery` 三者任一权限

### 性能建议
- 本接口有原子计数器限流，并发超过 `ngsoc.limit.cotRelate`（默认 5）时返回 429，建议客户端做重试 + 退避
- 告警 ID 列表虽然支持 1000 个，但 buildEmpty 后只用前 5 个，建议只传必要的 5 个
- 关联查询开关按需开启，避免无意义的历史查询拖慢响应
- 复杂场景可拆分多次调用（如先拿告警明细，再开关联查开关查历史）

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-07-04 00:00:00 UTC = 1783123200
- 历史关联查询的时间窗口固定为 7 天（业务规则）
- 告警 ID 列表去重后最多取前 5 个，多余的会被静默丢弃

### 使用注意事项
- **限流重要**：本接口有原子计数器限流（默认并发 5），高并发场景必须做客户端重试 + 退避，避免雪崩
- **告警 ID 实际只用前 5 个**：虽然 @Size(max=1000) 允许 1000 个，但 buildEmpty 后只取前 5 个，多余的会被丢弃
- **关联查询开关默认 false**：assetRelateIncident/assetRelateAlert/srcIpRelateAlert/dstIpRelateAlert/eventRuleIdRelateIncident 默认 false，需显式传 true
- **异常透传**：QueryIncidentException 不抛 500，返回 COMMON_FAILURE + 异常 message，对接时需检查 code
- **前置依赖**：需先通过 `/incidents/list` 拿到事件 uuId，再通过 `/alerts/list` 或事件详情拿到关联告警 ID
- **buildEmpty 副作用**：调用 buildEmpty 后会修改 qo 的字段（去重+截断），同一 qo 对象不能重复使用

## 常见错误

| HTTP | code | 说明 | 原因 | 解决方案 |
|------|------|------|------|----------|
| 400 | "InvalidParameter" | param.invalid.uuId.format | uuId 缺失或包含特殊字符 | 传入合法 uuId（不含特殊字符） |
| 400 | "InvalidParameter" | param.invalid.alertIds.format | 告警 ID 列表元素格式错误或超过 1000 个 | 校正元素格式（UUID 正则，最长 255 字符），列表最多 1000 个 |
| 429 | "InvalidParameter"（限流，HTTP 429） | TOO_MANY_REQUESTS | 并发超过限流配额（默认 5） | 客户端做重试 + 退避，错峰调用 |
| 200 | 整数 `1`（COMMON_FAILURE） | incident not found 等业务消息 | 事件 uuId 不存在或查询失败（**业务失败仍返回 HTTP 200 + 整数 code 1**） | 检查 uuId 是否正确，先通过 `/incidents/list` 确认 |
| 500 | "InternalError" | exception.method.execute | 数据库异常 | 联系管理员查看后端日志 |

## 最佳实践

1. **限流处理**：客户端必须处理 429 响应，使用指数退避重试，避免高并发时段集中调用
2. **告警 ID 精简**：虽然支持 1000 个，但 buildEmpty 后只用前 5 个，建议直接传必要的 5 个，减少传输开销
3. **按需开关联查开关**：assetRelateIncident/assetRelateAlert 等开关按业务需求开启，避免全开拖慢响应
4. **拆分调用**：复杂场景拆分多次调用，先拿基础告警明细，再开关联查开关查历史
5. **前置调用 `/incidents/list`**：本接口需要事件 uuId 和告警 ID，必须先调用 `/incidents/list` 拿到
6. **错误码处理**：本接口返回多种错误码（400/429/1/500），客户端需分别处理
7. **GPT 研判使用**：本接口专为 GPT/CoT 推理输入设计，所有上下文一次返回，避免 GPT 多次调用其他接口
8. **历史 7 天窗口**：所有历史关联查询固定为 7 天窗口，不能自定义时间范围
