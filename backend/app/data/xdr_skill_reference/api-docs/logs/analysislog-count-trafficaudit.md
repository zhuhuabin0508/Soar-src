# POST /api/xdr/v1/analysislog/trafficaudit/count

- 业务对象：流量审计日志
- 接口类型：统计
- 关联文档：`analysislog-list.md`（审计日志列表）

## 接口概述

流量审计日志统计接口，按指定时间范围、日志类型、设备厂商、动作等维度统计流量审计日志量和设备数。**适用于获取流量审计日志总量、设备日志量统计、按时间范围过滤后统计日志数的场景**——如"最近 7 天流量审计日志总数"、"各设备类型流量审计日志量分布"等。

## 使用场景

- 查询流量审计日志总数（取 totalLogCount 字段）
- 按时间范围统计流量审计日志量和设备数
- 按日志类型、设备厂商、动作等多维度过滤统计

## 请求路径

- **对外调用路径**：`/api/xdr/v1/analysislog/trafficaudit/count`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/analysislog/trafficaudit/count`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin`、`incidentQuery` 或 `alertQuery`

## 请求参数（OpenApiTrafficAuditLogCountQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 查询开始时间 |
| endTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 查询结束时间 |
| logTypes | Array<String> | 是 | — | AllLogTypeEnum 枚举值（如 "tcp"、"http"、"dns"，最多 60 个） | 日志类型 |
| sortType | String | 否 | DESC | SortTypeEnum：`ASC`/`DESC` | 排序方式 |
| vendorTypes | Array<Integer> | 否 | [] | 最多 2 个 | 设备厂商类型 |
| productTypes | Array<String> | 否 | — | 最多 10 个 | 上报设备（如 "SIP"） |
| actions | Array<Integer> | 否 | — | LogActionEnum 枚举值，最多 5 个 | 动作 |
| severities | Array<Integer> | 否 | — | IncidentSeverityEnum 枚举值，最多 5 个 | 严重性 |
| manages | Array<String> | 否 | — |  | 上报设备 id |

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

1. **时间范围补全**：Controller 调用 `OpenApiTimeRangeUtil.resolveTimestamp()` 补全时间戳
2. **参数校验**：startTimestamp/endTimestamp 必填，logTypes 必填且最多 60 个
3. **查询统计**：调用 `openApiAnalysisService.queryTrafficAuditLogCount(qo)` 按时间和过滤条件统计流量审计日志量和设备数
4. **返回**：总日志量、总设备数、各设备日志明细

## 数据一致性说明

- **入参时间戳为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：当前时间 2026-07-05 00:00:00 UTC，最近 7 天起始时间戳 `1782499200`

## 调用示例

### 示例：最近 7 天流量审计日志总数

```json
POST /api/xdr/v1/analysislog/trafficaudit/count
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "logTypes": ["tcp", "http", "dns"]
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

## 使用注意事项

1. **logTypes 必填**：必须传日志类型列表（如 `["tcp"]`），至少 1 个，最多 60 个
2. **时间戳单位**：入参为秒级（10 位 Long），不是毫秒级
3. **这是统计接口**：返回总数，不是明细列表；如需明细列表走 `analysislog-list.md`
4. **请求体最小集**：本接口为 count 接口，请求体只包含 startTimestamp/endTimestamp/logTypes/sortType 等基础过滤字段，**不接收 aggBy、aggFuncs、filterParam.success** 等聚合或扩展字段——这些字段属于 aggregation 接口，传入会导致 500 错误

## 关联接口

- `/api/xdr/v1/analysislog/count`：设备数量与日志量统计（通用）
- `/api/xdr/v1/analysislog/list`：分页查询审计日志列表（通用）
- `/api/xdr/v1/analysislog/trends`：日志趋势统计
- `/api/xdr/v1/analysislog/networksecurity/count`：网络安全日志统计
- `/api/xdr/v1/analysislog/networksecurity/list`：网络安全日志分页列表
- `/api/xdr/v1/analysislog/networksecurity/aggregation`：网络安全日志聚合统计
