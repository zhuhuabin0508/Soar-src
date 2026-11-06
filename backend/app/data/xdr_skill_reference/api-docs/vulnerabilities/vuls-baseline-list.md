# POST /api/xdr/v1/vuls/baseline/list

## 接口概述

本接口用于获取基线核查列表（v1 OpenAPI 通道）。通过本接口，您可以获取以下内容：

### 可查询的基线信息
- **基线列表**：基线核查项列表，分页返回
- **过滤条件**：风险等级、基线类型、等保级别、时间范围、责任人、业务组、资产组、资产标签、资产重要度
- **关联信息**：基线项 ID、名称、检测时间、处置状态、平台信息

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `V1BaselineList` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:54`（注册于 `soar/apps/vuln_web/app/open_api/v1/vuls/__init__.py:22` → `/vuls/baseline/list`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:69` → `get_baseline_list(data)`（`open_api/v1/vuls/business.py:33`）→ `MyBaselineRiskMiddle.baseline_num/baseline_list` + 委托 `build_baseline_list`（`view/vuln/baseline/business.py:27`） |
| 请求 Schema | `soar/apps/vuln_web/app/open_api/v1/vuls/params.py:85` → `BASELINE_LIST_SCHEMA` |
| 版本归属 | v1（通配路由 `openapi_asm_vuls_wildcard_v1`，uris `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/baseline/list`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 基线核查列表 |
| 接口分类 | 数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | （无） |

## 使用场景

