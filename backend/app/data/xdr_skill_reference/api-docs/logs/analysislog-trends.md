# POST /api/xdr/v1/analysislog/trends

## 接口概述

本接口用于按时间分桶对各类设备日志（流量审计日志、端点安全日志、HTTP/DNS/邮件协议日志、TCP/ICMP 等网络日志）做趋势统计，返回每个时间桶的日志条数。通过本接口，您可以获取以下内容：

### 可查询/统计的趋势信息
- **时间桶序列**：按 interval 分桶后的完整时间序列（缺数据的时间桶会补零）
- **每桶日志条数**：每个时间桶内匹配过滤条件的日志总数
- **分组维度**：通过 aggBy 字段可按源IP/目的IP/上报设备等维度分组，**必须是本接口 md 中"⚠️ aggBy 字段高频踩坑"段落列出的推荐字段**（不支持 `logType` 等非推荐字段），每组一条独立趋势曲线

### 可设置的过滤维度
- **时间范围**：startTimestamp / endTimestamp（秒级，必填）
- **时间字段**：timeField（recordTimestamp / uploadTimestamp / insertTimestamp）
- **日志类型**：logTypes（必填，最多 60 个，对应 AllLogTypeEnum）
- **过滤参数**：filterParam（srcIps / dstIps）
- **分组字段**：aggBy（多字段分组）
- **聚合操作**：aggFuncs（必填，含 name + param）
- **时间间隔**：interval（必填，1m / 1H / 1d / 1M，大小写敏感）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAnalysisController |
| 所属业务域 | 流量审计日志开放性接口（analysislog） |
| 接口分类 | 日志趋势统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/analysislog/list` 审计日志列表、`/api/xdr/v1/analysislog/count` 设备数量与日志量统计 |

## 使用场景

1. **日志趋势大屏**：在 SOC 大屏按小时/天展示日志总量变化趋势，识别异常峰值
2. **日志类型分布对比**：由于 `logType` 不在 trends 接口的 aggBy 白名单（详见下方"⚠️ aggBy 字段高频踩坑"），**不能通过 `aggBy` 按日志类型分组**。需分多次请求，每次 `logTypes` 只传一种类型、缺省 `aggBy`，再客户端拼接对比
3. **源/目的 IP 维度趋势**：通过 aggBy 按 srcIp / dstIp 分组，定位流量异常的源或目的
4. **协议异常监测**：按协议日志类型（如 smtp_login / ftp_login / ssh）分组统计登录类日志的趋势，发现暴力破解等异常
5. **分钟级精确分析**：在应急响应场景使用 `1m` 分钟级精度，定位短时间内日志激增的具体时间点（注意时间范围不超过 3 天）
6. **月度趋势报表**：使用 `1M` 月级精度跨多月统计日志量分布，生成长期趋势报表

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/analysislog/trends |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery 或 alertQuery（三者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳并回写 QO
2. **Service 层时间校验**：
   - `validateTimestamps` 检查 `startTimestamp <= endTimestamp`，否则抛 `exception.param.error`
   - 若 `interval = 1m`（分钟级），且时间范围 >= 3 天（259200 秒），抛 `exception.param.error.timeRangeExceeded`
3. **表名拼接**：将 `logTypes`（如 `tcp`）拼接后缀 `_log` 得到 ClickHouse 表名（如 `tcp_log`），最多 60 张表
4. **查询 ClickHouse**：调用 `trendLogMapper.getTrendLogAggResult(qo, tableNames)`，按 timeField 时间字段过滤、aggBy 分组、interval 时间分桶、aggFuncs 聚合，跨多张日志表联合查询
5. **空结果处理**：若查询结果为空，直接返回 `item: []`
6. **生成完整时间序列**：`generateTimeSeries` 按 interval 生成对齐后的完整时间桶序列：
   - `1m`：`timestamp - (timestamp % 60)`
   - `1H`：`timestamp - (timestamp % 3600)`
   - `1d`：使用 `Instant.ofEpochSecond(...).atStartOfDay()` 对齐到本地时区零点
   - `1M`：调用 `generateMonthlySeries`，按月对齐到当月 1 号 0 点
7. **零填充**：`processResultsWithZeroFill` 将 ClickHouse 返回的稀疏数据按完整时间序列补零，按 aggBy 分组字段分组，每组生成一条完整的趋势曲线
8. **构造返回**：返回 `OpenApiTrendResult`，含 `item` 列表，每个元素含 `name`（分组键）+ `item`（时间桶数组，每个含 name=时间戳、value=条数）

### 数据转换逻辑

- ClickHouse `eventDate`（UnsignedInteger）→ `Long` 时间戳（秒级）
- ClickHouse `count`（UnsignedLong）→ `Long` 数值
- 起止时间戳按 interval 对齐后再生成时间序列，确保时间桶边界一致
- 缺失时间桶由 `processResultsWithZeroFill` 补 `value=0`
- `name` 字段（时间桶名）为秒级时间戳字符串

### 默认行为

- `aggBy` 缺省时返回单条总趋势曲线（不分组）
- `filterParam` 缺省时不按 srcIps/dstIps 过滤
- 时间桶按 interval 自动对齐：
  - 分钟级：对齐到整分钟
  - 小时级：对齐到整小时
  - 天级：对齐到本地时区零点
  - 月级：对齐到当月 1 号 0 点
- 空查询结果返回 `item: []`（注意：补零逻辑只在有数据时触发）

### 特殊规则

- **interval 大小写敏感**：取值仅 `1m` / `1H` / `1d` / `1M`。注意 `1H` 大写 H（不是 `1h`），`1M` 大写 M（不是 `1m`）。非法值由 `@Enum(clazz = TrendIntervalFieldTypeEnum.class)` 校验拦截
- **分钟级时间范围限制**：`interval = 1m` 时，时间范围必须 < 3 天（259200 秒），否则抛 `exception.param.error.timeRangeExceeded`
- **logTypes 必填且最多 60 个**：每个元素必须是 `AllLogTypeEnum` 合法值（如 `tcp` / `http` / `dns` / `network_security` 等）
- **aggFuncs 必填**：每个 aggFunc 含 `name`（聚合结果名称）和 `param`（聚合字段）
- **timeField 必填**：必须是 `LogTimeFieldTypeEnum` 合法值（`recordTimestamp` / `uploadTimestamp` / `insertTimestamp`）
- **跨表查询**：logTypes 决定查询的 ClickHouse 表集合，每张表名为 `{logType}_log`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 查询开始时间戳（秒级，10 位 Long）。当 interval=1m 时，与 endTimestamp 差值必须 < 3 天 | 1782604800 |
| endTimestamp | long | 是 | - | 查询结束时间戳（秒级，10 位 Long） | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，对应 LogTimeFieldTypeEnum：recordTimestamp / uploadTimestamp / insertTimestamp | "recordTimestamp" |
| logTypes | array[string] | 是 | - | 日志类型列表，1~60 个元素，每个元素必须是 AllLogTypeEnum 合法值（如 tcp、http、dns、network_security 等） | ["tcp", "http"] |
| filterParam | object | 否 | - | 其他过滤字段（OpenApiLogTrendFilterQo），见下方子结构 | {"srcIps": ["192.168.1.1"]} |
| aggBy | array[string] | 否 | - | 分组字段列表，**必须是本接口"⚠️ aggBy 字段高频踩坑"段落"推荐字段表"中列出的字段名**（如 `srcIp` / `dstIp` / `productType` / `vendor` / `manage` / `recordTimestamp` / `total` 等），**严禁传 `logType` / `logTypes` / `*` 等非推荐字段**。缺省时不分组（返回单条总趋势）。详见下方"⚠️ aggBy 字段高频踩坑（必读）" | ["srcIp"] |
| aggFuncs | array[AggFuncsDTO] | 是 | - | 聚合操作列表，每个元素含 name + param，至少 1 个。**`param` 必须是字段白名单内的真实字段名，且必须与 `timeField` 不同**（推荐 `uploadTimestamp` 或 `insertTimestamp`），**严禁传 `*`** | [{"name": "count", "param": "uploadTimestamp"}] |
| interval | string | 是 | - | 时间间隔，对应 TrendIntervalFieldTypeEnum（大小写敏感）：1m（分钟，小写 m）/1H（小时，大写 H）/1d（天，小写 d）/1M（月，大写 M） | "1H" |

#### timeField 枚举值说明（LogTimeFieldTypeEnum）

| value | 说明 |
|-------|------|
| recordTimestamp | 记录时间（CK 数据库时间字段） |
| uploadTimestamp | 上传时间 |
| insertTimestamp | 入库时间 |

#### interval 枚举值说明（TrendIntervalFieldTypeEnum，大小写敏感）

| value | 说明 | 秒数 | CK 函数 |
|-------|------|------|---------|
| 1m | 分钟（小写 m） | 60 | toStartOfMinute |
| 1H | 小时（**大写 H**） | 3600 | toStartOfHour |
| 1d | 天（小写 d） | 86400 | toStartOfDay |
| 1M | 月（**大写 M**） | 2592000 | toStartOfMonth |

> **重要**：interval 大小写敏感。常见错误：写成 `1h`（小写 h）会被 `@Enum` 校验拦截返回错误。

#### logTypes 枚举值说明（AllLogTypeEnum，部分常用值）

| value | 说明 |
|-------|------|
| network_security | 网络安全日志 |
| endpoint_security | 端点安全日志 |
| endpoint_behavior | 端点行为日志 |
| http | HTTP |
| dns | DNS |
| tcp | TCP |
| icmp | ICMP |
| ftp | FTP |
| ftp_login | FTP 登录 |
| ssh | SSH |
| telnet_login | Telnet 登录 |
| smtp | SMTP |
| smtp_login | SMTP 登录 |
| pop3 | POP3 |
| imap | IMAP |
| rdp | RDP |
| smb | SMB |
| mysql | MySQL |
| oracle | Oracle |
| sql_server | SQL Server |
| redis | Redis |
| mongo | MongoDB |
| ... | 完整列表见 AllLogTypeEnum 源码（共 40+ 种） |

#### filterParam 子结构说明（OpenApiLogTrendFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| srcIps | array[string] | 否 | - | 源 IP 列表，每个元素需匹配 IPv4 或 IPv6 正则（CommonConstants.BanIpConstants.IPV4_V6） | ["192.168.233.233"] |
| dstIps | array[string] | 否 | - | 目的 IP 列表，每个元素需匹配 IPv4 或 IPv6 正则 | ["19.19.8.10"] |

#### aggFuncs 元素结构说明（AggFuncsDTO）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| name | string | 否 | - | 聚合结果名称（输出趋势项的标识） | "count" |
| param | string | 否 | - | 聚合字段，**必须是字段白名单内的真实字段名，且必须与 `timeField` 不同**（推荐 `uploadTimestamp` 或 `insertTimestamp`，三个时间列所有日志表都有）。**严禁传 `"*"`**，详见下方"⚠️ param 字段高频踩坑（必读）" | "uploadTimestamp" |

#### ⚠️ param 字段高频踩坑（必读）

`aggFuncs.param` **必须是与 `aggBy` 同源白名单中的真实字段名**（即上方"aggBy 推荐字段"表中的字段名，加 `"total"`），**且必须与 `timeField` 不同**，**严禁传 `"*"`、`"logType"` 等非白名单值**。

**白名单规则**：trends 接口的 `aggFuncs.param` 与 `aggBy` 共用同一份字段白名单（即下方"⚠️ aggBy 字段高频踩坑"段落"推荐字段表"中列出的字段 + `"total"`）。`"*"` 不在白名单内。

**失败模式**：
- 非法字段 → 后端抛 `IllegalArgumentException: unsafe field: *` → 被服务端吞掉 → 对外只透出 **500 "请求失败"**。
- **`param` 与 `timeField` 相同** → 后端 SQL 不生成 `COUNT(...) AS count` 聚合列 → 下游补零逻辑读不到计数 → 空指针 → 对外只透出 **500 "请求失败"**。timeField 用 `recordTimestamp` 时，param **严禁**再用 `recordTimestamp`。
- Bean Validation **不拦截** `param`（QO 类无实体字段校验），非法字段会通过参数校验直接进入 DAO 层才报错——**不能依赖 400 错误预防**。

**错误反例**：
```json
{
  "aggFuncs": [{"name": "count", "param": "*"}],
  ...
}
→ 500 "请求失败"
（根因："*" 不在白名单）
```

```json
{
  "timeField": "recordTimestamp",
  "aggFuncs": [{"name": "count", "param": "recordTimestamp"}],
  ...
}
→ 500 "请求失败"（服务端日志：NPE countUnsigned is null）
（根因：param 与 timeField 相同，SQL 未生成计数列）
```

**正确做法**：`param` 传一个**与 `timeField` 不同**的真实字段名（推荐 `uploadTimestamp` 或 `insertTimestamp`，三个时间列所有日志表都有），最终 SQL 形如 `COUNT(uploadTimestamp) AS count`。

**注意**：trends 接口 SQL 固定写死为 `COUNT(param) AS count`，`aggFuncs` 元素的 `name` 字段在 SQL 构造时被忽略，但 QO 校验仍要求每个元素含 `name` + `param`；`name` 可传任意标识符（如 `"count"`）用于结果项命名。

#### ⚠️ aggBy 字段高频踩坑（必读）

**白名单规则**：`aggBy` 每个元素必须是下表"aggBy 推荐字段"列里的字段名，外加字符串 `"total"`。其他任何字符串（包括 `logType` / `logTypes` / `*` / 自由命名）都会被后端白名单拦截。

**失败模式**：
- 非法字段 → 后端抛 `IllegalArgumentException: unsafe field: XXX` → 被服务端吞掉 → 对外只透出 **500 "请求失败"**。
- 原始错误只在服务端日志按 `traceId` 可见，调用方无法从响应判断根因。
- Bean Validation **不拦截** `aggBy`（QO 类无 `@Pattern` / `@Enum` 校验），非法字段会通过参数校验直接进入 DAO 层才报错——**不能依赖 400 错误预防**。

**常见错误反例**：
```json
{
  "logTypes": ["tcp", "http"],
  "aggBy": ["logType"]
}
→ 500 "请求失败"
（根因：logType 不在白名单。要"按日志类型对比趋势"，见下方"按日志类型对比"段落）
```

**aggBy 推荐字段（白名单内有分组语义的字段，按维度分类）**：

| 维度类别 | 字段名 | 含义 | 备注 |
|----------|--------|------|------|
| 设备维度 | `productType` | 上报设备类型 | 如 SIP / 探针，推荐 |
| 设备维度 | `vendor` | 设备厂商 | 推荐 |
| 设备维度 | `manage` | 上报设备 ID | 推荐 |
| 网络维度 | `srcIp` | 源 IP | 推荐 |
| 网络维度 | `dstIp` | 目的 IP | 推荐 |
| 网络维度 | `srcPort` | 源端口 | 端口基数大，分组膨胀快，谨慎 |
| 网络维度 | `dstPort` | 目的端口 | 同上 |
| 地理维度 | `srcCountry` / `srcProvince` / `srcCity` | 源地理位置 | 视日志类型而定 |
| 地理维度 | `dstCountry` / `dstProvince` / `dstCity` | 目的地理位置 | 同上 |
| 协议维度 | `l4Protocol` / `l7Protocol` | 4/7 层协议 | 推荐 |
| 安全维度 | `action` | 动作（0/1/2/3） | **要求目标 ClickHouse 表有 action 列**，部分表缺失则 500 |
| 安全维度 | `severity` | 严重性 | **要求目标表有 severity 列** |
| 安全维度 | `confidence` / `riskLevel` | 置信度/风险等级 | 视日志类型而定 |
| 时间维度 | `recordTimestamp` / `uploadTimestamp` / `insertTimestamp` | 时间字段 | 所有日志表都有这三列；`aggFuncs.param` 可任选其一，但**必须与 `timeField` 不同**（推荐 timeField=recordTimestamp + param=uploadTimestamp） |
| 特殊 | `total` | 字符串字面量 | 仅用于计数场景，不做分组维度 |

> **ClickHouse 列依赖**：上表字段即使白名单允许，执行还要求 `business.{logType}_log` 表里有对应列。`action` / `severity` 在部分日志类型表里可能缺失，缺失时返回 ClickHouse `Missing columns` 错误（透出仍是 500 "请求失败"）。**调用方无可靠方法预判某张表是否有此列**，建议先用小时间范围 + 单 logType 试探。

**按日志类型对比趋势**（`logType` 不在白名单，**不能直接用 `aggBy: ["logType"]`**）：
- 调用方分多次请求，每次 `logTypes` 只传一种类型、缺省 `aggBy`，每次返回单条总趋势，客户端拼接对比；
- 这是后端白名单限制，非文档遗漏。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiTrendResult） |

### data 结构说明（OpenApiTrendResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[ItemDTO] | 趋势数据列表，每个元素对应一个 aggBy 分组；aggBy 缺省时只有 1 个元素 |

### ItemDTO 结构说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| name | string | 分组键名（aggBy 缺省时为总趋势名） |
| item | array[Items] | 时间桶数组 |

### Items 结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 时间桶名（秒级时间戳字符串） | 秒级时间戳 | "1782604800" |
| value | integer | 时间桶内日志条数 | >= 0 | 1280 |

## 调用示例

### 示例1：按小时统计最近 7 天 TCP + HTTP 日志总量趋势

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["tcp", "http"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1H"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "name": "count",
        "item": [
          { "name": "1782604800", "value": 320 },
          { "name": "1751072400", "value": 410 },
          { "name": "1751076000", "value": 380 }
        ]
      }
    ]
  }
}
```

