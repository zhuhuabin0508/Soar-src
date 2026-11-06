# POST /api/xdr/v1/analysislog/count

- 业务对象：日志
- 接口类型：统计
- 关联文档：`analysislog-list.md`（日志列表）

## 接口概述

设备数量与日志量统计接口，按指定时间范围、日志类型、设备厂商、动作等维度统计日志量和设备数。**适用于获取日志总量、设备日志量统计、按时间范围过滤后统计日志数的场景**——如"最近 7 天安全日志总数"、"各设备类型日志量分布"等。

## 使用场景

- 查询安全日志总数（取 total 字段）
- 按时间范围统计日志量和设备数
- 按日志类型、设备厂商、动作等多维度过滤统计

## 请求路径

- **对外调用路径**：`/api/xdr/v1/analysislog/count`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/analysislog/count`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin`、`incidentQuery` 或 `alertQuery`

## 请求参数（OpenApiDeviceLogQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 查询开始时间 |
| endTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 查询结束时间 |
| logTypes | Array<String> | 是 | — | AllLogTypeEnum 枚举值（如 "tcp"，最多 60 个） | 日志类型 |
| sortType | String | 否 | DESC | SortTypeEnum：`ASC`/`DESC` | 排序方式 |
| vendorTypes | Array<Integer> | 否 | [] | 最多 2 个 | 设备厂商类型 |
| productTypes | Array<String> | 否 | — | 最多 10 个 | 上报设备（如 "SIP"） |
| actions | Array<Integer> | 否 | — | **LogActionEnum 枚举值（0/1/2/3，最多 5 个）**，详见下方"actions 枚举值说明" | 动作 |
| severities | Array<Integer> | 否 | — | IncidentSeverityEnum 枚举值，最多 5 个 | 严重性 |
| manages | Array<String> | 否 | — | | 上报设备 id |

#### actions 枚举值说明（LogActionEnum，参考 enum-dictionary.md）

| value | 说明 |
|-------|------|
| 0 | UNKNOWN（未知/位置） |
| 1 | ALLOW（允许） |
| 2 | DENY（拒绝） |
| 3 | MONITOR（监控） |

> ⚠️ **严禁传 4、5 等超界值**：QO 类的 `actions` 字段使用 `@Enum(clazz = LogActionEnum.class, method = "getValue", message = "param action is invalid")` 逐元素校验，`LogActionEnum` 合法取值仅 `0/1/2/3`。传入 `4` 或 `5` 会返回 `{"code": "InvalidParameter", "message": "param action is invalid;param action is invalid;"}`，每个非法元素对应一条错误信息（实测：传 `[1,2,3,4,5]` 返回两条 "param action is invalid"）。

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
3. **查询统计**：调用 `openApiAnalysisService.queryDeviceLogCount(qo)` 按时间和过滤条件统计日志量和设备数
4. **返回**：总日志量、总设备数、各设备日志明细

## 数据一致性说明

- **入参时间戳为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：当前时间 2026-07-05 00:00:00 UTC，最近 7 天起始时间戳 `1782499200`

## 调用示例

### 示例：最近 7 天安全日志总数

```json
POST /api/xdr/v1/analysislog/count
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "logTypes": ["tcp", "udp"]
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

## 关联接口

- `analysislog-list.md`：分页查询审计日志列表
- `analysislog-count-networksecurity.md`：网络安全日志统计