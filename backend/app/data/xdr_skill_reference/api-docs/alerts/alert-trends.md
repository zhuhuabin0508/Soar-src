# POST /api/xdr/v1/alerts/trends

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 趋势统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/alerts/aggregation` 告警聚合、`/api/xdr/v1/alerts/list` 告警列表、`/api/xdr/v1/alerts/ipinfosstats` 双维度聚合 |

## 接口概述

获取安全告警趋势图统计结果，按时间间隔（interval）分桶聚合告警数，支持按 aggBy 分组字段拆分多条曲线，可多维度过滤（资产组、源IP、告警状态、严重等级、时间范围等）。返回每个时间桶的告警数，按时间戳（秒级）排序，缺失时间桶自动补零。**适用于按时间维度分析告警分布趋势的场景**——如"最近 7 天告警趋势"、"按小时聚合的告警分布"等。

## 使用场景

- 按时间分布的告警趋势统计（最近 N 天/小时/月）
- 按分组字段拆分多条时间曲线（如不同资产组的告警趋势对比）
- 时间分桶聚合（按分钟/小时/天/月统计告警数）
- 大屏态势感知的告警时间线展示

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/trends |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

> Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/alerts/trends`（不写入对外文档）

## 请求参数

### 顶层参数（OpenApiAlertTrendQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 起始时间，秒级时间戳 |
| endTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 结束时间，秒级时间戳 |
| timeField | String | 是 | — | 见 timeField 枚举表 | 过滤的时间字段 |
| filterParam | Object | 否 | — | 见 filterParam 子结构 | 其他过滤字段 |
| fuzzyParam | Object | 否 | — | 见 fuzzyParam 子结构 | 模糊参数 |
| excludeParam | Object | 否 | — | 见 excludeParam 子结构 | 排除字段 |
| aggBy | Array<String> | 否 | — | Alert.class 字段名（见 aggBy 白名单） | 分组字段，传多个时按多维度拆分曲线 |
| aggFuncs | Array<Object> | 是 | — | 见 aggFuncs 子结构 | 聚合操作 |
| interval | String | 是 | — | 见 interval 枚举表（大小写敏感） | 时间间隔 |
| timeZone | String | 否 | 用户时区 | IANA 时区标识 | 时区，缺省时取当前用户时区 |

### timeField 枚举（AlertTimeFieldTypeEnum）

| 取值 | 说明 |
|------|------|
| firstTime | 告警首次发生时间 |
| lastTime | 告警最后发生时间 |
| updateTime | 告警更新时间 |
| dealTime | 告警处置时间 |
| occurTime | 告警发生时间 |
| uploadTime | 告警上传时间 |
| _insertTime | 告警入库时间 |

### interval 枚举（TrendIntervalFieldTypeEnum，大小写敏感）

| 取值 | 说明 | 注意 |
|------|------|------|
| 1m | 每分钟 | 小写 m |
| **1H** | 每小时 | **大写 H**（不是小写 h；小写 h 会被 DAO default 分支吞掉返回空） |
| 1d | 每天 | 小写 d |
| **1M** | 每月 | **大写 M** |

### aggBy 白名单

aggBy 字段名必须使用 `Alert.class` 实体类的字段名（Service 层校验：`Alert.class.getDeclaredFields()`）。常见可用字段：`severity`、`dealStatus`、`srcIp`、`hostBranchId`、`assetId` 等。**不允许凭语义推测**（如把"告警等级"写成 `alertSeverity`，实际应为 `severity`）。若 aggBy 中的字段不在 Alert.class 中，Service 会返回空结果并打警告日志。