### 示例2：按分钟级统计 1 天内 SSH 登录日志趋势（应急响应场景）

**请求示例**：
```json
{
  "startTimestamp": 1783123200,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["ssh"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1m"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "name": "count",
        "item": [
          { "name": "1783123200", "value": 5 },
          { "name": "1751587260", "value": 12 },
          { "name": "1751587320", "value": 8 }
        ]
      }
    ]
  }
}
```

### 示例3：按天统计 30 天源 IP 维度日志分布趋势（aggBy 分组）

> ⚠️ 早期文档此示例曾用 `aggBy: ["logType"]` 演示"按日志类型分组对比"，但 `logType` 不在 trends 接口的 aggBy 白名单（详见上方"⚠️ aggBy 字段高频踩坑"段落），实际调用会抛 `unsafe field: logType` 并透出 500 "请求失败"。如需按日志类型对比，请分多次请求，每次 `logTypes` 只传一种类型、缺省 `aggBy`。

**请求示例**：
```json
{
  "startTimestamp": 1749072000,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["tcp", "http", "dns", "smtp"],
  "aggBy": ["srcIp"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1d"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "name": "192.168.1.10",
        "item": [
          { "name": "1749072000", "value": 12800 },
          { "name": "1749158400", "value": 13500 }
        ]
      },
      {
        "name": "10.0.0.5",
        "item": [
          { "name": "1749072000", "value": 8200 },
          { "name": "1749158400", "value": 9100 }
        ]
      }
    ]
  }
}
```

