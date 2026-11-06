# POST /api/xdr/v1/vuls/asset/stats

## 接口概述

本接口用于按资产维度统计脆弱性数据。通过本接口，您可以获取以下内容：

### 可查询的脆弱性资产统计信息
- **统计指标**：漏洞数量、弱密码数量、风险数量等任意数值字段的 count/sum/avg/max/min
- **过滤条件**：修复优先级、脆弱性类型、资产类型、处置状态、互联网暴露、资产重要性、关键字、CVE 等

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `VulsAssetStats` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/asset/views.py:89`（注册于 `soar/apps/vuln_web/app/view/vuln/asset/openapi_v2.py:18` → `/vuls/asset/stats`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/asset/views.py:101` → `get_vuls_asset_stats(data)`（`view/vuln/asset/business.py:260`）→ `MyHostVulMiddle.get_vuls_asset_stats` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/asset/params.py:227` → `VULS_ASSET_STATS_SCHEMA` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/asset/stats` 经 etcd 具体路由 `openapi_asm_vuls_asset_stats_v1` 转后端 `/order/v2/openapi/vuls/asset/stats`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - **资产视角**统计 |
| 数据源表 | `host_vul_middle`（**资产视角中间表**，按资产-漏洞关联组织记录） |
| 接口分类 | 统计 |
| 前置依赖 | 无（可直接调用） |

> **风险视角 vs 资产视角（关键区分）**：本接口属于**资产视角**，数据源是 `host_vul_middle` 表，与前端"资产漏洞列表"页面一致。**风险视角**接口（如 `POST /api/xdr/v1/risk/list`、`POST /api/xdr/v1/vuls/risk/aggregation/count`）数据源是 `vul_risk_middle` 表，与前端"漏洞风险列表"页面一致。两个视角数据同步存在时差、字段映射差异，统计同一需求可能得到不同结果（实测同一筛选条件下资产视角 6 条 vs 风险视角 16 条）。**需求中出现"漏洞风险列表/漏洞风险数量"时，应选风险视角接口，不要选本接口（资产视角）**。
| 关联接口 | `/api/xdr/v1/vuls/asset/aggregation`（聚合）、`/api/xdr/v1/vuls/asset/topn`（TopN） |

## 使用场景

1. **总览卡片**：统计当前资产漏洞总数、弱密码总数，用于看板顶部数字卡片
2. **状态分布**：按处置状态统计，展示待处置/处置中/已修复分布
3. **优先级统计**：按修复优先级统计，展示高/中/低/无分布
4. **趋势分析**：与 `/api/xdr/v1/vuls/risk/trends` 配合，先统计当前状态，再查询时间趋势
5. **多指标对比**：同时调用 count/sum 两个 aggFunc，统计总数与高风险数

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/asset/stats` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.VULS_ASSET_STATS_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验 `superAdmin` 或 `riskManageQuery` 权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=False)` 转换参数命名
4. **统计查询**：调用 `get_vuls_asset_stats(new_data)`，内部执行 MongoDB aggregate pipeline
5. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
6. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- 入参小驼峰 → 内部下划线：`startTimestamp` → `start_timestamp`，`assetGroupIds` → `asset_group_ids`
- 出参下划线 → 小驼峰
- 与 aggregation 接口不同，**stats 接口无 `aggBy` 字段**，只做全局统计

### 默认行为

- `need_default_time_range=False`：不传时间时不自动填充默认时间
- 无 `aggBy` 字段，整个查询结果为单一聚合组（单条统计值）
- 无 `limit`/`offset` 字段

### 特殊规则

- `aggFuncs` 必填，且每个元素 `name`/`func`/`param` 三个字段均必填（与 aggregation 接口不同）
- `timeField` 必须为 `update_time`/`found_time`/`last_time` 之一

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒） | 1717200000 |
| endTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒） | 1719800000 |
| timeField | string | 是 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/更新时间, `found_time`/发现时间, `last_time`/最近时间 | "found_time" |
| filterParam | object | 否 | - | 过滤条件对象 | 见下方 |
| aggFuncs | array&lt;object&gt; | 是 | - | 聚合函数列表，至少 1 个 | 见下方 |

