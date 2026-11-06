# GET /api/xdr/v1/vuls/risk/attacktype

## 接口概述

本接口用于获取漏洞攻击类型列表（v1 OpenAPI 通道，vuls 路径下）。通过本接口，您可以获取以下内容：

### 可查询的攻击类型信息
- **攻击类型列表**：所有漏洞攻击类型枚举
- **是否包含空值**：通过 `need_empty` 控制是否返回空值攻击类型

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `V1AttackType` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py` |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/vuls/business.py` → `get_attack_type(data)`（委托 `soar/apps/vuln_web/app/view/vuln/common/business.py` → `get_attack_type`） |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/common/params.py` → `GET_ATTACK_TYPE`（vuls/params.py 原样导入） |
| 版本归属 | v1（通配路由 `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/$1`） |
| 所属业务域 | 脆弱性管理 - 攻击类型查询（vuls） |
| 接口分类 | 元数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/list`（list 接口可用 `attackTypes` 字段筛选）、`/api/xdr/v1/vuls/risk/aggregation/attackType`（v2 聚合接口以本接口为字典前置） |

## 使用场景

1. **下拉选项**：在筛选器中加载攻击类型下拉选项
2. **统计维度**：作为风险列表的统计维度
3. **配合 list 接口**：先用本接口获取攻击类型，再用 list 接口的 `attackTypes` 字段筛选

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | `/api/xdr/v1/vuls/risk/attacktype`（通配：后端 `/order/v1/openapi/vuls/risk/attacktype`） |
| Content-Type | 无需 |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.GET_ATTACK_TYPE, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **业务查询**：调用 `get_attack_type(data)` 获取攻击类型列表
4. **响应封装**：调用 `output(data=get_attack_type(data), v1_open_api=True)` 走 v1 OpenAPI 响应通道

### 数据转换逻辑

- 入参 `need_empty` 为字符串类型 `"true"`/`"false"`（非布尔）
- 出参为攻击类型列表

### 默认行为

- `need_empty` 默认为 `"true"`
- 不传 `need_empty` 时返回包含空值的攻击类型列表

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，外层 `code` 为 V1_ERROR_MAP 映射后的字符串（`"Success"`/`"Unknown.SerComError"`/`"InvalidParameter"`/`"InternalError"`），不是整数 errno
- **`need_empty` 字符串类型**：枚举值 `["true", "false"]`，非布尔
- **GET 方法**：本接口使用 GET 方法，参数通过 query string 传递

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求通常无请求体 |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| need_empty | string | 否 | "true" | 是否包含空值攻击类型，枚举 `["true", "false"]`（字符串，非布尔） | "true" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码（trap #4：v1_open_api 通道返回 V1_ERROR_MAP 映射后的字符串 `"Success"`/`"Unknown.SerComError"`/`"InvalidParameter"`/`"InternalError"`，不是整数 errno） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array&lt;object&gt; | 攻击类型列表 |

### item 元素结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| label | string | 攻击类型中文名称 | "会话劫持" |
| value | string | 攻击类型英文键（作为 list 接口 `attackTypes` 的筛选值） | "Session Hijacking" |

## 调用示例

### 示例 1：获取所有攻击类型（包含空值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/attacktype?need_empty=true
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "Success",
  "data": {
    "item": [
      {"label": "会话劫持", "value": "Session Hijacking"},
      {"label": "变量覆盖", "value": "variable coverage"},
      {"label": "代码执行", "value": "Code Execution"},
      {"label": "拒绝服务", "value": "DoS"},
      {"label": "无漏洞类型", "value": "No Vulnerability Types"}
    ]
  }
}
```

### 示例 2：获取攻击类型（不包含空值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/attacktype?need_empty=false
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "Success",
  "data": {
    "item": [
      {"label": "会话劫持", "value": "Session Hijacking"},
      {"label": "变量覆盖", "value": "variable coverage"},
      {"label": "代码执行", "value": "Code Execution"},
      {"label": "拒绝服务", "value": "DoS"}
    ]
  }
}
```

### 示例 3：不传 need_empty（使用默认值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/attacktype
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "Success",
  "data": {
    "item": [
      {"label": "会话劫持", "value": "Session Hijacking"},
      {"label": "无漏洞类型", "value": "No Vulnerability Types"}
    ]
  }
}
```

### 示例 4：错误响应 - need_empty 不在枚举内

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/attacktype?need_empty=yes
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

- `need_empty` 为字符串类型，非布尔（避免传入 `true` 布尔值）
- 枚举值固定为 `["true", "false"]`

### 参数依赖关系

- `need_empty` 控制返回结果是否包含空值攻击类型
- 不传时使用默认值 `"true"`

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 攻击类型数量较少，查询性能良好
- 建议首次调用后缓存结果

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，外层 `code` 为 V1_ERROR_MAP 映射后的字符串（`"Success"`/`"Unknown.SerComError"`/`"InvalidParameter"`/`"InternalError"`），不是整数 errno
- **`need_empty` 字符串类型**：枚举值 `["true", "false"]`，非布尔
- 字段命名使用 snake_case
- GET 方法，参数通过 query string 传递

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| InvalidParameter | InvalidParameter | need_empty 不在 `["true", "false"]` 枚举内 | 使用字符串 "true"/"false" |
| InvalidParameter | InvalidParameter | need_empty 传了布尔值 true | 使用字符串 "true" |
| Unknown.SerComError | Access Deny | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| InternalError | InternalError | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **字符串入参**：`need_empty` 传字符串 "true"/"false"，非布尔
2. **缓存结果**：攻击类型变化不频繁，建议业务侧缓存
3. **与 list 配合**：先用本接口获取攻击类型，再用 list 接口的 `attackTypes` 字段筛选
4. **GET 方法**：参数通过 query string 传递，无需请求体
5. **响应通道**：本接口走 v1_open_api 通道，外层 `code` 为字符串（`"Success"`/`"Unknown.SerComError"`/`"InvalidParameter"`/`"InternalError"`），不是整数 errno

---