### 示例4：按源 IP 过滤 + 按天统计 7 天趋势

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["network_security"],
  "filterParam": {
    "srcIps": ["192.168.233.233"]
  },
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1d"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "name": "count",
        "item": [
          { "name": "1782604800", "value": 75 },
          { "name": "1751155200", "value": 60 },
          { "name": "1751241600", "value": 90 }
        ]
      }
    ]
  }
}
```

### 示例5：按月统计 6 个月日志趋势（长期报表）

**请求示例**：
```json
{
  "startTimestamp": 1738368000,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["tcp"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1M"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "name": "count",
        "item": [
          { "name": "1738368000", "value": 320000 },
          { "name": "1740787200", "value": 410000 }
        ]
      }
    ]
  }
}
```

### 示例6：错误响应示例（interval 大小写错误）

**请求示例**（写成小写 1h）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["tcp"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1h"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "param interval is invalid value.",
  "data": null
}
```

### 示例7：错误响应示例（分钟级时间范围超 3 天）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": ["tcp"],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1m"
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "exception.param.error.timeRangeExceeded",
  "data": null
}
```

### 示例8：错误响应示例（logTypes 为空）

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "recordTimestamp",
  "logTypes": [],
  "aggFuncs": [{"name": "count", "param": "uploadTimestamp"}],
  "interval": "1H"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "logTypes cannot be empty",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp` / `endTimestamp` 必填，秒级 10 位 Long
