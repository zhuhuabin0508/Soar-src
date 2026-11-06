# POST /api/xdr/v1/analysislog/networksecurity/list

- 业务对象：网络安全日志
- 接口类型：分页列表
- 关联文档：`analysislog-list-networksecurity.md`（本文档）、`analysislog-count-networksecurity.md`（网络安全日志统计）、`analysislog-networksecurity-aggregation.md`（网络安全日志聚合）

## 接口概述

网络安全日志分页列表接口，按指定时间范围与过滤条件分页查询网络安全日志明细。**适用于获取网络安全日志明细列表的场景**——如"最近 7 天网络安全日志明细"、"按源国家过滤后的攻击日志列表"、"排除内网 IP 后的告警明细"等。

## 使用场景

1. **明细查询**：按时间范围分页查询网络安全日志明细，用于安全运营中心展示
2. **攻击调查**：按 threatClasses / threatTypes / threatSubTypes 过滤特定威胁类型的攻击日志
3. **地理过滤**：通过 filterParam.srcCountryNames / srcProvinceNames 过滤特定国家/省份的攻击源日志
4. **噪声排除**：通过 excludeParam.srcIps 排除已知误报 IP 后查询明细
5. **count→list 联动**：先调用 count 接口获取总数，再调用本接口分页查询明细
6. **访问方向过滤**：按 accessDirections（内对外 / 外对内）过滤查询

## 请求路径

- **对外调用路径**：`/api/xdr/v1/analysislog/networksecurity/list`
- HTTP 方法：POST
- Content-Type：application/json
- 权限：`superAdmin`、`incidentQuery` 或 `alertQuery`（三者任一）

## 请求参数（OpenApiNetworkSecurityLogListQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| page | Integer | 否 | 1 | 最小 1 | 页码 |
| pageSize | Integer | 否 | 20 | 建议 20~50，避免过大导致响应延迟 | 每页大小 |
| startTimestamp | Long | 是 | — | 1 ~ 9999999999（10 位秒级时间戳） | 查询开始时间 |
| endTimestamp | Long | 是 | — | 1 ~ 9999999999（10 位秒级时间戳），需 >= startTimestamp | 查询结束时间 |
| productTypes | Array<String> | 否 | — | 上报设备类型（如 "STA"） | 上报设备列表（**注意是复数 productTypes**，与 `/analysislog/list` 的单数 productType 不同） |
| accessDirections | Array<Integer> | 否 | — | AttackDirectionEnum：0/无, 1/内对外, 2/外对内, 3/内对内 | 访问方向 |
| threatClasses | Array<String> | 否 | — | 威胁大类 ID（如 "94"） | 威胁大类 |
| threatTypes | Array<String> | 否 | — | 威胁类型 ID，格式 `{classId}_{typeId}`（如 "94_1"） | 威胁类型 |
| threatSubTypes | Array<String> | 否 | — | 威胁子类型 ID，格式 `{classId}_{typeId}_{subTypeId}`（如 "94_1_-1"） | 威胁子类型 |
| srcIps | Array<String> | 否 | — | IPv4/IPv6 | 源 IP 列表 |
| dstIps | Array<String> | 否 | — | IPv4/IPv6 | 目的 IP 列表 |
| attackStates | Array<Integer> | 否 | — | 攻击状态枚举（如 0/1/2） | 攻击状态 |
| severities | Array<Integer> | 否 | — | 严重性枚举（如 0/1/3） | 严重性 |
| sortType | String | 否 | DESC | SortTypeEnum：`ASC`/`DESC` | 排序方式（注意大写） |
| filterParam | Object | 否 | — | OpenApiNetworkSecurityLogAggFilterQo | 包含条件过滤对象，见下方结构说明 |
| excludeParam | Object | 否 | — | NetworkSecurityLogExcludeQo | 排除条件过滤对象，见下方结构说明 |

