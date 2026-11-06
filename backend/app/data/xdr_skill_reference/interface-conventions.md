# 接口调用约定（强制核对清单）

生成接口调用方案前**必须**读取本文件，并在方案中严格按本文件的约定填写。以下约定均来自项目源码核对，不允许凭推测或凭接口文档字面意思填写。

## 1. 接口 URL 路径格式

OpenAPI 接口有**两层路径**——对外调用路径和 Spring 内部部署路径。**方案中填写的是对外调用路径**。

### 1.1 对外调用路径（写入方案和接口文档标题）

所有 OpenAPI 接口的对外调用 URL 统一格式为：

```
/api/xdr/v1/{业务域}/{子路径}
```

- **必须以 `/api/xdr/v1/` 为前缀**
- 业务域与子路径从对应 Controller 类的 `@RequestMapping`（类级）+ `@PostMapping`/`@GetMapping`（方法级）注解组合得出后做前缀替换
- **示例**：`/api/xdr/v1/alerts/list`、`/api/xdr/v1/incidents/aggregation`、`/api/xdr/v1/analysislog/count`

### 1.2 Spring 内部部署路径（不写入方案，仅供源码定位参考）

所有 OpenAPI 接口的 Spring 内部部署 URL 统一格式为：

```
/ngsoc/INCIDENT/api/v1/openapi/{业务域}/{子路径}
```

- 这是 Controller 类级 `@RequestMapping` 注解的实际值，给运维/SRE 看路由用
- **不写入方案、不写入接口文档标题**

### 1.3 路径双层映射规则

把 Spring 内部路径的 `/ngsoc/INCIDENT/api/v1/openapi/` 整段替换为 `/api/xdr/v1/`，业务域和子路径保持不变。无业务域重命名（alerts→alerts、analysislog→analysislog、incidents→incidents、riskassets→riskassets）。

### 1.4 真实 URL 真相表（从 Controller 注解核对）

| 业务域 | QO 类 | 对外调用路径 | Spring 内部路径 |
|---|---|---|---|
| 告警列表 | `OpenApiAlertQo` | `/api/xdr/v1/alerts/list` | `/ngsoc/INCIDENT/api/v1/openapi/alerts/list` |
| 告警聚合 | `OpenApiAlertAggQo` | `/api/xdr/v1/alerts/aggregation` | `/ngsoc/INCIDENT/api/v1/openapi/alerts/aggregation` |
| 告警趋势 | `OpenApiAlertTrendQo` | `/api/xdr/v1/alerts/trends` | `/ngsoc/INCIDENT/api/v1/openapi/alerts/trends` |
| 告警源IP+国家双维度聚合 | `OpenApiAlertAggQo` | `/api/xdr/v1/alerts/ipinfosstats` | `/ngsoc/INCIDENT/api/v1/openapi/alerts/ipinfosstats` |
| 告警 ipInfos（IP 详情） | `OpenApiAlertIpInfosQo` | `/api/xdr/v1/alerts/ipInfos` | `/ngsoc/INCIDENT/api/v1/openapi/alerts/ipInfos` |
| 事件列表 | `IncidentsListQo` | `/api/xdr/v1/incidents/list` | `/ngsoc/INCIDENT/api/v1/openapi/incidents/list` |
| 事件聚合 | `OpenApiIncidentAggQo` | `/api/xdr/v1/incidents/aggregation` | `/ngsoc/INCIDENT/api/v1/openapi/incidents/aggregation` |
| 事件趋势 | `OpenApiIncidentTrendQo` | `/api/xdr/v1/incidents/trends` | `/ngsoc/INCIDENT/api/v1/openapi/incidents/trends` |
| 安全日志 count | `OpenApiDeviceLogQo` | `/api/xdr/v1/analysislog/count` | `/ngsoc/INCIDENT/api/v1/openapi/analysislog/count` |
| 网络安全日志聚合 | `OpenApiNetworkSecurityLogAggQo` | `/api/xdr/v1/analysislog/networksecurity/aggregation` | `/ngsoc/INCIDENT/api/v1/openapi/analysislog/networksecurity/aggregation` |
| 风险资产列表 | `OpenApiRiskAssetQo` | `/api/xdr/v1/riskassets/list` | `/ngsoc/INCIDENT/api/v1/openapi/riskassets/list` |
| 风险资产聚合 | `OpenApiRiskAssetAggQo` | `/api/xdr/v1/riskassets/aggregation` | `/ngsoc/INCIDENT/api/v1/openapi/riskassets/aggregation` |
| 风险资产趋势 | `OpenApiRiskAssetTrendQo` | `/api/xdr/v1/riskassets/trends` | `/ngsoc/INCIDENT/api/v1/openapi/riskassets/trends` |

**重要**：方案中只写对外调用路径。不要写成 `/ngsoc/INCIDENT/api/v1/openapi/...`（这是 Spring 内部路径，不对外）。

## 2. 时间戳单位

### 2.1 入参时间戳（startTimestamp / endTimestamp 等时间字段）

**所有 OpenAPI 接口入参时间戳均为秒级（10 位 Long）**，证据：
- `OpenApiAlertAggQo.startTimestamp` `@Max(value = 9999999999L)` —— 10 位秒级上限（毫秒级应为 13 位）
- `IncidentQo` 字段 `@ApiModelProperty` 描述明确写"秒级时间戳"
- DAO 层查询时统一 `* 1000L` 转毫秒给 ES，或直接用秒给 MongoDB

**生成方案时填具体值**：必须填 10 位秒级时间戳，例如：
- 2026-06-28 00:00:00 UTC → `1751068800`（秒级）
- 不要写 `1751068800000`（毫秒级）或 `1711065600`（错误年份）

