# POST /api/xdr/v1/analysislog/networksecurity/aggregation

## 接口概述

本接口用于按指定字段分组聚合统计网络安全日志，支持 aggBy 分组、aggFuncs 聚合函数配置、limit 控制返回分组数。通过本接口，您可以获取以下内容：

### 可统计的聚合信息
- **分组统计列表**：按 aggBy 字段分组返回每组的聚合结果（如 count、sum、avg、cardinality 等）
- **元数据**：返回 meta 列表，描述每个返回字段的名称和类型
- **总分组数**：返回聚合结果的总分组数

### 可设置的过滤/聚合维度
- **时间范围**：startTimestamp / endTimestamp（秒级，必填）
- **时间字段**：timeField（必填，指定按哪个时间字段过滤）
- **过滤参数**：filterParam（srcCountryNames / srcProvinceNames / accessDirections）
- **排除参数**：excludeParam（srcCountryNames / srcProvinceNames / srcIps）
- **分组字段**：aggBy（多字段分组，建议只传 1 个字段）
- **聚合操作**：aggFuncs（必填，含 name + func + param）
- **排序方法**：sort（格式 `fieldName:asc` 或 `fieldName:desc`，多字段用逗号分隔）
- **TOP 数量**：limit（默认 5，未传时静默截断分组结果且不报错）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Controller | OpenApiAnalysisController |
| 所属业务域 | 流量审计日志开放性接口（analysislog） |
| 接口分类 | 网络安全日志聚合统计 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/analysislog/list` 审计日志列表、`/api/xdr/v1/analysislog/count` 设备数量与日志量统计、`/api/xdr/v1/analysislog/trends` 日志趋势统计 |

## 使用场景

1. **Top N 统计**：按 srcIp / dstIp / threatClass 等维度分组统计日志数，返回 Top N 高频源/目的 IP 或威胁分类
2. **按维度分组计数**：按特定枚举字段（如 severity / attackState / productType）分组统计日志数分布
3. **多维度聚合**：通过 aggFuncs 配置 count / sum / avg / cardinality 等聚合函数，获取每组的统计值
4. **境外攻击源 Top N**：通过 filterParam.srcCountryNames 过滤境外国家 + aggBy=srcIp 分组，获取境外攻击源 IP Top N
5. **威胁分类分布**：aggBy=threatClass 分组统计各级威胁分类的日志数分布
6. **按源 IP + 国家双维度聚合统计**：通过 filterParam 同时含 srcCountryNames 与按 srcIp 分组，可定位特定国家内的攻击源 IP 分布
7. **设备日志量分布**：aggBy=productType 分组统计各厂商设备的日志量
8. **配合 trends 接口做时序分析**：先用本接口获取分组分布，再用 trends 接口分析各分组的时间趋势

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/analysislog/networksecurity/aggregation |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery 或 alertQuery（三者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳并回写 QO
2. **Service 层时间校验**：检查 `startTimestamp <= endTimestamp`，否则抛 `START_TIME_LT_END_TIME` 异常
3. **日志记录**：`log.info("select network log startTimestamp = {}, endTimestamp = {}", start, end)` 记录查询条件
4. **查询 ClickHouse**：调用 `networkSecurityLogMapper.getNetworkSecurityLogAggResult(qo)` 执行聚合查询，由 DAO 层 SQL Provider 动态构造 SQL：
   - SELECT 子句：aggBy 字段 + aggFuncs 聚合表达式（如 `count(srcIp) AS logCount`）
   - WHERE 子句：timeField 时间范围过滤 + filterParam（srcCountry / srcProvince / accessDirections）+ excludeParam（NOT IN）
   - GROUP BY 子句：aggBy 字段
   - ORDER BY 子句：sort 字段（按 `fieldName:asc/desc` 解析）或默认按 aggFuncs[0].name DESC
   - LIMIT 子句：limit
5. **异常处理**：查询失败时抛 `exception.method.execute` 异常
6. **构造 meta**：基于 `NetworkSecurityLog.class` 和 `NetworkSecurityLogVo.class` 的 `getDeclaredFields()` 反射得到字段名 → 类型的映射，构造 meta 列表（aggBy 字段对应类型 + aggFuncs[0].name 对应 Integer）
7. **构造 item**：若 aggBy 非空，items 直接使用查询结果；若 aggBy 为空，构造单条 `{aggFuncs[0].name: count}` 计数
8. **limit 截断**：`if (aggLimit < items.size()) { items = items.subList(0, aggLimit) }`（静默截断，不报错）
9. **构造返回**：返回 `OpenApiAggResult`，含 meta + item 列表 + total（聚合前总分组数）

### 数据转换逻辑

- ClickHouse 查询返回 `List<Map<String, Object>>`，每条记录含 aggBy 字段值 + aggFuncs 聚合结果
- meta 列表通过反射 `NetworkSecurityLog.class` 和 `NetworkSecurityLogVo.class` 的 `getDeclaredFields()` 构造字段名 → 简单类型名的映射
- aggFuncs[0].name 在 meta 中固定标记为 Integer 类型
- total 为聚合前查询结果的总分组数（截断前）

### 默认行为

- startTimestamp / endTimestamp 必填（@NotNull），不指定返回 400 错误
- timeField 必填（@NotNull），不指定返回 400 错误
- aggFuncs 必填（@NotEmpty），不指定返回 400 错误
- **aggBy 必传（实际行为）**：缺省 aggBy 时 Service 用"查询结果行数"当计数值，而聚合 SQL 无 GROUP BY 恒返回 1 行——返回的"总数"**恒为 1**，不是真实总数。要拿真实分组计数必须传 aggBy
- **sort 建议必传（实际行为）**：sort 缺省时 SQL 用 `aggFuncs[0].name`（自定义别名，如 logCount）按真实列名做白名单校验，别名不在字段白名单 → 抛异常 → 500 "请求失败"。**传 sort 则只做格式校验，安全**。建议始终显式传 `sort: "<aggFuncs[0].name>:desc"`
- limit 默认值 5，未传时静默截断分组结果且不报错

### 特殊规则

- **aggBy 字段必须使用实体类字段名**：从 `NetworkSecurityLog.class` 和 `NetworkSecurityLogVo.class` 的 `getDeclaredFields()` 提取白名单。常用字段：srcIp / dstIp / srcPort / dstPort / threatClass / threatType / threatSubType / productType / vendor / severity / attackState / l7Protocol / l4Protocol / l3Protocol / srcCountry / srcProvince / dstCountry / dstProvince / srcIpTag / dstIpTag / srcType / srcSubType / dstType / dstSubType / action / tactic / technique / confidence / riskLevel / white / engineName / recordTimestamp 等
- **aggBy 字段数约束（业务规则）**：通用聚合接口 aggBy 只传一个字段，多维度聚合请使用其他接口或在 aggBy 中组合少量字段。源码未强制单字段，但业务上推荐单字段分组
- **aggFuncs 必填**：每个 aggFunc 含 name（聚合结果名称，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN）+ func（聚合操作名称，必填，最长 64）+ param（聚合字段，必填，最长 64）
- **aggFuncs 支持的 func 值**：count / sum / avg / max / min / stddev（DAO 层白名单校验，**不支持 cardinality / value_count**，传了会 500）
- **sort 格式**：`fieldName:asc` 或 `fieldName:desc`，多字段用逗号分隔（如 `logCount:desc,srcIp:asc`）。分隔符为冒号 `:`，不是空格
- **timeField 必填**：指定按哪个时间字段过滤，需为合法时间字段名（如 recordTimestamp / uploadTimestamp / insertTimestamp）
- **filterParam vs excludeParam**：filterParam 是包含条件（IN），excludeParam 是排除条件（NOT IN）；excludeParam 额外支持 srcIps 字段，filterParam 无 srcIps 字段
- **accessDirections 过滤**：filterParam.accessDirections 取值 1/2/3（AttackDirectionEnum），通过 srcIpTag + dstIpTag 组合实现
- **limit 默认值 5 静默截断**：未传 limit 或传较小值时，超过 limit 的分组结果会被静默截断，不报错也不返回剩余数据
- **地域权限过滤**：根据当前用户的地域权限自动过滤可见数据
- **时间戳校验**：startTimestamp / endTimestamp 最小 1，最大 9999999999（10 位秒级）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 查询开始时间戳，秒级（10 位 Long），最小 1，最大 9999999999 | 1782576000 |
| endTimestamp | long | 是 | - | 查询结束时间戳，秒级（10 位 Long），最小 1，最大 9999999999。必须 >= startTimestamp | 1783180800 |
| timeField | string | 是 | - | 过滤的时间字段。需为合法时间字段名（如 recordTimestamp / uploadTimestamp / insertTimestamp） | "recordTimestamp" |
| aggBy | array[string] | 否 | - | 分组字段列表，元素需为 NetworkSecurityLog / NetworkSecurityLogVo 实体类字段名（如 srcIp / dstIp / threatClass / severity / attackState / productType 等）。建议只传 1 个字段 | ["srcIp"] |
| aggFuncs | array[AggFuncsDTO] | 是 | - | 聚合操作列表，至少 1 个元素。见下方 AggFuncsDTO 结构 | [{"name":"logCount","func":"count","param":"srcIp"}] |
| sort | string | 否 | -（强烈建议必传） | 排序方法，格式 `fieldName:asc` 或 `fieldName:desc`，多字段用逗号分隔。**缺省时别名会被当真实列名做白名单校验导致 500**（见下方"⚠️ sort 缺省陷阱"），建议始终显式传 `"<aggFuncs[0].name>:desc"` | "logCount:desc" |
| limit | integer | 否 | 5 | TOP 数量，最小 1。注意：未传时默认值会静默截断分组结果且不报错；请按 OpenAPI 接口选型推荐指南传值——聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N。不要传超大值绕过截断 | 10 |

#### filterParam 结构说明（来源：OpenApiNetworkSecurityLogAggFilterQo）

filterParam 为包含条件过滤对象，递归展开内部字段如下：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | array[string] | 否 | 攻击源国家名称 | ["中国", "美国"] |
| srcProvinceNames | array[string] | 否 | 攻击源省份名称 | ["广东", "北京"] |
| accessDirections | array[integer] | 否 | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md）。中文：0/无, 1/内对外, 2/外对内, 3/内对内；国际版：0/1/2/3 | [1, 2] |

#### excludeParam 结构说明（来源：NetworkSecurityLogExcludeQo）

excludeParam 为排除条件过滤对象，递归展开内部字段如下：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| srcCountryNames | array[string] | 否 | 排除攻击源国家名称 | ["中国"] |
| srcProvinceNames | array[string] | 否 | 排除攻击源省份名称 | ["广东"] |
| srcIps | array[string] | 否 | 排除源 IP 列表（excludeParam 独有字段，filterParam 无此字段） | ["1.1.1.1"] |

> **注意**：JSON 字段名以 @JsonProperty 注解值为准。filterParam/excludeParam 中所有嵌套字段均按此规则提取（如 srcCountryNames 不是 srcCountry）。

#### AggFuncsDTO 结构说明（来源：QO 类 AggFuncsDTO）

| 参数名 | 类型 | 必填 | 说明 | 取值范围 | 示例值 |
|--------|------|------|------|----------|--------|
| name | string | 否 | 聚合结果名称（输出字段名），最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | 最长 64 | "logCount" |
| func | string | 是 | 聚合操作名称，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | count / sum / avg / max / min / stddev（**不支持 cardinality**） | "count" |
| param | string | 是 | 聚合字段，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN | **必须为 `NetworkSecurityLog` / `NetworkSecurityLogVo` 实体类真实声明的字段名（如 `srcIp`、`dstIp`、`recordTimestamp`、`severity`、`threatClass` 等）**。严禁传 `*`、`srcIp` 之外的 IP 字段名以外的占位符，详见下方"⚠️ param 字段高频踩坑（必读）" | "srcIp" |

**常见 func 值说明**：

| func 值 | 说明 | 示例 param |
|---------|------|------------|
| count | 计数 | 真实字段名（如 `srcIp`） |
| sum | 求和 | 数值字段名 |
| avg | 平均值 | 数值字段名 |
| max | 最大值 | 字段名 |
| min | 最小值 | 字段名 |
| stddev | 标准差 | 数值字段名 |

> **不支持 cardinality（去重计数）**：DAO 层白名单里没有该函数，传了会 500 "请求失败"。需要去重计数时无替代方案，请在客户端自行估算或联系后端评估扩展。

#### ⚠️ param 字段高频踩坑（必读）

`aggFuncs.param` **必须是 `NetworkSecurityLog` 或 `NetworkSecurityLogVo` 实体类真实声明的字段名**，任何 func 下都**严禁传 `"*"`**。

**原因**：SQL Provider 构造 SELECT 子句时会调用 DAO 层白名单校验 `safeField(func.getParam())`，该方法在白名单校验失败时：

```java
public static String safeField(String field) {
    if (!SAFE_FIELDS.contains(field)) {
        throw new IllegalArgumentException("unsafe field: " + field);
    }
    return field;
}
```

`SAFE_FIELDS` 通过反射 `NetworkSecurityLog.class.getDeclaredFields()` + `NetworkSecurityLogVo.class.getDeclaredFields()` + `"total"` 构造，**`"*"` 永远不在白名单中** → 抛 `IllegalArgumentException("unsafe field: *")` → 冒泡到 Service 屢被捕获并包装为 `IncidentException(I18nUtils.i18n("exception.method.execute"))`，最终透出给客户端的错误信息是 **"请求失败"**，原始 `IllegalArgumentException` 只能在服务端 `log.error` 日志中按 `traceId` 检索看到。

**错误反例**（已知踩坑）：
```json
{
  "aggFuncs": [{"name": "logCount", "func": "count", "param": "*"}],
  ...
}
→ 500 "请求失败"
→ 服务端日志: IllegalArgumentException("unsafe field: *")
```

**正确做法**：`func: "count"` 时传一个真实字段名（如 `srcIp`、`dstIp`、`recordTimestamp`），最终 SQL 形如 `COUNT(srcIp) AS logCount`。

**⚠️ 关于"总行数"的正确认识（必读）**：本接口**必须传 `aggBy`** 才能拿到有意义的计数。缺省 `aggBy` 时 Service 走 `countMap.put(aggFuncs[0].name, 查询结果行数)` 分支——而聚合 SQL 无 GROUP BY 恒返回 1 行，所以返回的"总数"**恒为 1，不是真实总行数**。若需要"不分组只看总量"，请改用 `/api/xdr/v1/analysislog/count` 接口，不要用本接口去掉 aggBy 的方式。

**Bean Validation 不拦截**：QO 类的 `AggFuncsDTO.param` 字段只有 `@NotBlank` + `@Size` + `@Pattern` 校验，没做实体字段校验，所以 `"*"` 通过参数校验进入 DAO 层才报错。skill 生成方案时必须**主动**核对 `NetworkSecurityLog` / `NetworkSecurityLogVo` 实体类字段名。

#### ⚠️ sort 缺省陷阱（必读）

**服务端行为**：sort 缺省时，SQL 生成器默认排序用 `aggFuncs[0].name`（调用方自定义的**别名**，如 `logCount`）走**真实列名白名单校验**。别名不是表里的真实列（如 `logCount` 不在字段白名单），校验必失败：

```
服务端日志：IllegalArgumentException("unsafe field: logCount")
对外透出：500 "请求失败"（exception.method.execute）
```

**失败模式**：
- 不传 sort 且 `aggFuncs[0].name` 是自定义别名（非真实字段名）→ 必现 500。
- Bean Validation 不拦截 sort，问题在 SQL 生成阶段才暴露——不能依赖 400 错误预防。
- 原始异常只在服务端日志按 traceId 可见。

**正确做法**：**始终显式传 `sort`**，值为 `"<aggFuncs[0].name>:desc"`（如 `aggFuncs[0].name=logCount` 时传 `sort: "logCount:desc"`）。传了 sort 走别名格式校验（只查合法字符），不做列名白名单校验，安全。

**错误反例**：
```json
{
    "aggBy": ["srcIp"],
    "aggFuncs": [{"name": "logCount", "func": "count", "param": "srcIp"}]
}
（未传 sort）
→ 500 "请求失败"
→ 服务端日志：IllegalArgumentException("unsafe field: logCount")
```

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | OpenApiAggResult | 响应数据，见下方结构说明 |

### OpenApiAggResult 结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| meta | array[OpenApiAggResultMeta] | 元数据列表，描述每个返回字段的名称和类型 | 见下方 meta 结构 |
| item | array[map] | 数据列表，每条记录含 aggBy 字段值 + aggFuncs 聚合结果 | 见下方 item 示例 |

### OpenApiAggResultMeta 结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 字段名称 | "srcIp" |
| type | string | 字段类型（来自实体类字段类型的简单类名，如 String / Integer / Long 等；aggFuncs[0].name 固定为 Integer） | "String" |

### item 元素结构说明

每个 item 为一个 Map<String, Object>，包含 aggBy 分组字段值和 aggFuncs 聚合结果。

**item 示例**（aggBy=["srcIp"], aggFuncs=[{name:"logCount", func:"count", param:"srcIp"}]）：
```json
{
    "srcIp": "192.168.1.100",
    "logCount": 580
}
```

## 调用示例

### 示例 1：按源 IP 分组统计日志数 Top 10

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggBy": ["srcIp"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 10
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "meta": [
            {
                "name": "srcIp",
                "type": "String"
            },
            {
                "name": "logCount",
                "type": "Integer"
            }
        ],
        "item": [
            {
                "srcIp": "192.168.1.100",
                "logCount": 1280
            },
            {
                "srcIp": "10.0.0.50",
                "logCount": 852
            },
            {
                "srcIp": "203.0.113.50",
                "logCount": 415
            }
        ]
    }
}
```

