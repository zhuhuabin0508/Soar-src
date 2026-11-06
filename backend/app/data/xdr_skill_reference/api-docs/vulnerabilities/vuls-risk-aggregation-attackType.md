# POST /api/xdr/v1/vuls/risk/aggregation/attackType

## 接口概述

本接口用于按攻击类型分组统计漏洞、脆弱性数量。通过本接口，您可以获取以下内容：

### 可查询的脆弱性聚合信息
- **聚合维度**：攻击类型（运行时字典数据，参考 enum-dictionary-pending.md）
- **聚合指标**：漏洞数量、弱密码数量
- **过滤条件**：修复优先级、风险等级、处置状态、脆弱性类型、时间范围

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `RiskAggAttackType` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:193`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:24` → `/vuls/risk/aggregation/attackType`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:206` → `get_risk_attack_type_count(data)`（`view/vuln/risk/business.py:421`）→ `MyVulRiskMiddle.risk_sum_count` + `MyVulRiskMiddle.risk_agg_count_by_attach_type` + `MyStatistics.get_attack_type` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:207` → `RISK_AGG_COUNT_SCHEMA`（与 aggregation/count 共用同一常量） |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/risk/aggregation/attackType` 经 etcd 具体路由 `openapi_asm_vuls_risk_aggregation_attackType_v1` 转后端 `/order/v2/openapi/vuls/risk/aggregation/attackType`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 风险聚合 |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/aggregation/count`、`/api/xdr/v1/vuls/risk/aggregation/loopholeLevel`、`/api/xdr/v1/vuls/risk/aggregation/baselineLevel` |

## 使用场景

1. **攻击类型分布**：按攻击类型聚合，展示各类攻击的漏洞数量分布
2. **重点关注**：识别漏洞数量最多的攻击类型，优先处置
3. **趋势分析**：与 trends 接口配合，先聚合当前状态，再查询时间趋势
4. **多维分析**：与 count/loopholeLevel 配合，从不同维度交叉分析
5. **风险画像**：作为风险画像的一部分，展示攻击面分布

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/aggregation/attackType` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_AGG_COUNT_SCHEMA, open_api=True)` 执行 JSON Schema 校验（复用 count 接口的 schema）
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=False)` 转换参数
4. **聚合查询**：调用 `get_risk_attack_type_count(new_data)`，按攻击类型聚合
5. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
6. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 数据转换逻辑

- 入参小驼峰 → 内部下划线
- 出参下划线 → 小驼峰
- 攻击类型字段（`attack_type`）为运行时字典数据，由 `MyStatistics.get_attack_type()` 返回，**无法从源码静态提取**（参考 enum-dictionary-pending.md P-2）

### 默认行为

- 不传时间时不自动填充默认时间
- 不传 `dataType` 时查询所有类型
- `sort` 未传时使用默认排序

### 特殊规则

- 与 count 接口共用 schema（`RISK_AGG_COUNT_SCHEMA`），但聚合维度固定为攻击类型
- 攻击类型字段为动态字典数据，**调用方需先调用 `/api/xdr/v1/vuls/risk/attacktype` 获取字典列表**

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数（与 /vuls/risk/aggregation/count 相同）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetGroupIds | array&lt;integer&gt; | 否 | - | 资产组 ID 列表 | [101] |
| assetBranchIds | array&lt;integer&gt; | 否 | - | 业务组 ID 列表 | [201] |
| platform_ids | array&lt;integer&gt; | 否 | - | 平台 ID 列表 | [1, 2] |
| riskLevels | array&lt;integer&gt; | 否 | - | 风险等级，参考 enum-dictionary-python.md。0/低, 1/中, 2/高, 3/严重 | [2, 3] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 处置状态（不上 OpenAPI 文档），参考 enum-dictionary-python.md | [0, 1] |
| fixPriority | array&lt;integer&gt; | 否 | - | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| limit | integer | 否 | - | ≥ 0 | 100 |
| startTimestamp | integer | 否 | - | ≥ 0 的 Unix 时间戳 | 1717200000 |
| endTimestamp | integer | 否 | - | ≥ 0 的 Unix 时间戳 | 1719800000 |
| timeField | string | 否 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/`found_time`/`last_time` | "found_time" |
| dataType | string | 否 | - | 脆弱性类型，参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码 | "loophole" |
| sort | string | 否 | - | 排序表达式，正则 `^(\w+(:asc|:desc)?)(,\w+(:asc|:desc)?){0,4}$`，可用字段 `count`/`riskCount`/`attackType` | "count:desc" |
| platformFilter | array&lt;object&gt; | 否 | - | 平台过滤条件，每元素含 `branchIds`/`platformId`/`groupIds`，`platformId` 必填。**`platformId` 必须是当前租户平台树中真实存在的 ID——传不存在的 platformId 会触发 `TypeError: 'NoneType' object is not iterable`** | [{"platformId":"P1","branchIds":[101]}] |

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
| attackType | string | 攻击类型（动态字典，参考 enum-dictionary-pending.md P-2） | 运行时字典数据 | "远程代码执行" |
| totalCount | integer | 漏洞数量 | - | 42 |

## 调用示例

### 示例 1：按攻击类型聚合漏洞数量

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "dataType": "loophole",
  "fixPriority": [2, 3],
  "sort": "count:desc",
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
      {"attackType": "远程代码执行", "totalCount": 42},
      {"attackType": "SQL注入", "totalCount": 18},
      {"attackType": "XSS跨站脚本", "totalCount": 7}
    ],
    "total": 3
  }
}
```

### 示例 2：按业务组过滤

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "last_time",
  "dataType": "weak_pwd",
  "assetBranchIds": [201],
  "sort": "count:desc"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "list": [
      {"attackType": "弱密码", "totalCount": 35}
    ],
    "total": 1
  }
}
```

### 示例 3：错误响应 - timeField 不在枚举内

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

- `attackType` 字段为运行时字典，无法从源码静态提取
- `dataType` 仅支持 `loophole`/`weak_pwd`，不支持 `baseline`
- `limit` 最小值 0

### 参数依赖关系

- 必须先调用 `/api/xdr/v1/vuls/risk/attacktype` 获取攻击类型字典，再调用本接口

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 攻击类型聚合数据量通常较少，limit 设置 20-50 即可
- 时间范围跨度建议 ≤ 90 天

### 数据一致性说明

- 响应字段为小驼峰命名
- 错误码使用 V1_ERROR_MAP 映射（trap #4）
- `attackType` 字段为运行时字典，需配合 attacktype 接口使用

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | timeField 不在枚举内 | 使用 `update_time`/`found_time`/`last_time` |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库聚合超时 | 缩小时间范围 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **先查字典**：先调用 `/api/xdr/v1/vuls/risk/attacktype` 获取攻击类型字典
2. **dataType 选择**：漏洞用 `loophole`，弱密码用 `weak_pwd`
3. **sort 配合 limit**：聚合后 sort + limit 取 TopN
4. **与 count 配合**：先用 count 看总数，再用 attackType 看分布
5. **时间范围**：建议按业务场景选择，避免全量扫描

---