- `timeField` 必填，仅 `recordTimestamp` / `uploadTimestamp` / `insertTimestamp` 三选一
- `logTypes` 必填，1~60 个元素，每个元素必须是 AllLogTypeEnum 合法值
- `aggFuncs` 必填，至少 1 个元素
- `interval` 必填，仅 `1m` / `1H` / `1d` / `1M` 四选一（大小写敏感）
- `interval = 1m` 时时间范围必须 < 3 天
- `filterParam.srcIps` / `filterParam.dstIps` 每个元素需匹配 IPv4 或 IPv6 正则

### 参数依赖关系
- `startTimestamp` 必须小于等于 `endTimestamp`，否则抛 `exception.param.error`
- `interval = 1m` 与 `startTimestamp/endTimestamp` 范围强耦合：差值 < 259200 秒
- `aggBy` 与 `aggFuncs` 共同决定输出结构：`aggBy` 决定分组数量，`aggFuncs` 决定每组的聚合指标

### 权限要求
- 需具备 `superAdmin`、`incidentQuery`、`alertQuery` 三者任一权限

### 性能建议
- 分钟级查询时间范围不超过 3 天，否则会被业务规则拦截
- 跨多张日志表（logTypes 多）查询时性能会下降，建议按需选择必要日志类型
- 长期趋势建议使用 `1d` 或 `1M` 间隔，避免分钟级导致数据量过大
- aggBy 分组字段过多会导致返回数据膨胀，建议按需选择 1~2 个分组维度

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：2026-07-05 00:00:00 UTC = 1783209600，2026-06-28 00:00:00 UTC = 1782604800，2026-07-04 00:00:00 UTC = 1783123200，2026-06-05 00:00:00 UTC = 1749072000，2026-02-01 00:00:00 UTC = 1738368000
- 返回 `name` 字段为秒级时间戳字符串，按 interval 对齐：
  - 1m：对齐到整分钟
  - 1H：对齐到整小时
  - 1d：对齐到本地时区零点
  - 1M：对齐到当月 1 号 0 点