#### filterParam 结构（同 /vuls/asset/aggregation）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| fixPriority | array&lt;integer&gt; | 否 | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| assetGroupIds | array&lt;integer&gt; | 否 | 资产组 ID 列表 | [101] |
| assetBranchIds | array&lt;integer&gt; | 否 | 业务组 ID 列表 | [201] |
| assetType | string | 否 | 资产类型，参考 enum-dictionary-python.md。`all`/全部, `server`/服务器, `terminal`/终端, `other`/其他 | "server" |
| vulnType | array&lt;string&gt; | 否 | 脆弱性类型，参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码, `baseline`/基线 | ["loophole"] |
| branchType | string | 否 | 业务组类型，枚举 `branch`/`group`。**必传字符串，传 integer（如 1）会触发 `branch_type格式有误` 校验错误** | "branch" |
| branchId | integer | 否 | 业务组 ID | 1 |
| keyword | string | 否 | 关键字模糊匹配 | "log4j" |
| keywordAll | string | 否 | 关键字全字段匹配 | "log4j" |
| fixedStatus | array&lt;integer&gt; | 否 | 处置状态，参考 enum-dictionary-python.md。0/待处置, 1/处置中, 2/已修复, 3/已接受, 4/已忽略, 5/误报, 6/改善, 7/加白, 100/处置完成 | [0, 1] |
| limit | integer | 否 | 0-100 | 50 |
| offset | integer | 否 | ≥ 0 | 0 |
| exposure | array&lt;string&gt; | 否 | 互联网暴露，参考 enum-dictionary-python.md。`yes`/暴露, `no`/未暴露, `unknown`/未知 | ["yes"] |
| magnitude | array&lt;string&gt; | 否 | 资产重要性，参考 enum-dictionary-python.md。`normal`/普通, `core`/核心 | ["core"] |
| assetTags | array&lt;string&gt; | 否 | 资产标签列表 | ["tag1"] |
| assetIp | object | 否 | 资产 IP 查询条件，**必须传 object**：`{"op": "="/"like", "val": string}`。`op` 仅支持 `"="`（精确相等）和 `"like"`（模糊匹配）；`val` 为 IP 字符串，多个 IP 用英文/中文逗号分隔（如 `"192.168.1.1,192.168.1.2"`）。**传字符串（如 `"192.168.1"`）会被 JSON Schema 校验拦截，返回 `{"code":"InvalidParameter","message":"IP格式有误"}`**；传 `op` 为其他值会触发后端 `ValueError: The ip does not support this query operator` | {"op": "like", "val": "192.168.1"} |
| assetManager | string | 否 | 资产责任人 | "张三" |
| cve | object | 否 | CVE 编号查询条件，对象结构 `{"op": "eq"/"in"/"like", "val": string 或 array<string>}`。**必传 object，传字符串（如 "CVE-2021-44228"）会触发 `TypeError: string indices must be integers`** | {"op": "eq", "val": "CVE-2021-44228"} |
| assetStatus | array&lt;integer&gt; | 否 | 资产管理状态列表，**必须传数组**，传单个 integer 会校验失败 | [1] |

#### aggFuncs 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | 聚合结果字段名，maxLength=64 | "totalCount" |
| func | string | 是 | 聚合函数名（count/sum/avg/max/min），maxLength=64 | "count" |
| param | string | 是 | 聚合函数参数（字段名），maxLength=64 | "risk_num" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（V1 OpenAPI 外壳，**字符串非整数**）。失败时为 `"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"` |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| {aggFuncs[0].name} | integer/number | 第 1 个聚合函数计算结果 |
| {aggFuncs[1].name} | integer/number | 第 2 个聚合函数计算结果 |

## 调用示例

