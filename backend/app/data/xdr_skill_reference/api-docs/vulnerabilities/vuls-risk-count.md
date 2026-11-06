# POST /api/xdr/v1/vuls/risk/count

## 接口概述

本接口用于获取指定的未处置漏洞数量（v1 OpenAPI 通道）。通过本接口，您可以获取以下内容：

### 可查询的数量信息
- **未处置漏洞数量**：高风险未处置漏洞数量统计
- **临时方案**：本接口为临时方案，输入参数实际不参与查询，仅返回未处置高风险漏洞数量

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `V1VulCount` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:123`（注册于 `soar/apps/vuln_web/app/open_api/v1/vuls/__init__.py:24` → `/vuls/risk/count`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:133` → `get_high_undisposed_vulns()`（`open_api/v1/vuls/business.py:221`）→ 委托 `get_risk_statistics`（`view/vuln/risk/business.py:523`）→ `MyVulRiskMiddle.get_risk_statistics` |
| 请求 Schema | `soar/apps/vuln_web/app/open_api/v1/vuls/params.py:153` → `RISK_COUNT_SCHEMA` |
| 版本归属 | v1（通配路由 `openapi_asm_vuls_wildcard_v1`，uris `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/risk/count`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 未处置漏洞数量查询 |
| 接口分类 | 数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/list` |

## 使用场景

1. **云图展示**：用于云图大屏展示未处置漏洞数量
2. **资产总览一致性**：与资产总览数据保持一致（避免资产总览改动未同步）
3. **临时方案**：作为临时方案，后续需要进一步调整
4. **监控告警**：监控未处置漏洞数量，触发告警

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/count`（通配：后端 `/order/v1/openapi/vuls/risk/count`） |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_COUNT_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **参数转换**：调用 `transform_params(data)` 将小驼峰转换为下划线（**注意：转换后未使用！**）
4. **业务查询**：调用 `get_high_undisposed_vulns()` 获取未处置高风险漏洞数量（**注意：未传入参数！**）
5. **响应转换**：调用 `snake_to_camel(result)` 将下划线转换为小驼峰
6. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 v1 OpenAPI 响应通道

### 数据转换逻辑

- 入参使用小驼峰命名（camelCase）
- 通过 `transform_params` 转换为下划线命名（**但实际未使用**）
- 出参通过 `snake_to_camel` 转换为小驼峰

### 默认行为

- `dataType`/`fixedStatus`/`fixPriority` 必填
- `additionalProperties: False`，禁止未定义字段
- 业务层固定查询未处置高风险漏洞数量（忽略入参）

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno（内部 errno `1001`/`1103`/`1104`/`1235` 不会出现在响应外层）
- **trap：入参实际不参与查询**：`get_high_undisposed_vulns()` 不接收 `new_data` 参数，固定查询未处置高风险漏洞数量
- **临时方案**：业务层注释说明"为了保证和资产总览数据一致性，直接调用资产总览的方法"
- **additionalProperties: False**：禁止传入未定义字段
- **required 三个字段**：`dataType`/`fixedStatus`/`fixPriority` 全部必填（拼写正确，正常触发校验）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| dataType | string | 是 | - | 脆弱性类型，参考 enum-dictionary-python.md RISK_TYPE_STRING（**实际不参与查询**） | "loophole" |
| fixedStatus | array&lt;integer&gt; | 是 | - | 修复状态（**实际不参与查询**） | [0] |
| fixPriority | array&lt;integer&gt; | 是 | - | 修复优先级（**实际不参与查询**） | [3] |
| platform_ids | array&lt;string&gt; | 否 | - | 平台 ID 列表（**实际不参与查询**） | ["plat1"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| count | integer | 未处置高风险漏洞数量 | 5 |

## 调用示例

### 示例 1：查询未处置高风险漏洞数量

**请求示例**：
```json
{
  "dataType": "loophole",
  "fixedStatus": [0],
  "fixPriority": [3]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "成功",
  "data": {
    "count": 5
  }
}
```

### 示例 2：错误响应 - 缺少必填字段

**请求示例**（缺少 `fixPriority`）：
```json
{
  "dataType": "loophole",
  "fixedStatus": [0]
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

### 示例 3：错误响应 - 传入未定义字段

**请求示例**：
```json
{
  "dataType": "loophole",
  "fixedStatus": [0],
  "fixPriority": [3],
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

## 注意事项与限制

### 参数限制

- `dataType`/`fixedStatus`/`fixPriority` 三个字段全部必填
- `additionalProperties: False`，禁止传入未定义字段
- **入参实际不参与查询**：业务层固定查询未处置高风险漏洞数量

### 参数依赖关系

- 三个必填字段必须同时提供，但实际不参与业务查询
- 业务层固定查询 `data_type=["loophole"], un_disposed_high=True` 的漏洞数量

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 查询性能良好，单次返回单条数据
- 建议缓存结果，避免频繁调用

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno
- **trap：入参实际不参与查询**：`get_high_undisposed_vulns()` 不接收参数，固定查询未处置高风险漏洞数量
- **临时方案**：业务层注释说明为保证与资产总览数据一致性
- **入参小驼峰**：使用 camelCase（dataType/fixedStatus/fixPriority）
- **出参小驼峰**：响应字段为 camelCase（count）
- **固定查询**：业务层固定查询 `data_type=["loophole"], un_disposed_high=True`

## 常见错误

| HTTP | code | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | "InvalidParameter" | 缺少 dataType/fixedStatus/fixPriority | 补全三个必填字段 |
| 400 | "InvalidParameter" | 传入未定义字段 | 移除未定义字段 |
| 403 | "Unknown.SerComError" | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| 500 | "InternalError" | 系统繁忙，请稍后再试 | 联系运维排查 |

## 最佳实践

1. **三个必填字段**：必须同时提供 dataType/fixedStatus/fixPriority（但实际不参与查询）
2. **入参小驼峰**：使用 camelCase（dataType/fixedStatus/fixPriority）
3. **临时方案**：本接口为临时方案，后续可能调整
4. **响应通道**：本接口走 v1_open_api 通道，`code` 为语义字符串（如 `"Success"`），非整数
5. **固定查询**：业务层固定查询未处置高风险漏洞数量，与入参无关

---
