# POST /api/xdr/v1/analysislog/networksecurity/count

- 业务对象：网络安全日志
- 接口类型：统计
- 关联文档：`analysislog-list-networksecurity.md`（网络安全日志列表）、`analysislog-networksecurity-aggregation.md`（网络安全日志聚合）

## 接口概述

网络安全日志统计接口，按指定时间范围、时间字段、过滤条件统计网络安全日志量和设备数。**适用于获取网络安全日志总量、设备日志量统计、按时间范围过滤后统计日志数的场景**——如"最近 7 天网络安全日志总数"、"按源国家过滤后网络安全日志量"等。

## 使用场景

- 查询网络安全日志总数（取 totalLogCount 字段）
- 按时间范围统计网络安全日志量和设备数
- 按 aggBy 分组字段、aggFuncs 聚合函数维度过滤统计
- 通过 filterParam / excludeParam 控制包含与排除条件

## 请求路径

- **对外调用路径**：`/api/xdr/v1/analysislog/networksecurity/count`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/analysislog/networksecurity/count`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin`、`incidentQuery` 或 `alertQuery`

## 请求参数（OpenApiNetworkSecurityLogCountQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 1 ~ 9999999999（10 位秒级时间戳） | 查询开始时间 |
| endTimestamp | Long | 是 | — | 1 ~ 9999999999（10 位秒级时间戳），需 >= startTimestamp | 查询结束时间 |
| timeField | String | 是 | — | 合法时间字段名（如 recordTimestamp / uploadTimestamp / insertTimestamp） | 过滤的时间字段 |
| aggBy | Array<String> | 否 | — | NetworkSecurityLog / NetworkSecurityLogVo 实体字段名（如 srcIp / dstIp / threatClass / severity 等） | 分组字段列表，建议只传 1 个字段 |
| aggFuncs | Array<AggFuncsDTO> | 否 | — | 至少 1 个元素 | 聚合操作列表，见下方 AggFuncsDTO 结构 |
| filterParam | Object | 否 | — | OpenApiNetworkSecurityLogAggFilterQo | 包含条件过滤对象，见下方结构说明 |
| excludeParam | Object | 否 | — | NetworkSecurityLogExcludeQo | 排除条件过滤对象，见下方结构说明 |

### filterParam 结构说明（来源：OpenApiNetworkSecurityLogAggFilterQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | Array<String> | 否 | 攻击源国家名称 | ["中国", "美国"] |
| srcProvinceNames | Array<String> | 否 | 攻击源省份名称 | ["广东", "北京"] |
| accessDirections | Array<Integer> | 否 | 访问方向（AttackDirectionEnum）。中文：0/无, 1/内对外, 2/外对内, 3/内对内 | [1, 2] |

### excludeParam 结构说明（来源：NetworkSecurityLogExcludeQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | Array<String> | 否 | 排除攻击源国家名称 | ["中国"] |
| srcProvinceNames | Array<String> | 否 | 排除攻击源省份名称 | ["广东"] |
| srcIps | Array<String> | 否 | 排除源 IP 列表（excludeParam 独有，filterParam 无此字段） | ["1.1.1.1"] |

### AggFuncsDTO 结构说明（来源：OpenApiNetworkSecurityLogAggQo.AggFuncsDTO）

| 参数名 | 类型 | 必填 | 说明 | 取值范围 | 示例值 |
|--------|------|------|------|----------|--------|
| name | String | 否 | 聚合结果名称，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | 最长 64 | "logCount" |
| func | String | 是 | 聚合操作名称，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | count / sum / avg / cardinality / max / min 等 | "count" |
| param | String | 是 | 聚合字段，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | 实体类字段名或 * | "srcIp" 或 "*" |

## 返回参数（DeviceLogCountVo）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| totalLogCount | Long | 总日志量 |
| totalDeviceCount | Long | 总设备数 |
| deviceLogCounts | Array<Object> | 各设备日志量统计列表 |

### deviceLogCounts 元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| manage | String | 设备 ID |
| manageDisplayName | String | 设备显示名称 |
| logCount | Long | 日志量 |
| productType | String | 产品类型 |

## 业务逻辑