### 示例 2：按威胁分类分组统计日志数

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggBy": ["threatClass"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 10
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "meta": [
            {
                "name": "threatClass",
                "type": "Integer"
            },
            {
                "name": "logCount",
                "type": "Integer"
            }
        ],
        "item": [
            {
                "threatClass": 94,
                "logCount": 3260
            },
            {
                "threatClass": 90,
                "logCount": 2150
            },
            {
                "threatClass": 215,
                "logCount": 1280
            }
        ]
    }
}
```

### 示例 3：按严重性分组统计日志数（已知有限枚举，limit=5）

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggBy": ["severity"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 5
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "meta": [
            {
                "name": "severity",
                "type": "Integer"
            },
            {
                "name": "logCount",
                "type": "Integer"
            }
        ],
        "item": [
            {
                "severity": 3,
                "logCount": 4580
            },
            {
                "severity": 2,
                "logCount": 3260
            },
            {
                "severity": 1,
                "logCount": 2150
            },
            {
                "severity": 0,
                "logCount": 1280
            },
            {
                "severity": 4,
                "logCount": 580
            }
        ]
    }
}
```

### 示例 4：境外攻击源 Top N - filterParam 过滤 + aggBy 分组

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "filterParam": {
        "srcCountryNames": ["美国", "俄罗斯"]
    },
    "aggBy": ["srcIp"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 10
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "meta": [
            {
                "name": "srcIp",
                "type": "String"
            },
            {
                "name": "logCount",
                "type": "Integer"
            }
        ],
        "item": [
            {
                "srcIp": "203.0.113.50",
                "logCount": 1280
            },
            {
                "srcIp": "198.51.100.25",
                "logCount": 852
            }
        ]
    }
}
```

### 示例 5：按源 IP + 国家双维度聚合统计

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "filterParam": {
        "srcCountryNames": ["美国", "中国"]
    },
    "aggBy": ["srcIp"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 20
}
```