1. **基线核查查询**：查询基线合规检查结果列表
2. **过滤筛选**：按风险等级、基线类型、等保级别等多维度筛选
3. **责任人维度**：按资产责任人筛选基线
4. **合规报表**：生成等保合规报表

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/baseline/list`（通配：后端 `/order/v1/openapi/vuls/baseline/list`） |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.BASELINE_LIST_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **特殊字段处理**：调用 `transform_special_params(data)` 处理特殊字段
4. **驼峰转下划线**：调用 `transform_params(new_data)` 将小驼峰转换为下划线
5. **时间范围生成**：调用 `transform_timestamp2range(new_data)` 将时间戳转换为时间范围
6. **业务查询**：调用 `get_baseline_list(new_data)` 获取基线列表
7. **响应转换**：调用 `snake_to_camel(result)` 将下划线转换为小驼峰
8. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 v1 OpenAPI 响应通道（**实测确认返回字符串 V1Error 语义码** `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`，见下表）

### 数据转换逻辑

- 入参使用小驼峰命名（camelCase）
- 通过 `transform_params` 转换为下划线命名（snake_case）
- 通过 `transform_timestamp2range` 将 `startTimestamp`/`endTimestamp` 转换为时间范围
- 出参通过 `snake_to_camel` 转换回小驼峰
- `additionalProperties: False`，禁止未定义字段

### 默认行为

- 无必填字段
- `pageSize` 默认 100（LIMIT_100）
- `page` 默认 1
- 无结果时返回 `{total: 0, last_id: "", item: []}`

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，**实测确认错误码为字符串 V1Error 语义码**：`"Success"`（成功）/`"InvalidParameter"`（参数异常）/`"Unknown.SerComError"`（未知错误）/`"InternalError"`（系统繁忙）。**并非整数**，判等用字符串比较 `code == "Success"`
- **additionalProperties: False**：禁止传入未定义字段
- **三段转换链**：特殊字段处理 → 驼峰转下划线 → 时间戳转范围
- **last_id 等同偏移量**：业务层查询 total 时排除 last_id，避免总数偏移
- **用户资产转换**：`UserTransformer.need_trans` 检测责任人转换需求

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| level | array&lt;integer&gt; | 否 | - | 基线风险等级，枚举 [1, 2, 3] | [1, 2] |
| baselineType | array&lt;integer&gt; | 否 | - | 基线类型，参考 enum-dictionary-python.md BASELINE_TYPE_LIST | [1] |
| standard | array&lt;integer&gt; | 否 | - | 等保级别，枚举 [1, 2, 3, 4, 5] | [1, 2] |
| latestTimeRange | array&lt;integer&gt; | 否 | - | 最近时间范围 `[start, end]`，Unix 时间戳（秒） | [1717200000, 1719800000] |
| pageSize | integer | 否 | 100 | 分页大小，≥ 1 | 100 |
| page | integer | 否 | 1 | 页码，≥ 1 | 1 |
| startTimestamp | integer | 否 | - | 开始时间戳（秒），≥ 0 | 1717200000 |
| endTimestamp | integer | 否 | - | 结束时间戳（秒），≥ 0 | 1719800000 |
| timeField | string | 否 | - | 时间字段，枚举 ["update_time", "found_time", "last_time"] | "found_time" |
| lastId | string | 否 | - | 上一页最后一条 ID（用于翻页） | "abc123..." |
| assetIp | string | 否 | - | 资产 IP | "192.168.1.1" |
| assetManager | string | 否 | - | 资产责任人 | "张三" |
| assetBranchIds | array&lt;integer&gt; | 否 | - | 业务组 ID 列表 | [101] |
| assetGroupIds | array&lt;integer&gt; | 否 | - | 资产组 ID 列表 | [201] |
| assetTags | array&lt;string&gt; | 否 | - | 资产标签列表 | ["tag1"] |
| assetMagnitudes | array&lt;integer&gt; | 否 | - | 资产重要度列表 | [1, 2] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 修复状态（**该字段不上 openapi 文档**） | [0, 1] |
| platform_ids | array&lt;string&gt; | 否 | - | 平台 ID 列表 | ["plat1"] |
| sort | string | 否 | - | 排序字段，格式 `field:asc` 或 `field:desc`，多字段逗号分隔 | "found_time:desc" |
| platformFilter | object | 否 | - | 平台过滤条件 | {} |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码（trap #4：v1_open_api 通道，**实测为字符串** V1Error 语义码：`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`） |
| message | string | 响应消息（成功为 `"success"`） |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 总数 |
| lastId | string | 当前页最后一条 ID（用于翻页） |
| item | array&lt;object&gt; | 基线列表 |

### item 元素结构说明（小驼峰）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 基线项 ID（md5NameAsset） | "abc123..." |
| name | string | 基线项名称 | "密码策略合规检查" |
| standard | integer | 等保级别 | 1 |
| baselineType | integer | 基线类型 | 1 |
| level | integer | 风险等级 | 2 |
| assetId | string | 资产 ID | "1001" |
| asset | string | 资产 IP | "192.168.1.1" |
| magnitude | integer | 资产重要度 | 2 |
| assetType | string | 资产类型 | "server" |
| businessId | integer | 业务组 ID | 101 |
| businessName | string | 业务组名称 | "核心业务" |
| srcType | string | 来源类型 | "mirror" |
| lastTime | string | 上次扫描时间 | "2024-06-27 12:00:00" |
| foundTime | string | 发现时间 | "2024-06-27 12:00:00" |
| unverify | integer | 待审核数 | 0 |
| count | integer | 基线项数量 | 1 |
| manager | string | 责任人 | "张三" |
| adapter | array&lt;object&gt; | 适配器列表 | [] |
| handlingCount | integer | 处置数量 | 0 |
| dealStatus | integer | 处置状态 | 0 |

## 调用示例

### 示例 1：查询基线核查列表

**请求示例**：
```json
{
  "level": [2, 3],
  "standard": [1, 2],
  "page": 1,
  "pageSize": 100,
  "timeField": "found_time",
  "latestTimeRange": [1717200000, 1719800000]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 1,
    "lastId": "abc123def4567890abc123def4567890",
    "item": [
      {
        "id": "abc123def4567890abc123def4567890",
        "name": "密码策略合规检查",
        "standard": 1,
        "baselineType": 1,
        "level": 2,
        "assetId": "1001",
        "asset": "192.168.1.1",
        "magnitude": 2,
        "assetType": "server",
        "businessId": 101,
        "businessName": "核心业务",
        "srcType": "mirror",
        "lastTime": "2024-06-27 12:00:00",
        "foundTime": "2024-06-27 12:00:00",
        "unverify": 0,
        "count": 1,
        "manager": "张三",
        "handlingCount": 0,
        "dealStatus": 0
      }
    ]
  }
}
```

### 示例 2：使用 lastId 翻页

**请求示例**：
```json
{
  "page": 2,
  "pageSize": 100,
  "lastId": "abc123def4567890abc123def4567890"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 200,
    "lastId": "def123abc4567890def123abc4567890",
    "item": [...]
  }
}
```

### 示例 3：错误响应 - 传入未定义字段

**请求示例**（包含 `additionalProperties` 未定义字段）：
```json
{
  "page": 1,
  "pageSize": 100,
  "unknownField": "value"
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

### 示例 4：错误响应 - level 不在枚举内

**请求示例**：
```json
{
  "level": [4, 5]
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

- `level` 枚举 [1, 2, 3]
- `standard` 枚举 [1, 2, 3, 4, 5]
- `timeField` 枚举 ["update_time", "found_time", "last_time"]
- `additionalProperties: False`，禁止传入未定义字段
- `fixedStatus` 字段不上 openapi 文档（内部使用）

### 参数依赖关系

- `page`/`pageSize` 共同确定分页
- `lastId` 用于翻页（等同偏移量）
- `startTimestamp`/`endTimestamp` 与 `latestTimeRange` 二选一

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `pageSize` 默认 100，建议 ≤ 1000
- `lastId` 翻页比 `page` 偏移更高效
- 时间范围必带，避免全表扫描

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，错误码**实测为字符串** V1Error 语义码 `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`（非整数）
- **三段转换链**：特殊字段处理 → 驼峰转下划线 → 时间戳转范围 → 查询 → 下划线转驼峰
- **入参小驼峰**：`transform_params` 转换为下划线后处理
- **出参小驼峰**：`snake_to_camel` 转换后返回
- **last_id 等同偏移量**：查询 total 时排除 last_id，避免总数偏移
- **用户资产转换**：`UserTransformer.need_trans` 检测责任人转换需求

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| "InvalidParameter" | InvalidParameter | level 不在 [1,2,3] 枚举内 | 使用 1/2/3 |
| "InvalidParameter" | InvalidParameter | standard 不在 [1,2,3,4,5] 枚举内 | 使用 1/2/3/4/5 |
| "InvalidParameter" | InvalidParameter | timeField 不在枚举内 | 使用 update_time/found_time/last_time |
| "InvalidParameter" | InvalidParameter | 传入未定义字段 | 移除未定义字段 |
| "Unknown.SerComError" | Unknown.SerComError | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| "InternalError" | InternalError | 数据查询异常 | 缩小查询范围 |

## 最佳实践

1. **入参小驼峰**：使用 camelCase（baselineType/pageSize/lastId）
2. **出参小驼峰**：响应字段为 camelCase（assetId/businessName）
3. **additionalProperties: False**：禁止传入未定义字段
4. **lastId 翻页**：使用 lastId 翻页比 page 偏移更高效
5. **fixedStatus**：该字段不上 openapi 文档，仅供内部使用
6. **响应通道**：本接口走 v1_open_api 通道，**错误码为字符串** V1Error 语义码 `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`，判等用 `code == "Success"`

---