1. **时间范围补全**：Controller 调用 `OpenApiTimeRangeUtil.resolveTimestamp()` 规范化时间戳并回写 QO
2. **时间校验**：Service 层检查 `startTimestamp <= endTimestamp`，否则抛 `START_TIME_LT_END_TIME` 异常
3. **参数校验**：startTimestamp / endTimestamp / timeField 必填
4. **查询统计**：调用 `networkSecurityLogMapper` 按时间字段、filterParam、excludeParam 统计网络安全日志量和设备数
5. **返回**：总日志量、总设备数、各设备日志明细

## 数据一致性说明

- **入参时间戳为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：2026-07-05 00:00:00 UTC = 1783180800（秒级），2026-06-28 00:00:00 UTC = 1782576000（秒级，7 天前）；调用时请使用 `Math.floor(Date.now() / 1000)` 计算当前秒级时间戳
- 数据存储于 ClickHouse，时间字段为秒级 Long

## 调用示例

### 示例 1：最近 7 天网络安全日志总数

```json
POST /api/xdr/v1/analysislog/networksecurity/count
{
  "startTimestamp": 1782576000,
  "endTimestamp": 1783180800,
  "timeField": "recordTimestamp"
}
```

返回示例：

```json
{
  "totalLogCount": 150000,
  "totalDeviceCount": 12,
  "deviceLogCounts": [
    {"manage": "2405703030", "manageDisplayName": "SIP-01", "logCount": 50000, "productType": "SIP"},
    {"manage": "2405703031", "manageDisplayName": "SIP-02", "logCount": 30000, "productType": "SIP"}
  ]
}
```

### 示例 2：按源国家过滤后统计网络安全日志量

```json
POST /api/xdr/v1/analysislog/networksecurity/count
{
  "startTimestamp": 1782576000,
  "endTimestamp": 1783180800,
  "timeField": "recordTimestamp",
  "filterParam": {
    "srcCountryNames": ["美国", "俄罗斯"]
  }
}
```

### 示例 3：排除特定源 IP 后统计网络安全日志量

```json
POST /api/xdr/v1/analysislog/networksecurity/count
{
  "startTimestamp": 1782576000,
  "endTimestamp": 1783180800,
  "timeField": "recordTimestamp",
  "excludeParam": {
    "srcIps": ["1.1.1.1"]
  }
}
```

## 使用注意事项

1. **timeField 必填**：必须指定按哪个时间字段过滤（如 recordTimestamp / uploadTimestamp / insertTimestamp）
2. **时间戳单位**：入参为秒级（10 位 Long），不是毫秒级
3. **这是统计接口**：返回 totalLogCount + totalDeviceCount + deviceLogCounts，不是明细列表；如需明细列表走 `analysislog-list-networksecurity.md`
4. **aggBy / aggFuncs 可选**：count 接口不强制要求 aggBy / aggFuncs，未传时返回总数统计；如需分组聚合统计走 `analysislog-networksecurity-aggregation.md`
5. **filterParam vs excludeParam**：filterParam 是包含条件（IN），excludeParam 是排除条件（NOT IN）；excludeParam 额外支持 srcIps 字段
6. **aggBy 字段必须使用实体类字段名**：从 NetworkSecurityLog / NetworkSecurityLogVo 实体类字段白名单提取，常用字段：srcIp / dstIp / srcPort / dstPort / threatClass / threatType / threatSubType / productType / vendor / severity / attackState / l7Protocol / l4Protocol / l3Protocol / srcCountry / srcProvince / dstCountry / dstProvince / srcIpTag / dstIpTag / action / tactic / technique / confidence / riskLevel / white / engineName / recordTimestamp 等

## 关联接口

- `/api/xdr/v1/analysislog/count`：流量审计日志统计（设备数量与日志量统计）
- `/api/xdr/v1/analysislog/list`：流量审计日志分页列表
- `/api/xdr/v1/analysislog/trends`：日志趋势统计
- `/api/xdr/v1/analysislog/networksecurity/list`：网络安全日志分页列表
- `/api/xdr/v1/analysislog/networksecurity/aggregation`：网络安全日志聚合统计
- `/api/xdr/v1/analysislog/trafficaudit/count`：流量审计日志统计