### filterParam 子结构（OpenApiAlertTrendFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| alertDealStatus | Array<Integer> | 否 | — | 处置状态枚举值 | 处置状态（数据库字段：dealStatus） |
| accessDirections | Array<Integer> | 否 | — | 访问方向枚举值 | 访问方向（数据库字段：dirction） |
| **hostBranchIds** | Array<Integer> | 否 | — | 资产组 ID 列表 | 资产组 id（数据库字段：hostBranchId），**注意复数 s**（来自 `@JsonProperty("hostBranchIds")`） |
| platformHostBranchIds | Array<String> | 否 | — | 平台资产组 ID 列表 | 平台资产组 id |
| platformIds | Array<String> | 否 | — | 平台 ID 列表 | 平台 id |
| hostBusinessIds | Array<Integer> | 否 | — | 业务 ID 列表 | 所属业务（数据库字段：hostGroupIds） |
| platformHostBusinessIds | Array<String> | 否 | — | 平台业务 ID 列表 | 所属业务平台（数据库字段：platformHostGroupIds） |
| severities | Array<Integer> | 否 | — | 告警等级枚举值 | 告警等级（数据库字段：severity），复数 |
| whiteStatus | Array<String> | 否 | — | 加白状态枚举值（中文环境传国际化值，国际版传数字） | 加白状态 |
| devUids | Array<Integer> | 否 | — | 数据源 ID 列表 | 数据源 id（数据库字段：devUId） |
| alarmClassifications | Array<String> | 否 | [] | 告警分类 ID 字符串数组。元素格式 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`（数字 ID，逗号分隔，最多 3 级）。**严禁传中文名**——后端会逐段 `Integer.parseInt`，传 `"web攻击"` 会抛 NumberFormatException 导致 500。详见 enum-dictionary-pending.md 第 10 节 | `["1"]` 或 `["1,2,3"]` |
| attackResults | Array<Integer> | 否 | — | 攻击结果枚举值 | 攻击结果 |
| assetIds | Array<String> | 否 | — | 资产 ID 列表 | 资产 id（数据库字段：assetId） |
| hostIps | Array<String> | 否 | — | 主机 IP 列表 | 主机 ip（数据库字段：hostIp） |
| gptResults | Array<Integer> | 否 | — | GPT 研判结果枚举值 | gpt 研判结果（数据库字段：gptResult） |
| srcBranchIds | Array<Integer> | 否 | — | 源资产组 ID 列表 | 源资产组 id（数据库字段：srcIpInfos.branchId） |
| dstBranchIds | Array<Integer> | 否 | — | 目的资产组 ID 列表 | 目的资产组 id（数据库字段：dstIpInfos.branchId） |
| srcCountryNames | Array<String> | 否 | — | 国家名称列表，最多 10 个 | 攻击源（数据库字段：countryName），复数 |
| devSourceNames | Array<String> | 否 | — | 设备来源名称列表 | 设备来源名称 |
| srcIps | Array<String> | 否 | — | 源 IP 列表 | 攻击源（数据库字段：srcIp），复数 |

### fuzzyParam 子结构（OpenApiAlertTrendFuzzyParam）

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| alertName | Object | 否 | — | 告警名称模糊搜索（OpenApiFuzzyParamGroupQo） |

### excludeParam 子结构（OpenApiAlerTrendExcludeQo）

排除字段，结构与 filterParam 类似（含告警等级、状态等排除条件）。具体字段参考 OpenApiAlerTrendExcludeQo.java。

### aggFuncs 子结构（AggFuncsDTO）

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | String | 是 | 聚合结果名称，最长 64 字符 |
| func | String | 是 | 聚合操作名称，源码支持 `count`/`cardinality`/`avg`/`max`/`min`/`sum`（**不是 ES 原生函数名如 value_count**），最长 64 字符 |
| param | String | 是 | 聚合字段，传 `uuId` 时 Service 会自动改为 `name`；传 `_id` 时会被自动替换为 `name`（避免 ES 性能问题） |

## 返回参数（OpenApiTrendResult）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| item | Array<Object> | 数据列表，每个元素含 name（分组名）和 item（时间桶列表） |

### item 元素结构（ItemDTO）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| name | String | 分组名（aggBy 字段值；无 aggBy 时为告警名称国际化文案） |
| item | Array<Object> | 时间桶列表 |

### item.item 元素结构（Items）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| name | Long | 时间戳（秒级，10 位 Long） |
| value | Integer | 告警数 |

## 业务逻辑

### 核心处理流程

1. **时间范围补全**：Controller 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 对入参时间戳做补全处理（如缺省时取最近 7 天）
2. **时区处理**：timeZone 为空时取当前用户时区（`UserInfoShareHolder.getUserInfo().getTimeZone()`）
3. **aggBy 字段校验**：将 aggBy 字段名与 `Alert.class.getDeclaredFields()` 比对，任一字段不存在则返回空结果并打警告日志（`Security Alarm Trend Chart - Some grouping fields do not exist in the database`）
4. **aggFuncs._id 替换**：若 aggFuncs.param 含 `_id`，自动替换为 `name`（避免 ES 性能问题）
5. **DAO 查询**：调用 `alertDao.getAlertTrendResult(qo)` 执行 ES 时间分桶聚合
6. **结果组装**：
   - 若 aggBy 为空：name 用告警名称国际化文案，value 用 count
   - 若 aggBy 非空：name 用 `aggBy[0] + "keyAsString"` 字段值，value 用 `aggBy[0] + "Cnt"` 字段值
7. **时间桶补零**：缺失的时间桶自动补 0，按时间戳升序排序
8. **时间戳格式化**：DAO 返回的日期字符串经 `parseTimestamp()` 转秒级时间戳（10 位 Long）回填 VO

### 默认行为

- startTimestamp/endTimestamp 缺省时由 `OpenApiTimeRangeUtil` 补全（典型为最近 7 天）
- timeZone 缺省时取用户时区

### 特殊规则

- **interval 大小写敏感**：`1m`/`1H`/`1d`/`1M`（H 和 M 大写）；写成小写 `1h` 会被 DAO default 分支吞掉返回空
- **aggBy 字段名约束**：必须用 `Alert.class` 实体类字段名，不能用凭语义推测的字段名
- **aggFuncs.param._id 自动替换**：传 `_id` 会被自动改为 `name`

## 数据一致性说明

- **入参与返回时间戳均为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：当前时间 2026-07-05 00:00:00 UTC，最近 7 天起始时间戳为 `1782499200`（10 位秒级）

## 调用示例

### 示例 1：最近 7 天告警趋势，按小时聚合

```json
POST /api/xdr/v1/alerts/trends
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "interval": "1H",
  "aggFuncs": [
    {
      "name": "count",
      "param": "*"
    }
  ]
}
```

返回示例：

```json
{
  "item": [
    {
      "name": "告警",
      "item": [
        {"name": 1782499200, "value": 12},
        {"name": 1750966800, "value": 5},
        {"name": 1750970400, "value": 8}
      ]
    }
  ]
}
```

### 示例 2：按资产组分组的告警趋势，按天聚合

```json
POST /api/xdr/v1/alerts/trends
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "interval": "1d",
  "aggBy": ["hostBranchId"],
  "aggFuncs": [
    {
      "name": "count",
      "param": "*"
    }
  ],
  "filterParam": {
    "hostBranchIds": [101, 102]
  }
}
```

### 示例 3：错误响应示例 - interval 大小写错误

**请求示例**（interval 写成小写 1h）：
```json
POST /api/xdr/v1/alerts/trends
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "interval": "1h",
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "*"
    }
  ]
}
```

**错误响应示例**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "item": []
  }
}
```

