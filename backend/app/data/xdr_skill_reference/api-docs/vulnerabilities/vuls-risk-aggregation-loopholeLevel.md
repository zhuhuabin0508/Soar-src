# POST /api/xdr/v1/vuls/risk/aggregation/loopholeLevel

## 接口概述

本接口用于按风险等级聚合，获取漏洞数量。通过本接口，您可以获取以下内容：

### 可查询的漏洞聚合信息
- **聚合维度**：风险等级（信息/低/中/高/严重）
- **聚合指标**：漏洞数量
- **过滤条件**：资产组、业务组、风险等级、处置状态、修复优先级、时间范围

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `RiskAggLoopholeLevel` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:214`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:25` → `/vuls/risk/aggregation/loopholeLevel`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:228` → `get_risk_agg_loophole_level(data)`（`view/vuln/risk/business.py:689`）→ `MyVulRiskMiddle.get_risk_agg_loophole_level`（view 层强制 `data_type="loophole"`） |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:233` → `RISK_AGG_LOOPHOLE_LEVEL_SCHEMA` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/risk/aggregation/loopholeLevel` 经 etcd 具体路由 `openapi_asm_vuls_risk_aggregation_loopholeLevel_v1` 转后端 `/order/v2/openapi/vuls/risk/aggregation/loopholeLevel`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 风险聚合 |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/aggregation/count`、`/api/xdr/v1/vuls/risk/aggregation/attackType`、`/api/xdr/v1/vuls/risk/aggregation/baselineLevel` |

## 使用场景

1. **风险等级分布**：按风险等级聚合，展示信息/低/中/高/严重的漏洞数量分布
2. **重点关注**：识别严重/高危漏洞数量，优先处置
3. **趋势分析**：与 trends 接口配合，先聚合当前状态，再查询时间趋势
4. **多维分析**：与 count/attackType 配合，从不同维度交叉分析
5. **风险画像**：作为风险画像的一部分，展示风险等级分布

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/aggregation/loopholeLevel` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_AGG_LOOPHOLE_LEVEL_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=True)` 转换参数，**自动填充默认时间范围**
4. **强制设置 dataType**：`new_data["data_type"] = "loophole"`，因为只有漏洞有风险等级（基线用 baselineLevel 接口）
5. **聚合查询**：调用 `get_risk_agg_loophole_level(new_data)`，按风险等级聚合
6. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
7. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- 入参小驼峰 → 内部下划线
- 出参下划线 → 小驼峰
- `need_default_time_range=True`：不传时间时**自动填充默认时间范围**（与 count/attackType 不同）
- 强制 `data_type = "loophole"`：忽略调用方传入的 dataType

### 默认行为

- 不传 `startTimestamp`/`endTimestamp` 时**自动填充默认时间范围**
- 强制 `dataType = "loophole"`

### 特殊规则

- **强制 dataType**：`new_data["data_type"] = "loophole"`，调用方传入的 dataType 被忽略
- **自动时间范围**：`need_default_time_range=True`，不传时间时自动填充
- 只有漏洞有风险等级，弱密码/基线无风险等级概念

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetGroupIds | array&lt;integer&gt; | 否 | - | 资产组 ID 列表 | [101] |
| assetBranchIds | array&lt;integer&gt; | 否 | - | 业务组 ID 列表 | [201] |
| riskLevels | array&lt;integer&gt; | 否 | - | 风险等级，参考 enum-dictionary-python.md。0/低, 1/中, 2/高, 3/严重 | [2, 3] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 处置状态（不上 OpenAPI 文档），参考 enum-dictionary-python.md | [0, 1] |
| fixPriority | array&lt;integer&gt; | 否 | - | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| startTimestamp | integer | 否 | 自动填充 | ≥ 0 的 Unix 时间戳 | 1717200000 |
| endTimestamp | integer | 否 | 自动填充 | ≥ 0 的 Unix 时间戳 | 1719800000 |
| timeField | string | 否 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/`found_time`/`last_time` | "found_time" |

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
| list | array&lt;object&gt; | 聚合结果列表 |
| total | integer | 聚合分组总数 |

### list 元素结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| riskLevel | integer | 风险等级，参考 enum-dictionary-python.md | -1/信息, 0/低, 1/中, 2/高, 3/严重 | 3 |
| totalCount | integer | 漏洞数量 | - | 42 |

## 调用示例

### 示例 1：按风险等级聚合漏洞数量

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "fixPriority": [2, 3]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"riskLevel": 3, "totalCount": 12},
      {"riskLevel": 2, "totalCount": 35},
      {"riskLevel": 1, "totalCount": 88},
      {"riskLevel": 0, "totalCount": 4},
      {"riskLevel": -1, "totalCount": 2}
    ],
    "total": 5
  }
}
```

### 示例 2：不传时间范围，使用默认

**请求示例**：
```json
{
  "timeField": "last_time",
  "assetBranchIds": [201]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"riskLevel": 3, "totalCount": 5},
      {"riskLevel": 2, "totalCount": 18}
    ],
    "total": 2
  }
}
```

### 示例 3：按业务组+风险等级过滤

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "update_time",
  "assetBranchIds": [201, 202],
  "riskLevels": [2, 3],
  "fixedStatus": [0, 1]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"riskLevel": 3, "totalCount": 8},
      {"riskLevel": 2, "totalCount": 23}
    ],
    "total": 2
  }
}
```

### 示例 4：错误响应 - timeField 不在枚举内

**请求示例**：
```json
{
  "timeField": "invalid_field"
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

- `dataType` 字段被强制设为 `"loophole"`，调用方传入的值被忽略
- `riskLevels` 枚举值：-1/0/1/2/3（信息/低/中/高/严重）
- 无 `limit`/`sort`/`platformFilter` 字段

### 参数依赖关系

- `startTimestamp` 和 `endTimestamp` 可同时不传，自动填充默认时间范围
- `timeField` 与时间范围配套使用

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 时间范围跨度建议 ≤ 90 天
- `fixPriority`/`riskLevels` 过滤可大幅减少聚合数据量

### 数据一致性说明

- 响应字段为小驼峰命名
- 错误码使用 V1_ERROR_MAP 映射（trap #4）
- **强制 dataType = "loophole"**：弱密码/基线无风险等级，调用方传 dataType 无效
- **自动时间范围**：与 count/attackType 不同，本接口自动填充默认时间

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | timeField 不在枚举内 | 使用 `update_time`/`found_time`/`last_time` |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库聚合超时 | 缩小时间范围 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **不传 dataType**：dataType 被强制为 `loophole`，无需传
2. **时间范围可选**：不传时自动填充默认时间，但建议显式传入
3. **riskLevels 过滤**：业务看板建议 [2, 3] 只看中高风险
4. **与 count 配合**：先用 count 看总数，再用 loopholeLevel 看风险等级分布
5. **基线用 baselineLevel**：基线风险等级聚合用 `/vuls/risk/aggregation/baselineLevel`

---