> **与 count 接口的差异**：实测本接口**无需传 timeField**（count 接口 timeField 必填）；实测无需传 aggBy / aggFuncs（列表接口不做分组聚合）。

### filterParam 结构说明（来源：OpenApiNetworkSecurityLogAggFilterQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | Array<String> | 否 | 攻击源国家名称（包含条件，IN） | ["中国", "美国"] |
| srcProvinceNames | Array<String> | 否 | 攻击源省份名称（包含条件，IN） | ["广东", "北京"] |
| accessDirections | Array<Integer> | 否 | 访问方向（AttackDirectionEnum）。0/无, 1/内对外, 2/外对内, 3/内对内 | [1, 2] |

### excludeParam 结构说明（来源：NetworkSecurityLogExcludeQo）

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | Array<String> | 否 | 排除攻击源国家名称（NOT IN） | ["中国"] |
| srcProvinceNames | Array<String> | 否 | 排除攻击源省份名称（NOT IN） | ["广东"] |
| srcIps | Array<String> | 否 | 排除源 IP 列表（excludeParam 独有，filterParam 无此字段） | ["1.1.1.1"] |

## 返回参数（OpenApiPageResult<NetworkSecurityLogVo>）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| code | String | 响应码，"Success" 表示成功（注意：本接口 code 为字符串，非数字 200） |
| message | String | 响应消息（"成功"） |
| data | Object | 分页结果，见下方结构说明 |

### data 结构说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| total | Long | 满足条件的总记录数；**无数据时为 null 而非 0** |
| page | Integer | 当前页码 |
| pageSize | Integer | 每页大小 |
| item | Array<NetworkSecurityLogVo> | 日志明细列表；无数据时为 `[]` |

### item 元素常见字段（来源：NetworkSecurityLogVo 实体，以实际返回为准）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| srcIp | String | 源 IP |
| dstIp | String | 目的 IP |
| srcPort | Integer | 源端口 |
| dstPort | Integer | 目的端口 |
| threatClass | String | 威胁大类 |
| threatType | String | 威胁类型 |
| threatSubType | String | 威胁子类型 |
| severity | Integer | 严重性 |
| attackState | Integer | 攻击状态 |
| productType | String | 上报设备类型 |
| vendor | String | 设备厂商 |
| srcCountry / srcProvince | String | 攻击源国家/省份 |
| dstCountry / dstProvince | String | 目的国家/省份 |
| l3Protocol / l4Protocol / l7Protocol | String | 三层/四层/七层协议 |
| recordTimestamp | Long | 记录时间（秒级时间戳） |

## 业务逻辑

1. **时间范围处理**：Controller 层调用 `OpenApiTimeRangeUtil.resolveTimestamp()` 规范化时间戳并回写 QO
2. **时间校验**：Service 层检查 `startTimestamp <= endTimestamp`，否则抛 `START_TIME_LT_END_TIME` 异常
3. **分页转换**：Service 层将 page（页码）转换为 offset（`(page - 1) * pageSize`）传给 Mapper，返回结果中 page 仍为页码
4. **过滤应用**：filterParam 作为包含条件（IN）、excludeParam 作为排除条件（NOT IN）参与查询
5. **查询明细**：通过 networkSecurityLogMapper 按时间字段与过滤条件分页查询 ClickHouse
6. **返回**：分页结果含 page、pageSize、total、item 列表

## 数据一致性说明

- **入参时间戳为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 实测样例：2026-08-28 00:00:00（UTC+8）= 1787846400，2026-09-04 00:00:00（UTC+8）= 1788451200（7 天窗口）；调用时请使用 `Math.floor(Date.now() / 1000)` 计算当前秒级时间戳
- 数据存储于 ClickHouse，时间字段为秒级 Long

## 调用示例

### 示例 1：最近 7 天网络安全日志明细（2026-09-04 环境实测通过）

**请求示例**：