**示例值规则**：方案中给的时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳。算不出时标注"以实际调用时为准，秒级时间戳"，不要随便编一个数字。

### 2.2 返回值时间戳

**所有 OpenAPI 接口返回值时间字段也是秒级（10 位 Long）**，证据：
- AlertVo.firstTime/lastTime/dealTime/createTime/updateTime：DAO 从 ES 拿毫秒后 `/1000` 转秒回填
- Incident 实体 startTime/endTime/updateTime/disposeTime：写入时 `System.currentTimeMillis() / 1000`
- 趋势接口返回的 `name`（时间戳）：Service 层把 ES 日期字符串解析为秒级时间戳

**方案中标注**：返回值时间字段说明列写"时间戳（秒级，Long）"，示例值用 10 位数字。

## 3. 趋势接口 interval 参数

`OpenApiAlertTrendQo.interval` / `OpenApiIncidentTrendQo.interval` 字段为枚举 String，**大小写敏感**：

| 含义 | 取值 | 备注 |
|---|---|---|
| 分钟 | `1m` | 小写 m |
| 小时 | `1H` | **大写 H**（不是小写 h） |
| 天 | `1d` | 小写 d |
| 月 | `1M` | **大写 M** |

证据：`TrendIntervalFieldTypeEnum` 枚举定义，Alert 趋势 DAO switch 同样 4 值（default 分支返回空结果并打警告日志）。

**常见错误**：写成 `1h`（小写 h）会被 Alert 趋势接口 default 分支吞掉返回空。务必写 `1H`。

## 4. sort 参数格式

聚合/列表接口的 `sort` 字段统一格式为：

```
{字段名或别名}:{排序方向}
```

- 冒号 `:` 分隔，**不是空格**
- 多字段用逗号 `,` 分隔
- 方向：`asc` / `desc`

证据：DAO 屢用 `sortItem.split(":")` 解析，`parts[0]`=字段、`parts[1]`=方向。

**示例**：`logCount:desc`、`count:asc`、`logCount:desc,srcIp:asc`

**常见错误**：写成 `logCount desc`（空格分隔）会被解析失败。

## 5. 易混淆入参字段名（必须从源码核对）

以下字段在生成方案时容易写错，必须按本表填值：

| 接口 | 字段语义 | 真实字段名 | 证据 |
|---|---|---|---|
| 告警趋势 filterParam | 资产组 ID | `hostBranchIds`（复数） | QO 类 `@JsonProperty("hostBranchIds")` |
| 事件聚合 aggBy | 事件等级 | `severity`（不是 incidentSeverity） | Incident 实体类字段名为 `severity`；Service 屢 aggBy 校验白名单为 Incident 字段名 |
| 事件聚合 filterParam | 事件等级过滤 | `severities`（复数） | QO 类 `@JsonProperty("severities")` |
| 网络安全日志聚合 filterParam | 源国家 | `srcCountryNames`（不是 srcCountry） | QO 类 `@JsonProperty("srcCountryNames")` |
| 告警聚合 / 双维度聚合 filterParam | 源国家 | `srcCountryNames` | QO 类 `@JsonProperty("srcCountryNames")` |
| 告警聚合 / 双维度聚合 filterParam | 源 IP | `srcIps` | QO 类 `@JsonProperty("srcIps")` |

**强制规则**：方案中填写的任何请求参数字段名**必须从对应 QO 类（含 @JsonProperty 注解）核对**，不允许凭语义推测。例如想表达"事件等级"时，必须先去 `OpenApiIncidentAggQo` / `OpenApiIncidentAggFilterQo` / `Incident` 实体类里确认字段名是 `severity` 还是 `incidentSeverity`，再填值。

## 6. 入参字段必须存在的核对原则

**禁止**在方案中添加任何 QO 类中不存在的入参字段。生成方案时：

1. 找到接口对应 QO 类（含内嵌 FilterQo / ExcludeQo / FuzzyParamQo 等）
2. 读取该 QO 类所有 `@JsonProperty` 注解的字段名
3. 方案中填写的每个请求参数都必须能在 QO 类中找到对应的 `@JsonProperty` 值
4. 若需求涉及的过滤条件在 QO 类中找不到对应字段——明确告知"该过滤条件当前接口不支持"，不要凭推测添加

**常见错误**：
- 把语义相近但实际不存在的字段名写进方案（如 `incidentSeverity` 在事件聚合接口中不存在）
- 把单数字写成复数或反之（如 `hostBranchId` vs `hostBranchIds`，必须按 @JsonProperty 实际值）

## 7. 按"需求产出形状"选接口（避免重复调用 list）

当需求是"按某枚举字段统计多个分组的总数"时（如"待处置总数、处置中总数、处置完成总数"），**用一次聚合接口按该枚举字段分组**，`limit=枚举总数`，一次拿到所有分组计数。

**禁止**为每个枚举值分别调用 list 接口取 `total`——这会发起 N 次请求且性能差。

**正确做法**：
- 需求"待处置/处置中/处置完成总数" → 调聚合接口一次，`aggBy=dealStatus`，`aggFuncs=[{name:"count", func:"count", param:"*"}]`，`limit=3`（dealStatus 枚举总数）
- 一次返回 3 个分组桶，对应待处置/处置中/处置完成

**选型优先级**（性能从低到高）：list < 聚合 < 趋势。需求只需一个数时用 list；按维度分组统计用聚合；按时间分布用趋势。

## 8. 接口文档与源码冲突时以源码为准

`references/api-docs/*.md` 中的接口文档可能滞后或错误。当文档与本文件的约定冲突时，**以本文件为准**（本文件已从源码核对）。当本文件未覆盖某场景时，去源码（QO 类、Controller 类、DAO 层、实体类、枚举类）核对后再填方案。
