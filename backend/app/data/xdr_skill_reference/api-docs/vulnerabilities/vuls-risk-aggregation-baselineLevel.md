# POST /api/xdr/v1/vuls/risk/aggregation/baselineLevel

## 接口概述

本接口用于按基线风险等级聚合，获取对应风险等级的数量。通过本接口，您可以获取以下内容：

### 可查询的基线聚合信息
- **聚合维度**：基线风险等级（1/2/3）
- **聚合指标**：基线数量
- **过滤条件**：基线类型、等保级别、资产IP、责任人、业务组、资产组、资产标签、资产重要性、处置状态、时间范围

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `RiskAggBaselineLevel` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:236`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:26` → `/vuls/risk/aggregation/baselineLevel`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:249` → `get_risk_agg_baseline_level(data)`（`view/vuln/risk/business.py:698`）→ `MyBaselineRiskMiddle.get_risk_agg_baseline_level` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:249` → `RISK_AGG_BASELINE_LEVEL_SCHEMA` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/risk/aggregation/baselineLevel` 经 etcd 具体路由 `openapi_asm_vuls_risk_aggregation_baselineLevel_v1` 转后端 `/order/v2/openapi/vuls/risk/aggregation/baselineLevel`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 基线聚合 |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/aggregation/loopholeLevel`、`/api/xdr/v1/vuls/baseline/list` |

## 使用场景

1. **基线风险等级分布**：按基线风险等级聚合，展示低/中/高基线数量分布
2. **基线类型分析**：按基线类型过滤，分析不同基线类型的风险等级分布
3. **等保合规**：与等保级别过滤配合，展示等保合规基线的风险等级分布
4. **趋势分析**：与 trends 接口配合，先聚合当前状态，再查询时间趋势
5. **多维分析**：与 loopholeLevel 配合，从漏洞和基线两个维度分析风险

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/aggregation/baselineLevel` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_AGG_BASELINE_LEVEL_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=True)` 转换参数，**自动填充默认时间范围**
4. **聚合查询**：调用 `get_risk_agg_baseline_level(new_data)`，按基线风险等级聚合
5. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
6. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- 入参小驼峰 → 内部下划线
- 出参下划线 → 小驼峰
- `need_default_time_range=True`：自动填充默认时间范围

### 默认行为

- 不传 `startTimestamp`/`endTimestamp` 时**自动填充默认时间范围**
- 不传 `level` 时查询所有基线风险等级

### 特殊规则

- 与 loopholeLevel 不同，本接口聚合维度为基线风险等级（1/2/3）
- 支持 `level`（基线风险等级）、`baselineType`（基线类型）、`standard`（等保级别）三个基线专属过滤字段
- `fixedStatus` 字段不上 OpenAPI 文档

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| level | array&lt;integer&gt; | 否 | - | 基线风险等级，枚举 [1, 2, 3] | [2, 3] |
| baselineType | array&lt;string&gt; | 否 | - | 基线类型列表 | ["type1"] |
| standard | array&lt;integer&gt; | 否 | - | 等保级别，枚举 [1, 2, 3, 4, 5] | [3, 4] |
| startTimestamp | integer | 否 | 自动填充 | ≥ 0 的 Unix 时间戳 | 1717200000 |
| endTimestamp | integer | 否 | 自动填充 | ≥ 0 的 Unix 时间戳 | 1719800000 |
| timeField | string | 否 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/`found_time`/`last_time` | "found_time" |
| assetIp | string | 否 | - | 资产 IP 模糊匹配 | "192.168.1" |
| assetManager | string | 否 | - | 资产责任人 | "张三" |
| assetBranchIds | array&lt;integer&gt; | 否 | - | 业务组 ID 列表 | [201] |
| assetGroupIds | array&lt;integer&gt; | 否 | - | 资产组 ID 列表 | [101] |
| assetTags | array&lt;string&gt; | 否 | - | 资产标签列表 | ["tag1"] |
| assetMagnitudes | array&lt;string&gt; | 否 | - | 资产重要性，参考 enum-dictionary-python.md。`normal`/普通, `core`/核心 | ["core"] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 处置状态（不上 OpenAPI 文档），参考 enum-dictionary-python.md | [0, 1] |

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
| level | integer | 基线风险等级 | 1/2/3 | 3 |
| totalCount | integer | 基线数量 | - | 42 |

## 调用示例

### 示例 1：按基线风险等级聚合

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"level": 3, "totalCount": 12},
      {"level": 2, "totalCount": 35},
      {"level": 1, "totalCount": 88}
    ],
    "total": 3
  }
}
```

### 示例 2：按基线类型过滤

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "last_time",
  "baselineType": ["type1", "type2"],
  "level": [2, 3]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"level": 3, "totalCount": 8},
      {"level": 2, "totalCount": 23}
    ],
    "total": 2
  }
}
```

### 示例 3：按等保级别+资产责任人过滤

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "update_time",
  "standard": [3, 4],
  "assetManager": "张三"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"level": 3, "totalCount": 5},
      {"level": 2, "totalCount": 18},
      {"level": 1, "totalCount": 42}
    ],
    "total": 3
  }
}
```

### 示例 4：不传时间范围，使用默认

**请求示例**：
```json
{
  "timeField": "found_time",
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
      {"level": 3, "totalCount": 2},
      {"level": 2, "totalCount": 8}
    ],
    "total": 2
  }
}
```

### 示例 5：错误响应 - level 不在枚举内

**请求示例**：
```json
{
  "level": [0, 4]
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

- `level` 枚举值：1/2/3（与漏洞风险等级 -1/0/1/2/3 不同）
- `standard` 枚举值：1/2/3/4/5（等保级别）
- 无 `limit`/`sort`/`platformFilter` 字段

### 参数依赖关系

- `startTimestamp` 和 `endTimestamp` 可同时不传，自动填充默认时间范围
- `timeField` 与时间范围配套使用

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 时间范围跨度建议 ≤ 90 天
- `level`/`baselineType`/`standard` 过滤可大幅减少聚合数据量

### 数据一致性说明

- 响应字段为小驼峰命名
- 错误码使用 V1_ERROR_MAP 映射（trap #4）
- **基线风险等级 1/2/3**：与漏洞风险等级 -1/0/1/2/3 不同
- **自动时间范围**：与 count/attackType 不同，本接口自动填充默认时间

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | level 不在 [1,2,3] 枚举内 | 使用 1/2/3 |
| `"InvalidParameter"` | InvalidParameter | standard 不在 [1,2,3,4,5] 枚举内 | 使用 1/2/3/4/5 |
| `"InvalidParameter"` | InvalidParameter | timeField 不在枚举内 | 使用 `update_time`/`found_time`/`last_time` |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库聚合超时 | 缩小时间范围 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **level 枚举**：基线风险等级为 1/2/3，与漏洞风险等级不同
2. **standard 配合**：等保合规分析时传 `standard`
3. **时间范围可选**：不传时自动填充默认时间
4. **与 loopholeLevel 配合**：漏洞用 loopholeLevel，基线用 baselineLevel
5. **baseline/list 配合**：先用本接口看分布，再用 `/api/xdr/v1/vuls/baseline/list` 看明细

---
