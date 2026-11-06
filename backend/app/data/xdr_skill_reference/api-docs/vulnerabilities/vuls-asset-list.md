# POST /api/xdr/v1/vuls/asset/list

## 接口概述

本接口用于获取资产视角的漏洞与弱密码数据列表（v1 OpenAPI 通道）。通过本接口，您可以获取以下内容：

### 可查询的风险信息
- **资产风险列表**：按资产维度组织的漏洞/弱密码数据
- **过滤条件**：修复优先级、脆弱性类型、资产 ID、IP、威胁标签、风险等级、修复状态
- **MD5 资产 ID 过滤**：通过 `md5_name_assets` 数组指定资产 ID 集合（最多 100 个）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `AssetVulWeakPwdList` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/asset_vuln/views.py:101`（注册于 `soar/apps/vuln_web/app/open_api/v1/vuls/__init__.py:28` → `/vuls/asset/list`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/asset_vuln/views.py:114` → `get_asset_risk_list(data)`（`view/vuln/asset_vuln/business.py:595`）→ 依 `data_type` 委托 `MyVmVulnerability.get_weak_pwd_list` / `MyVmVulnerability.get_loophole_list`，再经 `_build_asset_risk_list`(:96) 拼装 |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/asset_vuln/params.py:211` → `ASSET_VUL_WEAK_PWD_LIST_SCHEMA` |
| 版本归属 | v1（通配路由 `openapi_asm_vuls_wildcard_v1`，uris `/api/xdr/v1/vuls/*` → 后端 `/order/v1/openapi/vuls/asset/list`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - **资产视角**风险列表 |
| 数据源表 | `host_vul_middle`（**资产视角中间表**，按资产-漏洞关联组织记录） |
| 接口分类 | 数据查询 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/list`（风险视角列表） |

> **风险视角 vs 资产视角（关键区分）**：本接口属于**资产视角**，数据源是 `host_vul_middle` 表，与前端"资产漏洞列表"页面一致。**风险视角**接口（如 `POST /api/xdr/v1/risk/list`、`POST /api/xdr/v1/vuls/risk/aggregation/count`）数据源是 `vul_risk_middle` 表，与前端"漏洞风险列表"页面一致。两个视角数据同步存在时差、字段映射差异，统计同一需求可能得到不同结果（实测同一筛选条件下资产视角 6 条 vs 风险视角 16 条）。**需求中出现"漏洞风险列表/漏洞风险数量"时，应选风险视角接口，不要选本接口（资产视角）**。

## 使用场景

1. **资产维度查询**：按资产维度组织风险列表
2. **批量资产查询**：通过 `assetIds` 或 `md5_name_assets` 指定资产集合（最多 100 个 md5）
3. **关键字搜索**：通过 `name` 模糊匹配漏洞名称
4. **风险筛选**：按 `riskLevel`、`fixPriority`、`threatTags` 筛选

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/asset/list`（通配：后端 `/order/v1/openapi/vuls/asset/list`） |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.ASSET_VUL_WEAK_PWD_LIST_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **特殊字段处理**：调用 `transform_special_params(data)` 处理特殊字段
4. **驼峰转下划线**：调用 `transform_params(new_data)` 将小驼峰转换为下划线
5. **业务查询**：调用 `get_asset_risk_list(new_data)` 获取资产风险列表
6. **响应转换**：调用 `snake_to_camel(result)` 将下划线转换为小驼峰
7. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 v1 OpenAPI 响应通道

### 数据转换逻辑

- 入参使用小驼峰命名（camelCase），但 `md5_name_assets` 例外（snake_case）
- 通过 `transform_params` 转换为下划线命名（snake_case）
- 出参通过 `snake_to_camel` 转换为小驼峰
- `additionalProperties: False`，禁止未定义字段

### 默认行为

- `dataType` 必填
- 无结果时返回空列表

### 特殊规则

- **trap #4（响应通道）**：本接口走 `output(v1_open_api=True)` 通道，错误码为字符串 `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`（**字符串非整数**，V1_ERROR_MAP 把整数 errno 映射为字符串语义码）
- **dataType 必填**：`required: ["dataType"]`
- **md5_name_assets maxItems=100**：MD5 资产 ID 列表最多 100 个，uniqueItems=true
- **md5_name_assets snake_case**：与其他字段的 camelCase 不同，本字段使用 snake_case（trap：避免转换问题）
- **additionalProperties: False**：禁止传入未定义字段
- **三段转换链**：特殊字段处理 → 驼峰转下划线 → 查询 → 下划线转驼峰
- **fixedStatus 不上 openapi 文档**：内部使用字段

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| dataType | string | 是 | - | 脆弱性类型，参考 enum-dictionary-python.md RISK_TYPE_STRING | "loophole" |
| fixPriority | array&lt;integer&gt; | 否 | - | 修复优先级 | [2, 3] |
| page | integer | 否 | - | 页码 | 1 |
| pageSize | integer | 否 | - | 分页大小 | 100 |
| assetId | string | 否 | - | 单个资产 ID | "1001" |
| assetIds | array&lt;string&gt; | 否 | - | 资产 ID 列表 | ["1001", "1002"] |
| name | string | 否 | - | 漏洞名称模糊匹配 | "log4j" |
| latestTimeRange | array&lt;integer&gt; | 否 | - | 最近时间范围 `[start, end]`，Unix 时间戳（秒） | [1717200000, 1719800000] |
| threatTags | array&lt;string&gt; | 否 | - | 威胁标签列表 | ["APT利用"] |
| riskLevel | array&lt;integer&gt; | 否 | - | 风险等级列表 | [3] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 修复状态（**该字段不上 openapi 文档**） | [0, 1] |
| platform_id | string | 否 | - | 平台 ID（snake_case） | "plat1" |
| md5_name_assets | array&lt;string&gt; | 否 | - | MD5 资产 ID 列表，maxItems=100，uniqueItems=true，匹配 `^[A-Za-z0-9]{32}$` | ["abc123def4567890abc123def4567890"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 "Success"（V1 OpenAPI 外壳，**字符串非整数**）。失败时为 "InvalidParameter"/"Unknown.SerComError"/"InternalError" |
| message | string | 响应消息，成功时为 "success"（`output` 函数默认值） |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | integer | 总数 |
| item | array&lt;object&gt; | 资产风险列表（小驼峰） |

### item 元素结构说明（小驼峰）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 唯一 ID | "abc123..." |
| md5NameAsset | string | MD5 资产 ID | "abc123..." |
| name | string | 漏洞名称 | "Apache Log4j2 RCE" |
| type | string | 脆弱性类型 | "loophole" |
| riskLevel | integer | 风险等级 | 3 |
| scanType | array&lt;string&gt; | 检测方式 | ["POC"] |
| fixPriority | integer | 修复优先级 | 3 |
| fixedStatusInfo | object | 修复状态信息 | {"status": 0} |
| asset | string | 资产 IP | "192.168.1.1" |
| assetId | string | 资产 ID | "1001" |
| assetType | string | 资产类型 | "server" |
| assetName | string | 资产名称 | "web-server-01" |
| manager | string | 责任人 | "张三" |
| businessName | string | 业务组名称 | "核心业务" |
| srcType | string | 来源类型 | "mirror" |
| foundTime | string | 发现时间 | "2024-06-27 12:00:00" |
| lastTime | string | 上次扫描时间 | "2024-06-27 12:00:00" |

## 调用示例

### 示例 1：查询资产漏洞列表

**请求示例**：
```json
{
  "dataType": "loophole",
  "riskLevel": [3],
  "page": 1,
  "pageSize": 100,
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
    "item": [
      {
        "id": "abc123def4567890abc123def4567890",
        "md5NameAsset": "abc123def4567890abc123def4567890",
        "name": "Apache Log4j2 RCE",
        "type": "loophole",
        "riskLevel": 3,
        "scanType": ["POC"],
        "fixPriority": 3,
        "fixedStatusInfo": {"status": 0, "desc": ""},
        "asset": "192.168.1.1",
        "assetId": "1001",
        "assetType": "server",
        "assetName": "web-server-01",
        "manager": "张三",
        "businessName": "核心业务",
        "srcType": "mirror",
        "foundTime": "2024-06-27 12:00:00",
        "lastTime": "2024-06-27 12:00:00"
      }
    ]
  }
}
```

### 示例 2：按 md5_name_assets 批量查询

**请求示例**：
```json
{
  "dataType": "loophole",
  "md5_name_assets": ["abc123def4567890abc123def4567890", "def123abc4567890def123abc4567890"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 2,
    "item": [
      {"id": "abc123def4567890abc123def4567890", "name": "漏洞1", "type": "loophole"},
      {"id": "def123abc4567890def123abc4567890", "name": "漏洞2", "type": "loophole"}
    ]
  }
}
```

### 示例 3：按资产 ID 查询

**请求示例**：
```json
{
  "dataType": "weak_pwd",
  "assetId": "1001"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 1,
    "item": [
      {"id": "abc123...", "name": "弱密码1", "type": "weak_pwd", "assetId": "1001"}
    ]
  }
}
```

### 示例 4：错误响应 - 缺少 dataType

**请求示例**：
```json
{
  "page": 1,
  "pageSize": 100
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

### 示例 5：错误响应 - md5_name_assets 超过 maxItems

**请求示例**（101 个 md5）：
```json
{
  "dataType": "loophole",
  "md5_name_assets": ["md5_1", "md5_2", "...", "md5_101"]
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

### 示例 6：错误响应 - md5_name_assets 元素重复

**请求示例**（uniqueItems=true，重复元素校验失败）：
```json
{
  "dataType": "loophole",
  "md5_name_assets": ["abc123def4567890abc123def4567890", "abc123def4567890abc123def4567890"]
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

- `dataType` 必填，参考 enum-dictionary-python.md RISK_TYPE_STRING
- `md5_name_assets` maxItems=100，uniqueItems=true，元素匹配 `^[A-Za-z0-9]{32}$`
- `additionalProperties: False`，禁止传入未定义字段
- `fixedStatus` 字段不上 openapi 文档（内部使用）

### 参数依赖关系

- `dataType` 决定查询的脆弱性类型（loophole/weak_pwd）
- `assetId`/`assetIds`/`md5_name_assets` 三种资产定位方式，可单独或组合使用
- `page`/`pageSize` 共同确定分页

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `pageSize` 建议 ≤ 1000，避免返回数据过大
- `md5_name_assets` ≤ 100，超出拆分多次请求
- `latestTimeRange` 必带，避免全表扫描

### 数据一致性说明

- **trap #4**：本接口走 `output(v1_open_api=True)` 通道，错误码为字符串 `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`（**字符串非整数**，V1_ERROR_MAP 把整数 errno 映射为字符串语义码）
- **dataType 必填**：`required: ["dataType"]`
- **md5_name_assets maxItems=100**：MD5 资产 ID 列表最多 100 个，uniqueItems=true
- **md5_name_assets snake_case**：与其他字段 camelCase 不同，本字段使用 snake_case（避免转换问题）
- **platform_id snake_case**：与 md5_name_assets 一样使用 snake_case
- **三段转换链**：特殊字段处理 → 驼峰转下划线 → 查询 → 下划线转驼峰
- **入参小驼峰**：使用 camelCase（dataType/pageSize/assetId/latestTimeRange）
- **出参小驼峰**：响应字段为 camelCase（assetId/businessName/foundTime）
- **无白名单过滤**：与 V1RiskList 不同，本接口未做白名单过滤，返回所有字段

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| "InvalidParameter" | InvalidParameter | 缺少 dataType | 补全 dataType 字段 |
| "InvalidParameter" | InvalidParameter | dataType 不在枚举内 | 使用 loophole/weak_pwd |
| "InvalidParameter" | InvalidParameter | md5_name_assets 超过 100 个 | 拆分多次请求 |
| "InvalidParameter" | InvalidParameter | md5_name_assets 元素重复 | 移除重复元素 |
| "InvalidParameter" | InvalidParameter | md5_name_assets 元素格式不正确 | 使用 32 位 MD5 字符串 |
| "InvalidParameter" | InvalidParameter | 传入未定义字段 | 移除未定义字段 |
| "Unknown.SerComError" | Access Deny | 权限不足 | 检查 superAdmin/riskManageQuery 权限 |
| "InternalError" | InternalError | 数据查询异常 | 缩小查询范围 |

## 最佳实践

1. **dataType 必填**：本接口必传 dataType
2. **入参小驼峰**：使用 camelCase（dataType/pageSize/assetId/latestTimeRange）
3. **md5_name_assets snake_case**：本字段使用 snake_case，避免转换问题
4. **md5_name_assets 限制**：单次最多 100 个，元素唯一
5. **出参小驼峰**：响应字段为 camelCase（assetId/businessName/foundTime）
6. **无白名单过滤**：与 V1RiskList 不同，本接口返回所有字段
7. **响应通道**：本接口走 v1_open_api 通道，错误码为字符串 `"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`（**字符串非整数**）

---