**说明**：filterParam 同时含 srcCountryNames + 按 srcIp 分组，可定位特定国家内的攻击源 IP 分布。

### 示例 6：错误用法示例 - 缺省 aggBy 拿"总计数"（返回假数据）

> ⚠️ 早期文档曾把此示例作为正常用法演示"不传 aggBy 返回总条数"。**实际行为**：缺省 aggBy 时 Service 用"查询结果行数"当计数值，聚合 SQL 无 GROUP BY 恒返回 1 行，返回的计数**恒为 1**，不是真实总数。需要总量请改用 `/api/xdr/v1/analysislog/count` 接口；用本接口必须传 aggBy。

**请求示例**（缺省 aggBy，不推荐）：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggFuncs": [
        {
            "name": "totalLogCount",
            "func": "count",
            "param": "srcIp"
        }
    ]
}
```

**实际响应**（注意 totalLogCount 恒为 1，不是真实日志总数）：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "meta": [
            {
                "name": "totalLogCount",
                "type": "Integer"
            }
        ],
        "item": [
            {
                "totalLogCount": 1
            }
        ]
    }
}
```

### 示例 7：排除特定源 IP 的聚合统计

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "excludeParam": {
        "srcIps": ["1.1.1.1"],
        "srcCountryNames": ["中国"]
    },
    "aggBy": ["srcIp"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc",
    "limit": 10
}
```

### 示例 8：多字段排序聚合

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggBy": ["srcIp", "dstIp"],
    "aggFuncs": [
        {
            "name": "logCount",
            "func": "count",
            "param": "srcIp"
        }
    ],
    "sort": "logCount:desc,dstIp:asc",
    "limit": 10
}
```