```json
POST /api/xdr/v1/analysislog/networksecurity/list
{
  "page": 1,
  "pageSize": 20,
  "startTimestamp": 1787846400,
  "endTimestamp": 1788451200,
  "productTypes": ["STA"],
  "accessDirections": [1, 2],
  "threatClasses": ["94"],
  "threatTypes": ["94_1"],
  "threatSubTypes": ["94_1_-1"],
  "srcIps": ["192.168.233.233"],
  "dstIps": ["19.19.8.10"],
  "attackStates": [0, 1, 2],
  "severities": [0, 1, 3],
  "sortType": "DESC",
  "filterParam": {
    "srcCountryNames": ["中国", "美国"],
    "srcProvinceNames": ["广东", "北京"]
  },
  "excludeParam": {
    "srcCountryNames": ["中国"],
    "srcProvinceNames": ["广东"],
    "srcIps": ["1.1.1.1"]
  }
}
```

**响应示例**（实测原始返回，过滤组合无命中数据时的空结果）：

```json
{
  "message": "成功",
  "code": "Success",
  "data": {
    "item": [],
    "pageSize": 20,
    "page": 1,
    "total": null
  }
}
```

### 示例 2：最小请求体查询

```json
POST /api/xdr/v1/analysislog/networksecurity/list
{
  "startTimestamp": 1787846400,
  "endTimestamp": 1788451200,
  "page": 1,
  "pageSize": 20
}
```

### 示例 3：按攻击源国家过滤

```json
POST /api/xdr/v1/analysislog/networksecurity/list
{
  "startTimestamp": 1787846400,
  "endTimestamp": 1788451200,
  "filterParam": {
    "srcCountryNames": ["美国", "俄罗斯"]
  }
}
```

### 示例 4：排除特定源 IP

```json
POST /api/xdr/v1/analysislog/networksecurity/list
{
  "startTimestamp": 1787846400,
  "endTimestamp": 1788451200,
  "excludeParam": {
    "srcIps": ["1.1.1.1"]
  }
}
```

## 使用注意事项

1. **时间戳单位**：入参为秒级（10 位 Long），不是毫秒级
2. **productTypes 是复数**：本接口字段名为 `productTypes`（数组）；通用审计日志列表 `/analysislog/list` 用的是单数 `productType`，不要混淆
3. **无需 timeField**：与 networksecurity/count 不同，list 接口实测不传 timeField 即可正常返回
4. **filterParam vs excludeParam**：filterParam 是包含条件（IN），excludeParam 是排除条件（NOT IN）；excludeParam 额外支持 srcIps 字段
5. **空结果特征**：无命中数据时返回 `total: null`（不是 0）且 `item: []`，判断空结果时需同时处理 null
6. **code 为字符串**：本接口成功响应 `code` 为 `"Success"`（字符串），不是数字 200；判断成功需按字符串比较
7. **pageSize 建议**：建议 20~50，过大的 pageSize 可能导致响应延迟
8. **这是明细接口**：返回分页明细列表，不是统计总数；如需统计走 `analysislog-count-networksecurity.md`，如需分组聚合走 `analysislog-networksecurity-aggregation.md`

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | START_TIME_LT_END_TIME | startTimestamp > endTimestamp | 保证开始时间不晚于结束时间 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin / incidentQuery / alertQuery 权限 |
| 500 | 请求失败 / InternalError | ClickHouse 查询异常或时间范围过大 | 缩小时间范围后重试 |

## 关联接口

- `/api/xdr/v1/analysislog/networksecurity/count`：网络安全日志统计（总量与设备维度）
- `/api/xdr/v1/analysislog/networksecurity/aggregation`：网络安全日志分组聚合统计
- `/api/xdr/v1/analysislog/count`：流量审计日志统计（通用）
- `/api/xdr/v1/analysislog/list`：流量审计日志分页列表（通用，注意字段名 productType 为单数）
- `/api/xdr/v1/analysislog/trafficaudit/count`：流量审计日志统计
- `/api/xdr/v1/analysislog/trends`：日志趋势统计
