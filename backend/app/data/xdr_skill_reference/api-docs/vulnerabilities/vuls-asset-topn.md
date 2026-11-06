# POST /api/xdr/v1/vuls/asset/topn

## 接口概述

本接口用于获取风险资产 TopN 列表（按高修复优先级排序）。通过本接口，您可以获取以下内容：

### 可查询的风险资产信息
- **基础信息**：资产 ID、资产 IP
- **统计信息**：按资产分级的漏洞数、弱密码数、风险总数（每项含 high/low/middle/sum/without 分级计数）、基线数（含 high/low/middle/sum 分级计数）
- **过滤条件**：修复优先级、脆弱性类型、关键字、时间范围等
- **排序**：按高修复优先级排序，返回前 N 个资产

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `AssetOverViewTopN` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/asset/views.py:109`（注册于 `soar/apps/vuln_web/app/view/vuln/asset/openapi_v2.py:19` → `/vuls/asset/topn`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/asset/views.py:118` → `get_high_asset_topN(data)`（`view/vuln/asset/business.py:268`）→ `MyHostVulMiddle.get_vuls_asset_topN` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/asset/params.py:78` → `ASSET_TOP5_SCHEMA`（与前端视图复用同一常量） |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/asset/topn` 经 etcd 具体路由 `openapi_asm_vuls_asset_topn_v1` 转后端 `/order/v2/openapi/vuls/asset/topn`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 资产视角 TopN |
| 接口分类 | 列表查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/asset/aggregation`（资产聚合）、`/api/xdr/v1/vuls/asset/stats`（资产统计） |

## 使用场景

1. **资产排行榜**：展示风险最高的 N 个资产，用于运维看板
2. **重点关注资产**：列出高修复优先级资产，便于优先处置
3. **业务组 TopN**：按业务组过滤，展示当前业务组风险最高的资产
4. **趋势分析**：与 `/api/xdr/v1/vuls/risk/trends` 配合，先取 TopN 资产再查趋势
5. **责任分布**：与 `assetManager` 过滤配合，展示某责任人名下风险最高的资产

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/asset/topn` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.ASSET_TOP5_SCHEMA)` 执行 JSON Schema 校验（schema 名为 TOP5 但实际支持任意 N）
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **关键字预处理**：调用 `pre_deal_keyword(data)` 对 `keyword` 字段做特殊处理（去空格、转义）
4. **TopN 查询**：调用 `get_high_asset_topN(data)`，内部按高修复优先级排序，取前 N 条
5. **响应封装**：调用 `output(data=get_high_asset_topN(data), v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- `keyword` 经 `pre_deal_keyword` 处理（trim、关键词切分）
- 出参由 `get_high_asset_topN` 内部直接返回小驼峰结构（不走 `snake_to_camel`）

### 默认行为

- 不传 `limit` 时返回前 5 条（schema 默认 TOP5）
- 排序规则：按修复优先级降序 + 风险数量降序 + 最近发现时间降序
- 时间范围 `latest_time_range` 默认查最近 7 天

### 特殊规则

- 接口对外路径为 `/api/xdr/v1/vuls/asset/topn`，但底层复用 `ASSET_TOP5_SCHEMA`（schema 名 TOP5 但实际 limit 可调）
- 返回的 `v1_open_api=True` 走 V1_ERROR_MAP 错误码映射通道（trap #4）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| asset_type | string | 是 | - | 资产类型，参考 enum-dictionary-python.md。`all`/全部, `server`/服务器, `terminal`/终端, `other`/其他 | "all" |
| fix_priority | array&lt;integer&gt; | 是 | - | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| data_type | array&lt;string&gt; | 是 | - | 脆弱性类型（含基线），参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码, `baseline`/基线 | ["loophole", "weak_pwd"] |
| branch_type | string | 是 | - | 业务组类型，枚举 `branch`/`group`。**必传字符串，传 integer（如 1）会触发 `branch_type格式有误` 校验错误** | "branch" |
| branch_id | integer | 是 | - | 业务组 ID | 1 |
| latest_time_range | array&lt;integer&gt; | 是 | - | 最近时间范围 [start, end]，maxItems=2 | [1717200000, 1719800000] |
| keyword | string | 是 | - | 关键字模糊匹配，maxLength=100 | "log4j" |
| fixed_status | array&lt;integer&gt; | 是 | - | 处置状态（简化版），参考 enum-dictionary-python.md | [0, 1] |
| asset_tags | array&lt;string&gt; | 否 | - | 资产标签列表 | ["tag1"] |
| keyword_all | string | 否 | - | 关键字全字段匹配 | "log4j" |
| asset_ip | object | 否 | - | 资产 IP 查询条件，**必须传 object**：`{"op": "="/"like", "val": string}`。`op` 仅支持 `"="`（精确相等）和 `"like"`（模糊匹配）；`val` 为 IP 字符串，多个 IP 用英文/中文逗号分隔（如 `"192.168.1.1,192.168.1.2"`）。**传字符串（如 `"192.168.1"`）会被 JSON Schema 校验拦截，返回 `{"code":"InvalidParameter","message":"IP格式有误"}`**；传 `op` 为其他值会触发后端 `ValueError: The ip does not support this query operator` | {"op": "like", "val": "192.168.1"} |
| asset_manager | string | 否 | - | 资产责任人 | "张三" |
| cve | object | 否 | - | CVE 编号查询条件，对象结构 `{"op": "eq"/"in"/"like", "val": string 或 array<string>}`。**必传 object，传字符串（如 "CVE-2021-44228"）会触发 `TypeError: string indices must be integers`** | {"op": "eq", "val": "CVE-2021-44228"} |
| platform_id | integer | 否 | - | 平台 ID | 1 |
| platform_ids | array&lt;integer&gt; | 否 | - | 平台 ID 列表 | [1, 2] |
| limit | integer | 否 | 5 | TopN 数量，0-100 | 10 |

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
| list | array&lt;object&gt; | TopN 资产列表 |
| total | integer | 总数 |

### list 元素结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| assetId | integer | 资产 ID | - | 1001 |
| assetIp | string | 资产 IP | - | "192.168.1.1" |
| assetName | string | 资产名称 | - | "web-server-01" |
| assetType | string | 资产类型，参考 enum-dictionary-python.md | `server`/服务器等 | "server" |
| manager | string | 责任人 | - | "张三" |
| riskCount | integer | 风险数量 | - | 42 |
| fixPriority | integer | 修复优先级，参考 enum-dictionary-python.md | 0/无, 1/低, 2/中, 3/高 | 3 |
| lastTime | integer | 最近发现时间 | - | 1719500000 |

## 调用示例

### 示例 1：获取风险 Top10 资产

**请求示例**：
```json
{
  "asset_type": "all",
  "fix_priority": [2, 3],
  "data_type": ["loophole", "weak_pwd"],
  "branch_type": "branch",
  "branch_id": 1,
  "latest_time_range": [1717200000, 1719800000],
  "keyword": "",
  "fixed_status": [0, 1],
  "limit": 10
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"assetId": 1001, "assetIp": "192.168.1.1", "assetName": "web-server-01", "assetType": "server", "manager": "张三", "riskCount": 42, "fixPriority": 3, "lastTime": 1719500000},
      {"assetId": 1002, "assetIp": "192.168.1.2", "assetName": "db-server-01", "assetType": "server", "manager": "李四", "riskCount": 35, "fixPriority": 3, "lastTime": 1719480000},
      {"assetId": 1003, "assetIp": "10.0.0.5", "assetName": "cache-01", "assetType": "server", "manager": "王五", "riskCount": 18, "fixPriority": 2, "lastTime": 1719450000}
    ],
    "total": 3
  }
}
```

### 示例 2：按责任人过滤 Top5

**请求示例**：
```json
{
  "asset_type": "all",
  "fix_priority": [0, 1, 2, 3],
  "data_type": ["loophole"],
  "branch_type": "branch",
  "branch_id": 1,
  "latest_time_range": [1717200000, 1719800000],
  "keyword": "",
  "fixed_status": [0, 1, 2],
  "asset_manager": "张三",
  "limit": 5
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"assetId": 1001, "assetIp": "192.168.1.1", "assetName": "web-server-01", "assetType": "server", "manager": "张三", "riskCount": 42, "fixPriority": 3, "lastTime": 1719500000}
    ],
    "total": 1
  }
}
```

### 示例 3：按业务组过滤 Top20

**请求示例**：
```json
{
  "asset_type": "server",
  "fix_priority": [3],
  "data_type": ["loophole", "weak_pwd", "baseline"],
  "branch_type": "group",
  "branch_id": 201,
  "latest_time_range": [1717200000, 1719800000],
  "keyword": "log4j",
  "fixed_status": [0, 1],
  "limit": 20
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"assetId": 2001, "assetIp": "10.0.0.5", "assetName": "api-server", "assetType": "server", "manager": "赵六", "riskCount": 12, "fixPriority": 3, "lastTime": 1719420000}
    ],
    "total": 1
  }
}
```

### 示例 3-1：按资产 IP 过滤（asset_ip 必须传 object）

**请求示例**：
```json
{
  "asset_type": "all",
  "fix_priority": [3],
  "data_type": ["loophole", "weak_pwd"],
  "branch_type": "branch",
  "branch_id": 1,
  "latest_time_range": [1717200000, 1719800000],
  "keyword": "",
  "fixed_status": [0, 1],
  "asset_ip": {"op": "like", "val": "192.168.200.18"},
  "limit": 5
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"assetId": 1001, "assetIp": "192.168.200.18", "assetName": "web-server-01", "assetType": "server", "manager": "张三", "riskCount": 42, "fixPriority": 3, "lastTime": 1719500000}
    ],
    "total": 1
  }
}
```

**错误示例（asset_ip 传裸字符串）**：
```json
{
  "asset_ip": "192.168.200.18"
}
```
```json
{
  "code": "InvalidParameter",
  "message": "IP格式有误"
}
```

### 示例 4：错误响应 - 缺少必填字段

**请求示例**（缺少 `fix_priority`）：
```json
{
  "asset_type": "all",
  "data_type": ["loophole"],
  "branch_type": 1,
  "branch_id": 1,
  "latest_time_range": [1717200000, 1719800000],
  "keyword": "",
  "fixed_status": [0, 1]
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

- `limit` 0-100，默认 5
- `latest_time_range` 长度必须为 2
- `keyword` maxLength=100
- `fix_priority` 元素值必须为 0/1/2/3

### 参数依赖关系

- `branch_type` 和 `branch_id` 必填，决定查询的业务组范围
- `platform_id` 与 `platform_ids` 二选一，未传时默认只查当前平台

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `limit` ≤ 100，超过会触发 schema 校验错误
- `fix_priority` 建议传 `[2, 3]` 只查中高优先级，避免返回大量低优先级资产
- `latest_time_range` 建议跨度 ≤ 30 天

### 数据一致性说明

- 响应字段为小驼峰命名（直接由 DAO 返回，未走 `snake_to_camel`）
- 排序规则固定：修复优先级 → 风险数量 → 最近时间（不可通过参数改变）
- 错误码使用 V1_ERROR_MAP 映射（trap #4）

## 常见错误

| code（响应外层，语义字符串） | 说明 | 原因 | 解决方案 |
|--------|------|------|----------|
| `"InvalidParameter"` | InvalidParameter | 缺少必填字段 | 补全字段 |
| `"InvalidParameter"` | InvalidParameter | branch_type 传 integer 而非字符串枚举 | 改为 "branch"/"group" |
| `"InvalidParameter"` | **IP格式有误** | **`asset_ip` 传了裸字符串**（如 `"192.168.1"`），未按 object 结构传 | 改为 `{"op": "like", "val": "192.168.1"}`；精确相等用 `{"op": "=", "val": "192.168.1"}` |
| `"InvalidParameter"` | InvalidParameter | `asset_ip.op` 传了 `=`/`like` 之外的值 | `op` 仅支持 `"="` 和 `"like"` |
| `"InvalidParameter"` | InvalidParameter | limit 超过 100 | 调整 limit |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库查询超时 | 缩小时间范围 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **limit 合理设置**：业务看板建议 limit=10，详细分析建议 limit=50
2. **fix_priority 过滤**：默认只查 [2, 3] 中高优先级，避免低优先级干扰
3. **关键字使用**：`keyword` 用于模糊匹配，`keyword_all` 用于全字段精确匹配
4. **平台过滤**：跨平台查询时传 `platform_ids`，单平台传 `platform_id`
5. **与 aggregation 配合**：先用 aggregation 看分布，再用 topn 取明细
6. **`asset_ip` 传 object 不传字符串**：`asset_ip` 类型是 object，必须传 `{"op": "="/"like", "val": "<ip>"}`。传裸字符串（如 `"192.168.1"`）会被 JSON Schema 拦截返回 `"IP格式有误"`。多 IP 用逗号分隔放在同一个 `val` 里（如 `{"op": "like", "val": "192.168.1.1,192.168.1.2"}`）

---