### 示例 9：错误响应示例 - 缺少必填参数

**请求示例**（缺少 aggFuncs）：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "timeField": "recordTimestamp",
    "aggBy": ["srcIp"]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "exception.param.error.empty_agg_funcs",
    "data": null
}
```

### 示例 10：错误响应示例 - 起始时间大于结束时间

**请求示例**：
```json
{
    "startTimestamp": 1783180800,
    "endTimestamp": 1782576000,
    "timeField": "recordTimestamp",
    "aggBy": ["srcIp"],
    "aggFuncs": [{"name":"logCount","func":"count","param":"srcIp"}]
}
```

**错误响应示例**：
```json
{
    "code": "InternalError",
    "message": "exception.param.error.start_time_lt_end_time",
    "data": null
}
```

### 示例 11：错误响应示例 - 缺少 timeField

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "aggBy": ["srcIp"],
    "aggFuncs": [{"name":"logCount","func":"count","param":"srcIp"}]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "exception.param.error.empty_time_field",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **必填参数**
   - startTimestamp：秒级 Long，最小 1，最大 9999999999（10 位）
   - endTimestamp：秒级 Long，最小 1，最大 9999999999（10 位）
   - timeField：合法时间字段名
   - aggFuncs：至少 1 个元素

2. **aggBy 字段约束（重要）**
   - **aggBy 必须使用实体类字段名**：从 `NetworkSecurityLog.class` 和 `NetworkSecurityLogVo.class` 的 `getDeclaredFields()` 提取白名单。常用字段：srcIp / dstIp / srcPort / dstPort / threatClass / threatType / threatSubType / productType / vendor / severity / attackState / l7Protocol / l4Protocol / l3Protocol / srcCountry / srcProvince / dstCountry / dstProvince / srcIpTag / dstIpTag / srcType / srcSubType / dstType / dstSubType / action / tactic / technique / confidence / riskLevel / white / engineName / recordTimestamp 等
   - **通用聚合接口 aggBy 只传一个字段（业务规则）**：通用聚合接口（如本接口）aggBy 只传一个字段，多维度聚合请使用其他接口或在 aggBy 中组合少量字段。源码未强制单字段，但业务上推荐单字段分组
   - 非法字段名会被 DAO 层白名单校验拦截

3. **aggFuncs 限制**
   - 至少 1 个元素（@NotEmpty）
   - name：最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN
   - func：必填，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN，受 safeAggFunc 白名单约束
   - param：必填，最长 64，需符合 COMMON_LEGAL_CHAR_PATTERN

4. **sort 格式**
   - 格式：`fieldName:asc` 或 `fieldName:desc`
   - 分隔符为冒号 `:`，不是空格
   - 多字段用逗号 `,` 分隔
   - 不符合格式时按 `safeAlias(sortItem) + " DESC"` 兜底处理

5. **limit 限制**
   - 最小 1
   - 默认 5
   - **静默截断**：未传 limit 或传较小值时，超过 limit 的分组结果会被静默截断，不报错也不返回剩余数据
   - 请按 OpenAPI 接口选型推荐指南传值——聚合字段为已知有限枚举时传枚举总数，非已知枚举时通过会话让业务方给出 N。不要传超大值绕过截断

6. **时间范围**
   - startTimestamp / endTimestamp 为秒级（10 位 Long）
   - startTimestamp 必须 <= endTimestamp，否则抛 `START_TIME_LT_END_TIME` 异常
   - 最小 1，最大 9999999999

### 参数依赖关系

1. **aggBy vs aggFuncs**
   - aggBy：分组字段，决定按什么维度分组
   - aggFuncs：聚合操作，决定每组的统计值
   - 不传 aggBy 时返回单条总数计数
   - 传 aggBy 时按字段分组返回每组的聚合结果

2. **filterParam vs excludeParam**
   - filterParam：包含条件，匹配满足指定字段的日志
   - excludeParam：排除条件，排除满足指定字段的日志
   - excludeParam 独有 srcIps 字段，filterParam 无此字段
   - 两者可同时使用

3. **sort vs 默认排序**
   - sort 缺省时按 aggFuncs[0].name DESC 排序
   - sort 非空时按 sort 字段排序（格式 `fieldName:asc/desc`）

4. **timeField 与时间范围**
   - timeField 指定按哪个时间字段过滤（如 recordTimestamp / uploadTimestamp / insertTimestamp）
   - startTimestamp / endTimestamp 按 timeField 字段过滤

### 使用注意事项

- **aggBy 字段数约束（业务规则）**：通用聚合接口 aggBy 只传一个字段，多维度聚合请使用其他接口或在 aggBy 中组合少量字段。源码未强制单字段，但业务上推荐单字段分组。
- **limit 默认值 5 静默截断**：未传 limit 或传较小值时，超过 limit 的分组结果会被静默截断，不报错也不返回剩余数据。请按 OpenAPI 接口选型推荐指南传值——聚合字段为已知有限枚举时传枚举总数（如 severity 5 个值传 5，dealStatus 4 个值传 4），非已知枚举时通过会话让业务方给出 N。不要传超大值绕过截断。
- **aggBy 字段必须使用实体类字段名**：从 NetworkSecurityLog / NetworkSecurityLogVo 实体类提取白名单，不能使用任意字符串。
- **sort 格式为冒号分隔**：`fieldName:asc` 或 `fieldName:desc`，不是空格分隔。

### 权限要求

- 需要 `superAdmin` 或 `incidentQuery` 或 `alertQuery` 三者任一权限
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.analysisLog.log"）

### 性能建议

1. **合理设置时间范围**
   - 时间范围过大可能导致查询超时
   - 建议单次查询时间范围不超过 7 天

2. **合理设置 limit**
   - limit 过大会导致返回数据量过多
   - 已知有限枚举时传枚举总数（如 severity 5 个值传 5）
   - 非已知枚举时根据业务需求传合理值（如 Top 10、Top 20）
   - 不要传超大值绕过 limit 截断

3. **aggBy 选择**
   - srcIp / dstIp 分组可能产生大量分组（IP 数量多），建议配合 limit 缩小返回数
   - severity / attackState / threatClass 等枚举字段分组数量有限，性能较好
   - 推荐单字段分组，多字段组合时性能会下降

4. **避免过多过滤条件**
   - 过滤条件越多，查询复杂度越高
   - 合理组合过滤条件，避免冗余

### 数据一致性说明

- 入参与返回时间戳均为秒级（10 位 Long）。
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档基于当前日期 2026-07-05 计算：
  - 2026-07-05 00:00:00 UTC = 1783180800（秒级）
  - 2026-06-28 00:00:00 UTC = 1782576000（秒级，7 天前）
  - 调用时请使用 `Math.floor(Date.now() / 1000)` 计算当前秒级时间戳。
- Service 层使用 `OpenApiTimeRangeUtil.resolveTimestamp` 将空值时间补全为秒级，无毫秒/秒级转换。
- 数据存储于 ClickHouse，时间字段为秒级 Long。
- meta 中的 type 字段通过反射实体类字段类型得到简单类名（如 String / Integer / Long 等）。
- aggFuncs[0].name 在 meta 中固定标记为 Integer 类型（与实际聚合结果类型可能不完全一致，仅作元数据展示）。
- limit 截断在 Service 层执行，total 为截断前的总分组数，item 为截断后的分组列表。
- JSON 字段名以 @JsonProperty 注解值为准（如 filterParam.srcCountryNames 不是 srcCountry）。

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | exception.param.error.empty_start_time | startTimestamp 为空 | 设置 startTimestamp（秒级 Long） |
| 400 | exception.param.error.empty_end_time | endTimestamp 为空 | 设置 endTimestamp（秒级 Long） |
| 400 | exception.param.error.empty_time_field | timeField 为空 | 设置 timeField（如 recordTimestamp） |
| 400 | exception.param.error.empty_agg_funcs | aggFuncs 为空 | 至少传一个 aggFunc |
| 400 | exception.param.error.time_min | startTimestamp / endTimestamp 小于 1 | 设置 >= 1 |
| 400 | exception.param.error.time_max | startTimestamp / endTimestamp 超过 9999999999 | 使用 10 位秒级时间戳 |
| 400 | name fields length out of range | aggFuncs[].name 超过 64 字符 | 缩短 name 长度 |
| 400 | name invalid field format | aggFuncs[].name 含非法字符 | 使用符合 COMMON_LEGAL_CHAR_PATTERN 的字符 |
| 400 | func fields length out of range | aggFuncs[].func 超过 64 字符 | 缩短 func 长度 |
| 400 | func invalid field format | aggFuncs[].func 含非法字符 | 使用合法聚合函数名（count / sum / avg 等） |
| 400 | param fields length out of range | aggFuncs[].param 超过 64 字符 | 缩短 param 长度 |
| 400 | param invalid field format | aggFuncs[].param 含非法字符 | 使用合法字段名或 * |
| 400 | param accessDirection is invalid | filterParam.accessDirections 元素非 AttackDirectionEnum 合法值 | 使用合法值：0/1/2/3 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin / incidentQuery / alertQuery 权限 |
| 500 | exception.param.error.start_time_lt_end_time | startTimestamp > endTimestamp | 确保 startTimestamp <= endTimestamp |
| 500 | exception.method.execute | 服务端查询执行异常（如 ClickHouse 连接失败、SQL 执行异常等） | 联系技术支持，检查 ClickHouse 集群状态 |

## 最佳实践

1. **首次使用建议**
   - 先使用小范围时间（如最近 1 小时）和单字段分组（aggBy=["srcIp"]）测试接口
   - 确认返回数据格式和字段含义后再扩大查询范围
   - 验证权限配置是否正确

2. **按需求产出形状选接口**
   - 需求"按枚举字段统计多个分组的总数" → 用本接口一次按枚举字段分组，limit=枚举总数，一次拿到所有分组计数
   - 不要为每个枚举值分别调用 list 接口取 total——会发起 N 次请求且性能差
   - 选型优先级（性能从低到高）：list < 聚合 < 趋势

3. **limit 传值策略**
   - 已知有限枚举时传枚举总数：severity 5 个值传 5，attackState 3 个值传 3
   - 非已知枚举时根据业务需求传合理值：Top 10 / Top 20 / Top 50
   - 不要传超大值绕过 limit 截断（默认 5 会静默截断）

4. **aggBy 单字段分组（业务规则）**
   - 通用聚合接口 aggBy 只传一个字段
   - 多维度聚合请使用其他接口或在 aggBy 中组合少量字段
   - 推荐分组字段：srcIp / dstIp / threatClass / severity / attackState / productType

5. **sort 排序设置**
   - 通常按聚合结果（aggFuncs[0].name）降序排序（如 `logCount:desc`）
   - 不传 sort 时默认按 aggFuncs[0].name DESC 排序
   - 多字段排序用逗号分隔（如 `logCount:desc,srcIp:asc`）

6. **配合 list 接口做明细查询**
   - 先用本接口按 aggBy 分组获取 Top N 分组（如 Top 10 高频 srcIp）
   - 对感兴趣的分组，调用 `/api/xdr/v1/analysislog/list` 接口查询明细
   - 实现从聚合统计到明细溯源的完整链路

7. **错误处理与重试**
   - 解析响应时首先检查 code 字段，"Success" 为成功，其他为失败
   - 500 错误可能为 ClickHouse 集群异常或 SQL 执行异常，建议短暂间隔后重试
   - 403 错误需联系管理员添加权限，不可重试