### 使用注意事项
- **interval 大小写敏感**：`1H` 必须大写 H，`1M` 必须大写 M。常见错误：写成 `1h` 会被 `@Enum` 校验拦截返回 `param interval is invalid value.`
- **分钟级时间范围限制**：`interval = 1m` 时时间范围必须 < 3 天，否则抛 `exception.param.error.timeRangeExceeded`
- **零填充逻辑**：返回的时间桶序列会按 interval 自动补零，确保时间轴完整。但若 ClickHouse 完全无数据，则返回 `item: []`，不会补零
- **跨表查询**：logTypes 决定查询的 ClickHouse 表集合，每张表名为 `{logType}_log`，最多同时查 60 张表
- **aggFuncs 内容**：`name` 用于标识输出趋势项名称，`param` 用于指定聚合的真实字段名（必须与 `timeField` 不同，**严禁 `*`**——`*` 不在白名单，传了会 500）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | logTypes cannot be empty | logTypes 为空 | 至少传 1 个日志类型 |
| 400 | logTypes must contain at least one element and at most 60 elements | logTypes 元素数 < 1 或 > 60 | 元素数控制在 1~60 |
| 400 | param logTypes is invalid value. | logTypes 元素不是 AllLogTypeEnum 合法值 | 改为合法日志类型（如 tcp、http、dns） |
| 400 | param timeField is invalid value. | timeField 不是 LogTimeFieldTypeEnum 合法值 | 改为 recordTimestamp / uploadTimestamp / insertTimestamp |
| 400 | param interval is invalid value. | interval 不是 TrendIntervalFieldTypeEnum 合法值（含大小写错误） | 改为 1m / 1H / 1d / 1M，注意大小写 |
| 500 | exception.param.error | startTimestamp > endTimestamp | 修正时间范围 |
| 500 | exception.param.error.timeRangeExceeded | interval=1m 但时间范围 >= 3 天 | 缩小时间范围或改用 1H/1d |
| 400 | param srcIp is invalid | filterParam.srcIps 元素不是合法 IPv4/IPv6 | 校正 IP 格式 |
| 400 | param dstIp is invalid | filterParam.dstIps 元素不是合法 IPv4/IPv6 | 校正 IP 格式 |
| 500 | exception.method.execute（服务端日志：`IllegalArgumentException: unsafe field: XXX`） | aggBy 或 aggFuncs.param 不在 trends 接口字段白名单（详见上方"⚠️ aggBy 字段高频踩坑"段落中的推荐字段表 + `"total"`） | 改为推荐字段表内字段名（如 `srcIp` / `dstIp` / `recordTimestamp` / `vendor` / `productType` / `manage` / `total`），**严禁传 `logType` / `logTypes` / `*`** | 凭 traceId 联系管理员取服务端日志确认被拦截的具体字段名 |
| 500 | exception.method.execute | 数据库查询异常（非白名单拦截） | 检查时间范围是否过大、logTypes 是否合理，联系管理员 | 凭 traceId 联系管理员取服务端日志确认根因 |
| 500 | exception.method.execute（服务端日志：NPE `countUnsigned is null`） | `aggFuncs.param` 与 `timeField` 相同，SQL 未生成计数列 | `param` 改为与 `timeField` 不同的字段（推荐 timeField=recordTimestamp + param=uploadTimestamp） | 凭 traceId 联系管理员取服务端日志确认根因 |

## 最佳实践

1. **interval 选型**：分钟级（1m）用于应急响应精确定位，小时级（1H）用于日报，天级（1d）用于周报月报，月级（1M）用于长期趋势
2. **时间范围匹配**：1m 配 1 天内、1H 配 7 天内、1d 配 90 天内、1M 配 1 年内，避免超范围被拦截或性能过差
3. **logTypes 精简**：只传业务关心的日志类型，跨 60 张表查询会显著影响性能
4. **aggBy 维度**：单维度（如按 `srcIp`）对比不同源 IP 的日志量级；双维度（如 `srcIp` + `dstIp`）做更细的下钻，但维度越多返回数据越膨胀。**严禁用 `logType` 做 aggBy**（不在白名单，会 500）
5. **filterParam 使用**：在应急响应时先按 srcIps 锁定可疑源 IP，再查趋势，避免被海量日志淹没
6. **空结果处理**：返回 `item: []` 表示 ClickHouse 完全无数据，需检查 timeField 和 logTypes 是否匹配
7. **跨时区注意**：天级和月级按本地时区对齐，跨时区对接时需注意时区差异
8. **大小写务必正确**：interval 的 `1H` 和 `1M` 必须大写字母，是常见踩坑点
