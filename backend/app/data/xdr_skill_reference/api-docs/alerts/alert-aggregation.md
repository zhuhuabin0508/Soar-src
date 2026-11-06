# POST /api/xdr/v1/alerts/aggregation

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/alerts/trends` 趋势统计、`/api/xdr/v1/alerts/list` 告警列表、`/api/xdr/v1/alerts/ipinfosstats` 双维度聚合（多维度聚合走此接口） |

## 接口概述

获取安全告警聚合查询结果，按 aggBy 字段分组聚合统计告警数（或对其他字段做 count/sum/avg/max/min 等聚合），支持多维度过滤（资产组、源IP、告警状态、严重等级、时间范围等）和排序。**通用聚合接口 aggBy 只传一个字段**（业务约束），多维度聚合需求（如按源IP+国家双维度）请走 `/api/xdr/v1/alerts/ipinfosstats` 接口。**适用于按单一维度分组统计 Top N、按枚举字段分布统计的场景**——如"按资产组聚合 Top 10"、"按处置状态统计待处置/处置中/处置完成总数"等。

## 使用场景

- Top N 统计（按资产组聚合 Top 10 告警数最多的资产组）
- 按枚举字段分布统计（按 dealStatus 统计待处置/处置中/处置完成总数，一次聚合返回所有桶）
- 按单一维度分组计数（按严重等级统计告警数）
- 按时间字段范围过滤后聚合（最近 7 天按源IP聚合 Top 5）

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

> Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/alerts/aggregation`（不写入对外文档）

## 请求参数

### 顶层参数（OpenApiAlertAggQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| startTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 起始时间，秒级时间戳 |
| endTimestamp | Long | 是 | — | 0 ~ 9999999999（10 位秒级时间戳） | 结束时间，秒级时间戳 |
| timeField | String | 是 | — | 见 timeField 枚举表 | 过滤的时间字段 |
| filterParam | Object | 否 | — | 见 filterParam 子结构 | 其他过滤字段 |
| fuzzyParam | Object | 否 | — | 见 fuzzyParam 子结构 | 模糊参数 |
| excludeParam | Object | 否 | — | 见 excludeParam 子结构 | 排除字段 |
| aggBy | Array<String> | 否 | — | Alert.class 字段名（见 aggBy 白名单）；**业务约束：通用聚合只传 1 个字段** | 分组字段 |
| aggByAlias | Array<String> | 否 | — | 自定义分组别名 | 分组别名 |
| aggFuncs | Array<Object> | 是 | — | 见 aggFuncs 子结构 | 聚合操作 |
| sort | String | 否 | — | 见 sort 格式 | 排序方法 |
| limit | Integer | 否 | 5 | 1 ~ 各 QO 最大值（不传默认 5，会静默截断） | TOP 数量。**未传时默认 5 会静默截断分组结果且不报错**——聚合字段为已知有限枚举时传枚举总数，非已知枚举时让业务方给出 N，不要传超大值绕过截断 |

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

### aggBy 白名单

aggBy 字段名必须使用 `Alert.class` 实体类的字段名（Service 层校验：`Alert.class.getDeclaredFields()`）。常见可用字段：`severity`、`dealStatus`、`srcIp`、`hostBranchId`、`assetId`、`attackResult` 等。**不允许凭语义推测**（如把"告警等级"写成 `alertSeverity`，实际应为 `severity`）。**业务约束：通用聚合接口 aggBy 只传一个字段**——多维度聚合需求走 `/api/xdr/v1/alerts/ipinfosstats` 接口。

### sort 格式

- 格式：`fieldName:asc` 或 `fieldName:desc`，**冒号分隔**（不是空格）
- 多字段用逗号分隔：`field1:asc,field2:desc`
- 示例：`logCount:desc`、`count:asc`
- **常见错误**：写成 `logCount desc`（空格分隔）会被解析失败

