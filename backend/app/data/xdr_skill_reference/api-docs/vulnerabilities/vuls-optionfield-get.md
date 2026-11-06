# GET /api/xdr/v1/vuls/optionfield

## 接口概述

本接口用于获取脆弱性自定义字段配置。通过本接口，您可以获取以下内容：

### 可查询的自定义字段信息
- **字段定义**：字段 key、字段名称、字段类型（字符串/数值/数值范围）、字段值列表
- **展示控制**：是否在表头展示、是否作为过滤条件
- **冲突处理**：与 POST 接口配合，处理字段冲突时的跳过/覆盖策略

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `OptionField` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:270`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:30` → `/vuls/optionfield`，GET/POST 同类） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:279` → `get_option_fields(data)`（`view/vuln/risk/business.py:755`）→ `get_option_field_list`(:745) → `MyModuleConfig.get_module_config(OptionFieldConfig)` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:539` → `GET_OPTION_FIELD` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/optionfield` 经 etcd 具体路由 `openapi_asm_vuls_optionfield_v1` 转后端 `/order/v2/openapi/vuls/optionfield`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 自定义字段配置 |
| 接口分类 | 配置查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | POST `/api/xdr/v1/vuls/optionfield`（新增自定义字段）、`/api/xdr/v1/risk/list`（list 接口支持 option 字段查询） |

## 使用场景

1. **表头展示**：调用本接口获取自定义字段列表，决定表头展示哪些自定义字段
2. **过滤条件**：调用本接口获取可作为过滤条件的自定义字段，用于筛选漏洞列表
3. **配置预览**：在新增自定义字段前，调用本接口查看现有字段，避免重复
4. **配合 list 接口**：与 `/api/xdr/v1/risk/list` 配合，在列表展示和过滤中使用自定义字段
5. **配合 POST 接口**：与 POST `/api/xdr/v1/vuls/optionfield` 配合，先查询再新增

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | `/api/xdr/v1/vuls/optionfield` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.GET_OPTION_FIELD, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **字段查询**：调用 `get_option_fields(data)`，根据 `is_show`/`is_filter` 参数返回对应字段列表
4. **响应封装**：调用 `output(data=get_option_fields(data))` 走默认响应通道

### 数据转换逻辑

- 入参 `is_show`/`is_filter` 为字符串类型 `"true"`/`"false"`（非布尔）
- 出参为自定义字段对象列表

### 默认行为

- 不传 `is_show` 时返回所有字段
- 不传 `is_filter` 时返回所有字段（包含可作为过滤条件和非过滤条件的字段）

### 特殊规则

- **`is_show`/`is_filter` 为字符串类型**：枚举值 `["true", "false"]`，非布尔
- 接口允许 GET 方法（与 POST 共用同一 Resource）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求通常无请求体 |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| is_show | string | 否 | - | 表头是否展示，枚举 `["true", "false"]`（字符串，非布尔） | "true" |
| is_filter | string | 否 | - | 是否返回过滤条件，枚举 `["true", "false"]`（字符串，非布尔） | "true" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | integer | 响应码，成功时为整数 `0`（实测，**非字符串 "Success"**） |
| message | string | 响应消息 |
| data | array&lt;object&gt; | 响应数据，**裸数组**（实测，**非 `{list:[...]}` 对象**） |

> ⚠️ **容器类型提示（实测）**：`data` 是**裸数组**，元素直接为自定义字段对象，**没有 `list` 包装层**。照 `{list:[...]}` 解析会取不到数据（f17 同类结构性错误）。

### data 元素结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| key | string | 字段 key | "business_tag_x" |
| name | string | 字段名称 | "business_tag_x" |
| filter_data | array&lt;object&gt; | 该字段可作为过滤条件的取值列表（实测字段名，**非 `values`**） | [{"name": "high", "value": "high"}] |

### filter_data 元素结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 值名称 | "high" |
| value | string | 值 | "high" |

> **说明**：实测响应中**未出现** `isShow`、`valueType`、`values` 字段——这些是本接口**入参**（见 POST `/api/xdr/v1/vuls/optionfield`）的概念，出参以 `filter_data` 呈现可过滤取值。请勿照 `isShow/valueType/values` 解析出参。

## 调用示例

### 示例 1：获取所有自定义字段

**请求示例**：
```http
GET /api/xdr/v1/vuls/optionfield
```

**响应示例**（实测形态：`data` 为裸数组）：
```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "key": "business_tag_x",
      "name": "business_tag_x",
      "filter_data": [
        {"name": "high", "value": "high"},
        {"name": "middle", "value": "middle"},
        {"name": "low", "value": "low"}
      ]
    }
  ]
}
```

### 示例 2：只获取展示在表头的字段

**请求示例**：
```http
GET /api/xdr/v1/vuls/optionfield?is_show=true
```

**响应示例**：
```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "key": "business_tag_x",
      "name": "business_tag_x",
      "filter_data": [{"name": "high", "value": "high"}]
    }
  ]
}
```

### 示例 3：只获取可作为过滤条件的字段

**请求示例**：
```http
GET /api/xdr/v1/vuls/optionfield?is_filter=true
```

**响应示例**：
```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "key": "business_tag_x",
      "name": "business_tag_x",
      "filter_data": [{"name": "high", "value": "high"}]
    }
  ]
}
```

### 示例 4：错误响应 - is_show 不在枚举内

**请求示例**：
```http
GET /api/xdr/v1/vuls/optionfield?is_show=yes
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

- `is_show`/`is_filter` 为字符串类型，非布尔（trap：避免传入 `true` 布尔值）
- 枚举值固定为 `["true", "false"]`

### 参数依赖关系

- 两个参数相互独立，可单独使用或组合使用

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 自定义字段数量通常较少，查询性能良好
- 建议首次调用后缓存结果

### 数据一致性说明

- 响应字段为小驼峰命名
- **trap #4**：本接口使用默认 `output()` 通道，`code` 为**整数 errno**（成功为 `0`），与 v1_open_api 通道的字符串语义码（`"Success"`）不同；**非** 200
- `is_show`/`is_filter` 入参为字符串类型
- **出参容器为裸数组**：`data` 直接是字段对象数组，无 `list` 包装；元素键为 `key`/`name`/`filter_data`（实测）

## 常见错误

| HTTP | code | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | 1104 | is_show/is_filter 不在 `["true", "false"]` 枚举内 | 使用字符串 "true"/"false" |
| 500 | 1235 | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **字符串入参**：`is_show`/`is_filter` 传字符串 "true"/"false"，非布尔
2. **缓存结果**：自定义字段配置变化不频繁，建议业务侧缓存
3. **与 list 配合**：先用本接口获取字段，再用 list 接口的 option 字段查询
4. **与 POST 配合**：先查询现有字段，再决定是否新增
5. **按实测结构解析出参**：`data` 为裸数组，元素取 `key`/`name`/`filter_data`；过滤取值来自 `filter_data`（`{name,value}` 列表），不要按 `isShow`/`valueType`/`values` 解析（那是 POST 入参概念）

---
