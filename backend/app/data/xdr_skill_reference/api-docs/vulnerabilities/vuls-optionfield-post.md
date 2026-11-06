# POST /api/xdr/v1/vuls/optionfield

## 接口概述

本接口用于新增脆弱性自定义字段。通过本接口，您可以操作以下内容：

### 可操作的自定义字段信息
- **字段定义**：字段 key、字段名称、字段类型（字符串/数值/数值范围）
- **展示控制**：是否在表头展示
- **字段值列表**：可选值列表（用于下拉选择）
- **冲突处理**：字段冲突时的跳过/覆盖策略

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `OptionField` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:270`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:30` → `/vuls/optionfield`，GET/POST 同类） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:291` → `add_option_fields(data)`（`view/vuln/risk/business.py:814`）→ `MyModuleConfig.upsert_module_config`（字段类型校验委托 `verify_option` :792） |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:493` → `ADD_OPTION_FIELD` |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/optionfield` 经 etcd 具体路由 `openapi_asm_vuls_optionfield_v1` 转后端 `/order/v2/openapi/vuls/optionfield`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 自定义字段配置 |
| 接口分类 | 配置写入 |
| 前置依赖 | 建议先调用 GET `/api/xdr/v1/vuls/optionfield` 查看现有字段 |
| 关联接口 | GET `/api/xdr/v1/vuls/optionfield`、`/api/xdr/v1/risk/list`（list 接口支持 option 字段查询） |

## 使用场景

1. **新增自定义字段**：为业务添加自定义标签字段，用于业务分类
2. **字段值预定义**：为字段添加可选值列表，便于下拉选择
3. **冲突处理**：当字段已存在时，选择跳过或覆盖
4. **批量新增**：一次性添加多个自定义字段（最多 5 个）
5. **配合 list 接口**：新增字段后，通过 list 接口的 option 字段使用

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/optionfield` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.ADD_OPTION_FIELD, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=True)` 转换参数
4. **新增字段**：调用 `add_option_fields(new_data)`，写入数据库
5. **响应封装**：调用 `output(v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道（无 data 返回）

### 数据转换逻辑

- 入参小驼峰 → 内部下划线
- `need_default_time_range=True`：自动填充默认时间范围（虽然新增字段不需要时间范围，但 transform 函数会处理）

### 默认行为

- 不传 `conflictMethod` 时 schema 校验失败（必填）
- `conflictMethod` 默认为 0（跳过）

### 特殊规则

- **冲突处理**：`conflictMethod` 0-跳过（保留原值），1-覆盖（替换原值）
- 单次最多新增 5 个字段
- 每个 `values` 列表最多 96 个值
- 响应无 data，仅 code 和 message

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| option | array&lt;object&gt; | 是 | - | 自定义字段列表，minItems=1, maxItems=5 | 见下方 |
| conflictMethod | integer | 是 | - | 冲突操作，参考 enum-dictionary-python.md。0/跳过, 1/覆盖 | 0 |

#### option 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| key | string | 是 | 字段 key，符合 OPTION_STR 正则 | "custom_field_1" |
| name | string | 是 | 字段名称，符合 OPTION_STR 正则 | "业务标签" |
| isShow | boolean | 是 | 是否在表头展示 | true |
| valueType | integer | 是 | 属性值类型，枚举 [0, 1, 2]。0/字符串, 1/数值, 2/数值范围 | 0 |
| values | array&lt;object&gt; | 否 | 字段值列表，maxItems=96 | [{"name": "高风险", "value": "high"}] |

#### values 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | 值名称，符合 OPTION_STR 正则 | "高风险" |
| value | string | 是 | 值，符合 OPTION_STR 正则 | "high" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | integer | 响应码，成功时为整数 `0`（实测，**非字符串 "Success"**） |
| message | string | 响应消息 |
| data | null | 无 data 返回 |

## 调用示例

### 示例 1：新增字符串类型自定义字段

**请求示例**：
```json
{
  "option": [
    {
      "key": "business_tag",
      "name": "业务标签",
      "isShow": true,
      "valueType": 0,
      "values": [
        {"name": "高风险", "value": "high"},
        {"name": "中风险", "value": "middle"},
        {"name": "低风险", "value": "low"}
      ]
    }
  ],
  "conflictMethod": 0
}
```

**响应示例**：
```json
{
  "code": 0,
  "message": "Success",
  "data": null
}
```

### 示例 2：新增数值类型字段，冲突时覆盖

**请求示例**：
```json
{
  "option": [
    {
      "key": "score",
      "name": "评分",
      "isShow": false,
      "valueType": 1,
      "values": []
    }
  ],
  "conflictMethod": 1
}
```

**响应示例**：
```json
{
  "code": 0,
  "message": "Success",
  "data": null
}
```

### 示例 3：批量新增多个字段

**请求示例**：
```json
{
  "option": [
    {
      "key": "business_tag",
      "name": "业务标签",
      "isShow": true,
      "valueType": 0,
      "values": [{"name": "高风险", "value": "high"}]
    },
    {
      "key": "score",
      "name": "评分",
      "isShow": false,
      "valueType": 1,
      "values": []
    }
  ],
  "conflictMethod": 0
}
```

**响应示例**：
```json
{
  "code": 0,
  "message": "Success",
  "data": null
}
```

### 示例 4：错误响应 - 缺少必填字段

**请求示例**（缺少 `conflictMethod`）：
```json
{
  "option": [
    {
      "key": "business_tag",
      "name": "业务标签",
      "isShow": true,
      "valueType": 0
    }
  ]
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

### 示例 5：错误响应 - option 超过 maxItems

**请求示例**（6 个字段）：
```json
{
  "option": [
    {"key": "f1", "name": "字段1", "isShow": true, "valueType": 0},
    {"key": "f2", "name": "字段2", "isShow": true, "valueType": 0},
    {"key": "f3", "name": "字段3", "isShow": true, "valueType": 0},
    {"key": "f4", "name": "字段4", "isShow": true, "valueType": 0},
    {"key": "f5", "name": "字段5", "isShow": true, "valueType": 0},
    {"key": "f6", "name": "字段6", "isShow": true, "valueType": 0}
  ],
  "conflictMethod": 0
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

- `option` 列表长度 1-5
- 每个 `values` 列表最多 96 个值
- `key`/`name` 必须符合 OPTION_STR 正则（具体见 `vuln_web.app.common.params`）
- `valueType` 枚举 [0, 1, 2]

### 参数依赖关系

- `conflictMethod` 与 `option` 必填
- `values` 在 `valueType=1`（数值）时可为空，其他类型建议填充

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 单次新增 ≤ 5 个字段，超过会触发 schema 校验错误
- 字段已存在时使用 `conflictMethod=1` 覆盖，避免重复新增

### 数据一致性说明

- 响应字段为小驼峰命名
- **trap #4**：本接口使用默认 `output()` 通道，`code` 为**整数 errno**（成功为 `0`），与 v1_open_api 通道的字符串语义码（`"Success"`）不同
- `conflictMethod` 决定冲突处理策略

## 常见错误

| HTTP | code | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | 1104 | 缺少必填字段 | 补全 option 和 conflictMethod |
| 400 | 1104 | option 超过 maxItems=5 | 拆分多次请求 |
| 400 | 1104 | values 超过 maxItems=96 | 减少 values 数量 |
| 400 | 1104 | valueType 不在 [0,1,2] 枚举内 | 使用 0/1/2 |
| 403 | 1103 | 数据库写入失败 | 联系运维排查 |
| 500 | 1235 | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **先查后增**：先调用 GET `/api/xdr/v1/vuls/optionfield` 查看现有字段，避免重复
2. **conflictMethod 选择**：保留原值用 0（跳过），替换原值用 1（覆盖）
3. **values 预定义**：valueType=0 时建议预定义 values，便于下拉选择
4. **valueType 准确**：0-字符串模糊匹配，1-数值范围查询，2-数值区间查询
5. **批量新增**：单次最多 5 个字段，可分批新增

---
