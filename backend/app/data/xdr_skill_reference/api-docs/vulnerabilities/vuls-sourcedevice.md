# GET /api/xdr/v1/vuls/sourcedevice

## 接口概述

本接口用于获取脆弱性数据源列表（v1 OpenAPI 通道）。通过本接口，您可以获取以下内容：

### 可查询的数据源信息
- **数据源列表**：所有支持的数据源设备列表
- **数据源元数据**：数据源 ID、名称、类型等基础信息

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `V1SourceDevice` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:31`（注册于 `soar/apps/vuln_web/app/open_api/v1/vuls/__init__.py:20` → `/vuls/sourcedevice`，GET） |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/vuls/views.py:38` → `get_source_device()`（`view/vuln/common/business.py:163`）→ `DeviceInformation.get_devices` + 静态枚举 `SOURCE_DEVICE_INFO` |
| 请求 Schema | 无（GET handler 未加 `@frontend_validate`） |
| 版本归属 | v1（通配路由 `openapi_asm_vuls_wildcard_v1`，uris `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/sourcedevice`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 数据源查询 |
| 接口分类 | 元数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/risk/list`（list 接口可用 `source_device` 字段筛选） |

## 使用场景

1. **下拉选项**：在筛选器中加载数据源下拉选项
2. **统计维度**：作为风险列表的统计维度
3. **配置展示**：在配置页面展示所有数据源
4. **配合 list 接口**：先用本接口获取数据源列表，再用 list 接口的 `source_device` 字段筛选

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | `/api/xdr/v1/vuls/sourcedevice`（通配：后端 `/order/v1/openapi/vuls/sourcedevice`） |
| Content-Type | 无需 |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **权限校验**：`@auth_expr` 装饰器校验 `superAdmin` 或 `riskManageQuery` 权限
2. **业务查询**：调用 `get_source_device()` 获取数据源列表
3. **响应封装**：调用 `output(data=get_source_device(), v1_open_api=True)` 走 v1 OpenAPI 响应通道

### 数据转换逻辑

- 无入参
- 出参保留原始字段命名

### 默认行为

- 无入参，直接返回所有数据源

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），**不是整数 errno**（内部 errno `1001`/`1103`/`1104`/`1235` 不会出现在响应外层）
- **无 JSON Schema 校验**：本接口未使用 `@frontend_validate` 装饰器，不进行参数校验
- **GET 方法**：本接口使用 GET 方法，无请求体

## 请求参数

### 请求头

无特殊请求头。

### 请求体参数

无（GET 方法，无请求体）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | array&lt;object&gt; | 响应数据（数据源列表） |

### data 元素结构说明

> ⚠️ **树形结构**：`data` 为顶层设备数组，元素通过 `children` 字段**递归嵌套**子设备（有子设备的节点带 `children` 数组，叶子节点 `children` 为 `[]`）。解析时需**递归遍历**，不能只读顶层。

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 数据源/设备 ID | "edr" |
| name | string | 数据源/设备名称 | "终端安全检测响应系统EDR" |
| is_upload_device | boolean | 是否为上报设备（树中部分节点不返回此字段） | true |
| children | array&lt;object&gt; | 子设备列表，元素结构与顶层相同（递归）；叶子节点为 `[]` | [{"id":"26607236401","name":"EDR_002","is_upload_device":true,"children":[]}] |

## 调用示例

### 示例 1：获取数据源列表

**请求示例**：
```http
GET /api/xdr/v1/vuls/sourcedevice
```

**响应示例**（实测：树形 `children` 递归）：
```json
{
  "code": "Success",
  "message": "成功",
  "data": [
    {"id": "cwpp", "name": "云主机安全保护平台CWPP", "is_upload_device": true},
    {
      "id": "edr",
      "name": "终端安全检测响应系统EDR",
      "is_upload_device": true,
      "children": [
        {"id": "26607236401", "name": "EDR_002", "is_upload_device": true, "children": []},
        {"id": "14660236624", "name": "EDR_001", "is_upload_device": true, "children": []}
      ]
    },
    {"id": "nsfocus", "name": "绿盟RSAS", "children": []}
  ]
}
```

### 示例 2：错误响应 - 权限不足

**请求示例**：
```http
GET /api/xdr/v1/vuls/sourcedevice
```

**错误响应示例**：
```json
{
  "code": "Success",
  "message": "成功",
  "data": []
}
```

## 注意事项与限制

### 参数限制

- 无入参，GET 方法直接调用

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- 数据源数量较少，查询性能良好
- 建议首次调用后缓存结果

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，`code` 为 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno（内部 errno `1001`/`1103`/`1104`/`1235` 不会出现在响应外层）
- **无 JSON Schema 校验**：未使用 `@frontend_validate`，不进行参数校验
- 与 v1 risk 通道差异：risk 通道的 `output(open_api=True)` 返回 `str(code)`（如 `"0"`），v1_open_api 通道返回 V1_ERROR_MAP 语义字符串（如 `"Success"`），两者都不是整数

## 常见错误

| HTTP | code | message | 原因 | 解决方案 |
|------|------|---------|------|----------|
| 403 | "Unknown.SerComError" | Access Deny | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| 500 | "InternalError" | 系统繁忙，请稍后再试 | 系统内部异常 | 联系运维排查 |

## 最佳实践

1. **缓存结果**：数据源变化不频繁，建议业务侧缓存
2. **与 list 配合**：先用本接口获取数据源，再用 list 接口的 `source_device` 字段筛选
3. **响应通道**：本接口走 v1_open_api 通道，`code` 为语义字符串（如 `"Success"`），非整数
4. **GET 方法**：无请求体，直接调用

---