### filterParam 子结构（OpenApiAlertAggFilterQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| alertDealStatus | Array<Integer> | 否 | — | 处置状态枚举值 | 处置状态（数据库字段：dealStatus） |
| alertDealActions | Array<String> | 否 | [] | 处置动作枚举值 | 处置动作（数据库字段：dealAction） |
| accessDirections | Array<Integer> | 否 | — | 访问方向枚举值 | 访问方向（数据库字段：dirction） |
| assetIds | Array<String> | 否 | — | 资产 ID 列表 | 资产 id（数据库字段：assetId） |
| hostIps | Array<String> | 否 | — | 主机 IP 列表 | 主机 ip（数据库字段：hostIp） |
| gptResults | Array<Integer> | 否 | — | GPT 研判结果枚举值 | gpt 研判结果（数据库字段：gptResult） |
| **hostBranchIds** | Array<Integer> | 否 | — | 资产组 ID 列表 | 资产组 id（数据库字段：hostBranchId），**复数 s** |
| platformHostBranchIds | Array<String> | 否 | — | 平台资产组 ID 列表 | 平台资产组 id |
| threatDefines | Array<Integer> | 否 | — | 告警定性枚举值 | 告警定性（数据库字段：threatDefine） |
| hostBusinessIds | Array<Integer> | 否 | — | 业务 ID 列表 | 所属业务（数据库字段：hostGroupIds） |
| platformHostBusinessIds | Array<String> | 否 | — | 平台业务 ID 列表 | 所属业务平台（数据库字段：platformHostGroupIds） |
| platformIds | Array<String> | 否 | — | 平台 ID 列表 | 平台 id |
| severities | Array<Integer> | 否 | — | 告警等级枚举值 | 告警等级（数据库字段：severity），复数 |
| read | Boolean | 否 | — | true/false | 告警是否已读 |
| whiteStatus | Array<String> | 否 | — | 加白状态枚举值（中文环境传国际化值，国际版传数字） | 加白状态 |
| manages | Array<String> | 否 | — | 上报设备 ID 列表 | 上报设备 ID |
| devUids | Array<Integer> | 否 | — | 数据源 ID 列表 | 数据源 |
| attackResults | Array<Integer> | 否 | — | 攻击结果枚举值 | 攻击结果（数据库字段：attackResult） |
| **srcCountryNames** | Array<String> | 否 | — | 国家名称列表，最多 10 个 | 攻击源（数据库字段：countryName），**复数** |
| engineNames | Array<String> | 否 | — | 检测引擎名称列表，最多 10 个 | 检测引擎（数据库字段：engineName） |
| srcProvinceName | Array<String> | 否 | — | 省份名称列表，最多 10 个 | 省份（数据库字段：provinceName） |
| **srcIps** | Array<String> | 否 | — | 源 IP 列表 | 攻击源（数据库字段：srcIp），复数 |
| dstIps | Array<String> | 否 | — | 目的 IP 列表 | 目的 IP（数据库字段：dstIp） |
| dstIpsClassify1idList | Array<Integer> | 否 | — | 目的 IP 资产类型列表 | 目的 IP 资产类型 |
| stages | Array<Integer> | 否 | — | 告警阶段列表 | 告警阶段 |
| alarmClassifications | Array<String> | 否 | [] | 告警分类 ID 字符串数组。元素格式 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`（数字 ID，逗号分隔，最多 3 级）。**严禁传中文名**——后端会逐段 `Integer.parseInt`，传 `"web攻击"` 会抛 NumberFormatException 导致 500。详见 enum-dictionary-pending.md 第 10 节 | `["1"]` 或 `["1,2,3"]` |
| alertNames | Array<String> | 否 | — | 告警名称列表 | 告警名称 |
| proofType | Array<String> | 否 | — | 举证类型列表 | 举证类型 |
| combineType | Array<Integer> | 否 | — | 组合类型列表 | 组合类型 |
| devSourceNames | Array<String> | 否 | — | 设备来源名称列表 | 设备来源名称 |
| dstCountryNames | Array<String> | 否 | — | 目的 ip 国家列表，最多 10 个 | 目的 ip 国家 |
| dstBranchIds | Array<Integer> | 否 | — | 目的 IP 资产组列表 | 目的 IP 资产组（数据库字段：dstIpInfos.branchId） |
| attckTechniques | Array<String> | 否 | — | ATTCK 技术列表 | ATTCK 技术 |

### fuzzyParam 子结构（OpenApiAlertAggFuzzyParam）

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| alertName | Object | 否 | 告警名称模糊搜索（OpenApiFuzzyParamGroupQo） |

### excludeParam 子结构（OpenApiAlertAggExcludeQo）

排除字段，结构与 filterParam 类似。具体字段参考 OpenApiAlertAggExcludeQo.java。

### aggFuncs 子结构（AggFuncsDTO）

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | String | 是 | 聚合结果名称，最长 64 字符 |
| func | String | 是 | 聚合操作名称，源码支持 `count`/`cardinality`/`avg`/`max`/`min`/`sum`（**不是 ES 原生函数名如 value_count**），最长 64 字符 |
| param | String | 是 | 聚合字段名（**必须是 Alert 实体类真实存在的字段名，不能传 `*`**）。`func: count` 时推荐传 `name`（对应 ES `value_count` 按字段计数，传 `*` 会因 ES 无此字段而返回空结果）；`cardinality` 传任意真实字段；`avg/max/min/sum` 传数值型字段。告警聚合接口传 `uuId` 时会被自动改为 `name`，最长 64 字符 |

## 返回参数（OpenApiAlertAggResult）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| item | Array<Object> | 聚合桶列表 |
| meta | Array<Object> | 聚合元信息，**实测恒返回**。形如 `[{"name":"<aggBy[0]>","type":"Integer"},{"name":"<aggFuncs[0].name>","type":"Integer"}]`，随请求的 aggBy / aggFuncs 变化。type 标示该列的值类型 |
| sumOtherDocCount | Long | 未进入 Top N 的合计文档数（可用于判断是否被截断） |
| total | Long | 文档数。**⚠️ 实测未返回**：`total` 是原文档凭推测写出的字段，3 组 200 成功响应中 `data` 均无 `total`，调用方不要依赖它 |

### item 元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| {aggBy[0] 原文} | 视字段而定 | 分组键，**键名即请求 `aggBy` 第一个字段的原文**（如 `hostBranchId`/`severity`/`dealStatus`），值类型为 Integer（部分字段可能为字符串，以实际字段类型为准） |
| {aggFuncs[].name} | Object | 各 aggFuncs 对应的聚合结果字段，**键名即请求中 `aggFuncs[].name` 指定的名称**（如 `count`），非固定字段名 |
| branchName | String | 资产组名称，**仅 `aggBy=hostBranchId` 时附带返回**，其他 aggBy 不返回 |

## 业务逻辑

### 核心处理流程

1. **时间范围补全**：Controller 调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 对入参时间戳做补全处理
2. **aggBy 字段校验**：Service 将 aggBy 字段名与 `Alert.class.getDeclaredFields()` 比对，任一字段不存在则返回空结果
3. **aggFuncs 字段替换**：若 aggFuncs.param 含 `uuId`，自动改为 `name`（告警聚合接口的特殊规则）
4. **DAO 查询**：调用 `alertDao.getAlertAggResult(qo)` 执行 ES 聚合查询
5. **结果组装**：ES Aggregation 解析为 VO 桶列表，含 name（分组值）、count（文档数）、各 aggFuncs 聚合结果字段
6. **截断处理**：limit 控制返回桶数，未传时默认 5 会静默截断（sumOtherDocCount 表示未进入 Top N 的合计）

### 默认行为

- startTimestamp/endTimestamp 缺省时由 `OpenApiTimeRangeUtil` 补全
- limit 缺省时取 5（**会静默截断分组结果且不报错**）

### 特殊规则

- **aggBy 单字段业务约束**：通用聚合接口 aggBy 只传一个字段，多维度聚合走 `/api/xdr/v1/alerts/ipinfosstats` 接口
- **aggFuncs.param 必须传真实字段名**：`param` 被源码当作 ES 聚合的 field 名（`count`→`value_count`、`cardinality`→`cardinality`、`avg/max/min/sum`→对应数值聚合）。传 `"*"` 会因 ES 无此字段而返回空结果（`item: []`），**任何 func 下都不能传 `"*"`**。`func: count` 时推荐传 `name`（告警实体普遍存在的字段）
- **aggFuncs.param.uuId 自动替换**：传 `uuId` 会被自动改为 `name`（告警聚合接口特殊规则）
- **aggFuncs.func 必须用源码支持的值**：`count`/`cardinality`/`avg`/`max`/`min`/`sum`，不是 ES 原生函数名（如 `value_count`）
- **sort 冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，不是空格分隔
- **aggBy 字段名约束**：必须用 `Alert.class` 实体类字段名，不能用凭推测的字段名

## 数据一致性说明

- **入参与返回时间戳均为秒级（10 位 Long）**
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字
- 示例：当前时间 2026-07-05 00:00:00 UTC，最近 7 天起始时间戳为 `1782499200`（10 位秒级）

## 调用示例

### 示例 1：按资产组聚合 Top 10 告警数

```json
POST /api/xdr/v1/alerts/aggregation
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["hostBranchId"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "name"
    }
  ],
  "sort": "count:desc",
  "limit": 10
}
```

### 示例 2：按处置状态分布统计（一次聚合返回所有桶）

```json
POST /api/xdr/v1/alerts/aggregation
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["dealStatus"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "name"
    }
  ],
  "limit": 3
}
```

返回示例：

```json
{
  "item": [
    {"dealStatus": 40, "count": 120},
    {"dealStatus": 50, "count": 45},
    {"dealStatus": 10, "count": 230}
  ],
  "meta": [
    {"name": "dealStatus", "type": "Integer"},
    {"name": "count", "type": "Integer"}
  ],
  "sumOtherDocCount": 0
}
```

> **说明**：item 分组键名即请求 `aggBy[0]` 的原文（此处为 `dealStatus`），非固定 `name`；聚合结果键名即 `aggFuncs[].name`（此处为 `count`）。`total` 实测未返回，已删。

### 示例 3：错误响应示例 - aggBy 字段名非法

**请求示例**（aggBy 写了凭推测的字段名 alertSeverity）：
```json
POST /api/xdr/v1/alerts/aggregation
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["alertSeverity"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "name"
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
    "item": [],
    "meta": [],
    "sumOtherDocCount": 0
  }
}
```

> **说明**：aggBy 字段不在 `Alert.class.getDeclaredFields()` 中时，Service 不报错，返回空结果（业务约束：必须用实体类字段名，如 `severity` 而非 `alertSeverity`）。

### 示例 4：错误响应示例 - sort 格式错误（空格分隔）

**请求示例**（sort 用空格而非冒号）：
```json
POST /api/xdr/v1/alerts/aggregation
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["hostBranchId"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "name"
    }
  ],
  "sort": "count desc"
}
```

**错误响应示例**：
```json
{
  "code": 400,
  "message": "param sort is invalid",
  "data": null
}
```

> **说明**：sort 必须使用冒号分隔（`count:desc`），不能用空格。

### 示例 5：错误响应示例 - 权限不足

**请求示例**（无 superAdmin/alertQuery 权限的 token 调用）：
```json
POST /api/xdr/v1/alerts/aggregation
{
  "startTimestamp": 1782499200,
  "endTimestamp": 1782604800,
  "timeField": "lastTime",
  "aggBy": ["severity"],
  "aggFuncs": [
    {
      "name": "count",
      "func": "count",
      "param": "name"
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

1. **aggBy 单字段业务约束**：通用聚合接口 aggBy 只传一个字段；多维度聚合（如按源IP+国家）走 `/api/xdr/v1/alerts/ipinfosstats` 接口
2. **aggBy 字段名**：必须用 `Alert.class` 实体类字段名（如 `severity`、`dealStatus`、`hostBranchId`），不能用凭推测的字段名
3. **aggFuncs.func**：用源码支持的值（`count`/`cardinality`/`avg`/`max`/`min`/`sum`），不是 ES 原生函数名
4. **aggFuncs.param**：`param` 是 `Alert` 实体类真实字段名，**任何 func 下都不能传 `"*"`**（ES 无 `*` 字段会返回空结果）；`func: count` 时推荐传 `name`；传 `uuId` 会被自动改为 `name`（告警聚合接口特殊规则）
5. **filterParam 字段名**：复数字段（`hostBranchIds`、`severities`、`srcIps`、`srcCountryNames` 等）从 `@JsonProperty` 提取，不能写成单数
6. **sort 冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，不是空格分隔
7. **limit 不省略**：未传时默认 5 会静默截断分组结果且不报错；聚合字段为已知有限枚举时传枚举总数，非已知枚举时让业务方给出 N，不要传超大值绕过截断
8. **时间戳单位**：入参与返回均为秒级（10 位 Long），不是毫秒级

## 关联接口

- `alert-trends.md`：按时间分桶聚合统计（趋势）
- `alert-list.md`：分页查询告警明细列表
- `alert-ipinfosstats.md`：按源IP+国家双维度聚合（多维度聚合走这个接口）

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 400 | param startTimestamp min is 0 | startTimestamp 小于 0 | 设置 startTimestamp >= 0 |
| 400 | param endTimestamp min is 0 | endTimestamp 小于 0 | 设置 endTimestamp >= 0 |
| 400 | param timeField is invalid | timeField 非 AlertTimeFieldTypeEnum 合法值 | 使用 firstTime/lastTime/updateTime/dealTime/occurTime/uploadTime/_insertTime 之一 |
| 400 | param aggBy is invalid | aggBy 字段不在 Alert.class.getDeclaredFields() 中 | 使用实体类字段名（如 severity、dealStatus、hostBranchId），不凭推测 |
| 400 | param aggFuncs.func is invalid | aggFuncs.func 非源码支持的值 | 使用 count/cardinality/avg/max/min/sum，不用 ES 原生函数名（如 value_count） |
| 400 | param sort is invalid | sort 格式错误（用了空格分隔） | 使用冒号分隔：`fieldName:asc` 或 `fieldName:desc` |
| 400 | param limit min is 1 | limit 小于 1 | 设置 limit >= 1 |
| 400 | param hostBranchIds size out of range | filterParam.hostBranchIds 超过 10 个元素 | 减少元素数量至 10 个以内 |
| 400 | param srcCountryNames size out of range | filterParam.srcCountryNames 超过 10 个元素 | 减少元素数量至 10 个以内 |
| 400 | param engineNames size out of range | filterParam.engineNames 超过 10 个元素 | 减少元素数量至 10 个以内 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端查询执行异常 | 联系技术支持，检查 ES 集群状态 |

> **特殊提示**：
> 1. aggBy 字段名非法时**不返回 400 错误**，而是返回 `code: 200, data.item: []` 空结果——业务上需自行检查返回是否为空判断 aggBy 是否正确。
> 2. `aggFuncs.param` 传 `"*"` 同样**不报错但返回空**（ES 无 `*` 字段，`item` 为 `[]`），与 aggBy 非法表现一致——必须传 `Alert` 实体类真实字段名（`count` 推荐 `name`），不能传 `"*"`。

## 最佳实践

1. **aggBy 只传一个字段**
   - 通用聚合接口业务约束：单字段分组；多维度（如源IP+国家）走 `/api/xdr/v1/alerts/ipinfosstats` 接口
   - 即使源码 `@Size(max = 8)` 允许 8 个，业务上也只传 1 个

2. **limit 传值的两种策略**
   - 聚合字段为已知有限枚举（如 dealStatus 4 个值）：limit 传枚举总数，避免静默截断
   - 聚合字段为非已知枚举（如 srcIp）：让业务方给出具体 N（如 Top 10），不要传超大值绕过截断
   - 始终不省略 limit，未传时默认 5 会静默截断且不报错

3. **aggBy 字段名验证**
   - 必须用 `Alert.class` 实体类字段名（如 `severity`、`dealStatus`、`hostBranchId`、`srcIp`）
   - 不能凭语义推测（如把"告警等级"写成 `alertSeverity`，实际应为 `severity`）
   - 字段名非法时不报错只返回空，需自行检查返回结果

4. **aggFuncs 三字段缺一不可**
   - `name`：聚合结果字段名（自定义，最长 64 字符）
   - `func`：聚合操作（必须用源码值 `count`/`cardinality`/`avg`/`max`/`min`/`sum`，不是 ES 原生函数名）
   - `param`：聚合字段（**必须传 `Alert` 实体类真实字段名，任何 func 下都不能传 `"*"`**；`func: count` 时推荐传 `name`；传 `uuId` 时会被自动改为 `name`）

5. **sort 用冒号分隔**
   - 正确：`count:desc`、`logCount:asc`
   - 错误：`count desc`（空格分隔会被解析失败）

6. **filterParam 复数字段**
   - `hostBranchIds`、`severities`、`srcIps`、`srcCountryNames`、`engineNames` 等均带复数 s
   - 从 `@JsonProperty` 提取，不能写成单数

7. **时间戳单位统一**
   - 入参与返回均为秒级（10 位 Long），不是毫秒级
   - 示例值按"当前时间 - N 天"算出，不允许凭空编数字

8. **配合 list 接口使用**
   - 先用本接口获取 Top N 分组结果
   - 再用 list 接口按 aggBy 字段值过滤查询明细
   - 避免 list 接口反复请求验证数据量
