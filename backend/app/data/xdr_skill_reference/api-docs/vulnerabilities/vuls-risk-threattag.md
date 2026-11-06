# GET /api/xdr/v1/vuls/risk/threattag

## 接口概述

本接口用于获取威胁标签列表（v1 OpenAPI 通道）。通过本接口，您可以获取以下内容：

### 可查询的威胁标签信息
- **威胁标签列表**：所有威胁标签枚举
- **是否包含空值**：通过 `need_empty` 控制是否返回空值威胁标签

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `V1ThreatTag` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:150`（注册于 `soar/apps/vuln_web/app/open_api/v1/vuls/__init__.py:26` → `/vuls/risk/threattag`，GET） |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:158` → `get_threat_tag(data)`（`open_api/v1/vuls/business.py:246`）→ 委托 `cget_threat_tag`（`view/vuln/common/business.py:58`）→ `MyStatistics.get_threat_tag` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/common/params.py:30` → `GET_THREAT_TAG`（由 `open_api/v1/vuls/params.py:41` import） |
| 版本归属 | v1（通配路由 `openapi_asm_vuls_wildcard_v1`，uris `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/risk/threattag`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 威胁标签查询 |
| 接口分类 | 元数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/list`（list 接口可用 `threatTags` 字段筛选） |

## 使用场景

1. **下拉选项**：在筛选器中加载威胁标签下拉选项
2. **统计维度**：作为风险列表的统计维度
3. **配置展示**：在配置页面展示所有威胁标签
4. **配合 list 接口**：先用本接口获取威胁标签，再用 list 接口的 `threatTags` 字段筛选

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | `/api/xdr/v1/vuls/risk/threattag`（通配：后端 `/order/v1/openapi/vuls/risk/threattag`） |
| Content-Type | 无需 |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.GET_THREAT_TAG, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **业务查询**：调用 `get_threat_tag(data)` 获取威胁标签列表
4. **响应封装**：调用 `output(data=get_threat_tag(data), v1_open_api=True)` 走 v1 OpenAPI 响应通道

### 数据转换逻辑

- 入参 `need_empty` 为字符串类型 `"true"`/`"false"`（非布尔）
- 出参为威胁标签列表

### 默认行为

- `need_empty` 默认为 `"true"`
- 不传 `need_empty` 时返回包含空值的威胁标签列表

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno（内部 errno `1001`/`1103`/`1104`/`1235` 不会出现在响应外层）
- **`need_empty` 字符串类型**：枚举值 `["true", "false"]`，非布尔
- **GET 方法**：本接口使用 GET 方法，参数通过 query string 传递
- **响应字段 item**：返回 `data.item` 列表，元素含 `value`（英文 key）/`label`（中文名）/`desc`（描述）；`need_empty=true` 时额外包含空值占位项

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求通常无请求体 |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| need_empty | string | 否 | "true" | 是否包含空值威胁标签，枚举 `["true", "false"]`（字符串，非布尔） | "true" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array&lt;object&gt; | 威胁标签列表 |

### item 元素结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| value | string | 威胁标签英文 key（接口过滤/关联用此值） | "Virus Exploit" |
| label | string | 威胁标签中文名称（展示用） | "病毒利用" |
| desc | string | 威胁标签描述 | "病毒传播过程中使用的漏洞" |

## 调用示例

### 示例 1：获取所有威胁标签（包含空值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/threattag?need_empty=true
```

**响应示例**（实测形态：item 元素含 `value`/`label`/`desc`）：
```json
{
  "code": "Success",
  "message": "成功",
  "data": {
    "item": [
      {"value": "Virus Exploit", "label": "病毒利用", "desc": "病毒传播过程中使用的漏洞"},
      {"value": "Hot Exploit", "label": "热点漏洞", "desc": "某段时间内热门或者紧急出现的漏洞"},
      {"value": "Active Vuln", "label": "活跃漏洞", "desc": "近一个月被攻击者频繁利用发起攻击的漏洞"}
    ]
  }
}
```

### 示例 2：获取威胁标签（不包含空值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/threattag?need_empty=false
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "成功",
  "data": {
    "item": [
      {"value": "Virus Exploit", "label": "病毒利用", "desc": "病毒传播过程中使用的漏洞"},
      {"value": "Hot Exploit", "label": "热点漏洞", "desc": "某段时间内热门或者紧急出现的漏洞"}
    ]
  }
}
```

### 示例 3：不传 need_empty（使用默认值）

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/threattag
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "成功",
  "data": {
    "item": [
      {"value": "Virus Exploit", "label": "病毒利用", "desc": "病毒传播过程中使用的漏洞"},
      {"value": "", "label": "未知", "desc": ""}
    ]
  }
}
```

### 示例 4：错误响应 - need_empty 不在枚举内

**请求示例**：
```http
GET /api/xdr/v1/vuls/risk/threattag?need_empty=yes
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

- `need_empty` 控制返回结果是否包含空值威胁标签
- 不传时使用默认值 `"true"`

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 威胁标签数量较少，查询性能良好
- 建议首次调用后缓存结果

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno
- **`need_empty` 字符串类型**：枚举值 `["true", "false"]`，非布尔
- 字段命名使用 snake_case
- GET 方法，参数通过 query string 传递
- **响应字段 item**：与 attacktype 一致，返回 `item` 字段

## 常见错误

| HTTP | code | 原因 | 解决方案 |
|------|------|------|----------|
| 400 | "InvalidParameter" | need_empty 不在 `["true", "false"]` 枚举内 | 使用字符串 "true"/"false" |
| 400 | "InvalidParameter" | need_empty 传了布尔值 true | 使用字符串 "true" |
| 403 | "Unknown.SerComError" | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| 500 | "InternalError" | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **字符串入参**：`need_empty` 传字符串 "true"/"false"，非布尔
2. **缓存结果**：威胁标签变化不频繁，建议业务侧缓存
3. **与 list 配合**：先用本接口获取威胁标签，再用 list 接口的 `threatTags` 字段筛选
4. **GET 方法**：参数通过 query string 传递，无需请求体
5. **响应通道**：本接口走 v1_open_api 通道，`code` 为语义字符串（如 `"Success"`），非整数

---