### 示例 1：统计漏洞总数

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggFuncs": [{"name": "totalCount", "func": "count", "param": ""}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "totalCount": 156
  }
}
```

### 示例 2：按修复优先级过滤，统计高风险漏洞数

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "last_time",
  "filterParam": {
    "fixPriority": [2, 3],
    "vulnType": ["loophole"]
  },
  "aggFuncs": [{"name": "highRiskCount", "func": "count", "param": ""}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "highRiskCount": 47
  }
}
```

### 示例 3：多指标统计 - 同时统计总数和、最大值

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "update_time",
  "filterParam": {
    "assetBranchIds": [201]
  },
  "aggFuncs": [
    {"name": "totalCount", "func": "count", "param": ""},
    {"name": "maxRiskNum", "func": "max", "param": "risk_num"}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "totalCount": 89,
    "maxRiskNum": 12
  }
}
```

### 示例 4：统计核心资产漏洞数

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "filterParam": {
    "magnitude": ["core"],
    "fixedStatus": [0, 1]
  },
  "aggFuncs": [{"name": "coreAssetVulnCount", "func": "count", "param": ""}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "coreAssetVulnCount": 23
  }
}
```

### 示例 4-1：按资产 IP 过滤（assetIp 必须传 object）

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "filterParam": {
    "assetIp": {"op": "like", "val": "192.168.200.18"},
    "fixPriority": [3],
    "vulnType": ["loophole", "weak_pwd"]
  },
  "aggFuncs": [{"name": "totalCount", "func": "count", "param": ""}]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "totalCount": 42
  }
}
```

**错误示例（assetIp 传裸字符串）**：
```json
{
  "filterParam": {"assetIp": "192.168.200.18"}
}
```
```json
{
  "code": "InvalidParameter",
  "message": "IP格式有误"
}
```

### 示例 5：错误响应 - 缺少必填字段

**请求示例**（缺少 `aggFuncs`）：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "InvalidParameter",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- 与 aggregation 接口不同，**stats 接口的 `aggFuncs.param` 必填**，即使 `func=count` 也要传空字符串 `""`
- 无 `aggBy`/`sort`/`limit` 字段
- `filterParam` 内字段限制同 aggregation 接口

### 参数依赖关系

- `aggFuncs.param` 在 `func=count` 时可为空字符串，其他 `func` 必须传字段名
- `timeField` 与 `startTimestamp`/`endTimestamp` 配套使用

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 统计接口走 MongoDB aggregate `$group`，必须用 `allow_disk_use=True`
- 大时间范围统计建议拆分为多个小范围并行查询
- `filterParam` 必带，避免全表扫描

### 数据一致性说明

- 响应字段为小驼峰命名
- 错误码使用 V1_ERROR_MAP 映射（trap #4）

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | 缺少必填字段 | 补全字段 |
| `"InvalidParameter"` | InvalidParameter | aggFuncs.param 未传 | 传空字符串或字段名 |
| `"InvalidParameter"` | **IP格式有误** | **`assetIp` 传了裸字符串**（如 `"192.168.1"`），未按 object 结构传 | 改为 `{"op": "like", "val": "192.168.1"}`；精确相等用 `{"op": "=", "val": "192.168.1"}` |
| `"InvalidParameter"` | InvalidParameter | `assetIp.op` 传了 `=`/`like` 之外的值 | `op` 仅支持 `"="` 和 `"like"` |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库聚合超时 | 缩小时间范围 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **count 函数传空 param**：`func=count` 时 `param` 传 `""`，避免聚合错误
2. **多指标统计**：单次请求多个 aggFunc，减少调用次数
3. **filterParam 必带**：缩小统计范围，提升性能
4. **timeField 选择**：按业务场景选择时间字段
5. **与 aggregation 配合**：先 stats 取总数，再 aggregation 取分组明细
6. **assetIp 传 object 不传字符串**：`assetIp` 类型是 object，必须传 `{"op": "="/"like", "val": "<ip>"}`。传裸字符串（如 `"192.168.1"`）会被 JSON Schema 拦截返回 `"IP格式有误"`。多 IP 用逗号分隔放在同一个 `val` 里（如 `{"op": "like", "val": "192.168.1.1,192.168.1.2"}`）

---