> **说明**：interval 大小写敏感，`1h`（小写 h）会被 DAO default 分支吞掉返回空结果——必须使用 `1H`（大写 H）。

### 示例 4：错误响应示例 - aggBy 字段名非法

**请求示例**（aggBy 写了凭推测的字段名 alertSeverity）：
```json
POST /api/xdr/v1/alerts/trends
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "interval": "1H",
  "aggBy": ["alertSeverity"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "*"
    }
  ]
}
```

**错误响应示例**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "item": []
  }
}
```

> **说明**：aggBy 字段不在 `Alert.class.getDeclaredFields()` 中时，Service 不报错，返回空结果并打警告日志 `Security Alarm Trend Chart - Some grouping fields do not exist in the database`——必须使用实体类字段名（如 `severity`）。

### 示例 5：错误响应示例 - 权限不足

**请求示例**（无 superAdmin/alertQuery 权限的 token 调用）：
```json
POST /api/xdr/v1/alerts/trends
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "interval": "1H",
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "*"
    }
  ]
}
```

**错误响应示例**：
```json
{
  "code": 403,
  "message": "Access Denied",
  "data": null
}
```

## 使用注意事项

1. **interval 大小写敏感**：`1H`（大写 H）和 `1M`（大写 M），不是 `1h`/`1m`
2. **aggBy 字段名**：必须用 `Alert.class` 实体类字段名（如 `severity`、`dealStatus`、`hostBranchId`），不能用凭推测的字段名（如 `alertSeverity`）
3. **filterParam 字段名**：复数字段（`hostBranchIds`、`severities`、`srcIps`、`srcCountryNames` 等）从 `@JsonProperty` 提取，不能写成单数
4. **时间戳单位**：入参与返回均为秒级（10 位 Long），不是毫秒级
5. **timeField 必填**：必须传 `firstTime`/`lastTime`/`updateTime`/`dealTime`/`occurTime`/`uploadTime`/`_insertTime` 之一

## 关联接口

- `alert-list.md`：分页查询告警明细列表（无时间分桶）
- `alert-aggregation.md`：按字段分组聚合统计（无时间分桶）
- `alert-ipinfosstats.md`：按源IP+国家双维度聚合

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | param startTimestamp min is 0 | startTimestamp 小于 0 | 设置 startTimestamp >= 0 |
| 400 | param endTimestamp min is 0 | endTimestamp 小于 0 | 设置 endTimestamp >= 0 |
| 400 | param timeField is invalid | timeField 非 AlertTimeFieldTypeEnum 合法值 | 使用 firstTime/lastTime/updateTime/dealTime/occurTime/uploadTime/_insertTime 之一 |
| 400 | param interval is invalid | interval 非 TrendIntervalFieldTypeEnum 合法值 | 使用 1m/1H/1d/1M（注意大小写敏感） |
| 400 | param aggBy is invalid | aggBy 字段不在 Alert.class.getDeclaredFields() 中 | 使用实体类字段名（如 severity、dealStatus、hostBranchId），不凭推测 |
| 400 | param aggFuncs.func is invalid | aggFuncs.func 非源码支持的值 | 使用 count/cardinality/avg/max/min/sum，不用 ES 原生函数名 |
| 400 | param hostBranchIds size out of range | filterParam.hostBranchIds 超过 10 个元素 | 减少元素数量至 10 个以内 |
| 400 | param srcCountryNames size out of range | filterParam.srcCountryNames 超过 10 个元素 | 减少元素数量至 10 个以内 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端查询执行异常 | 联系技术支持，检查 ES 集群状态 |

> **特殊提示**：
> - interval 写成小写 `1h`/`1m`（H/M 应大写）：不返回 400 错误，而是被 DAO default 分支吞掉返回空结果 `data.item: []`
> - aggBy 字段名非法：不返回 400 错误，返回空结果并打警告日志 `Security Alarm Trend Chart - Some grouping fields do not exist in the database`
> - 业务上需自行检查返回是否为空判断 interval/aggBy 是否正确

## 最佳实践

1. **interval 大小写必须严格匹配**
   - 正确：`1m`（分，小写 m）、`1H`（时，大写 H）、`1d`（天，小写 d）、`1M`（月，大写 M）
   - 错误：`1h`、`1s`——会被 DAO default 分支吞掉返回空结果，不报错
   - 这是本接口最容易踩坑的点，调用前先校验大小写

2. **aggBy 字段名验证**
   - 必须用 `Alert.class` 实体类字段名（如 `severity`、`dealStatus`、`hostBranchId`、`srcIp`）
   - 不能凭语义推测（如把"告警等级"写成 `alertSeverity`，实际应为 `severity`）
   - 字段名非法时不报错只返回空，需自行检查返回结果

3. **timeField 必填**
   - 必须传 `firstTime`/`lastTime`/`updateTime`/`dealTime`/`occurTime`/`uploadTime`/`_insertTime` 之一
   - 不传或传错会返回 400 错误

4. **aggFuncs 三字段缺一不可**
   - `name`：聚合结果字段名（自定义，最长 64 字符）
   - `func`：聚合操作（必须用源码值 `count`/`cardinality`/`avg`/`max`/`min`/`sum`）
   - `param`：聚合字段（传 `uuId` 会被自动改为 `name`；传 `_id` 会被自动改为 `name` 避免 ES 性能问题）

5. **timeZone 缺省行为**
   - 不传 timeZone 时取当前用户时区（`UserInfoShareHolder.getUserInfo().getTimeZone()`）
   - 跨时区场景建议显式传 IANA 时区标识（如 `Asia/Shanghai`、`UTC`）

6. **缺失时间桶自动补零**
   - DAO 返回的日期字符串经 `parseTimestamp()` 转秒级时间戳回填 VO
   - 缺失时间桶自动补 0，按时间戳升序排序
   - 大屏时间线展示可直接使用，无需自行补零

7. **filterParam 复数字段**
   - `hostBranchIds`、`severities`、`srcIps`、`srcCountryNames` 等均带复数 s
   - 从 `@JsonProperty` 提取，不能写成单数

8. **时间戳单位统一**
   - 入参与返回均为秒级（10 位 Long），不是毫秒级
   - 返回的 `item.item[].name` 字段为秒级时间戳
   - 示例值按"当前时间 - N 天"算出，不允许凭空编数字

9. **配合 aggregation 接口使用**
   - 需要时间分桶走本接口（trends）
   - 需要按字段分组聚合走 `/api/xdr/v1/alerts/aggregation`
   - 需要多维度（源IP+国家）走 `/api/xdr/v1/alerts/ipinfosstats`
   - 三个聚合接口的 aggBy/aggFuncs 字段名规则一致，可复用调用代码
