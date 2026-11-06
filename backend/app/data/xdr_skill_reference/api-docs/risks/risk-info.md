# POST /api/xdr/v1/risk/info

## 接口概述

本接口用于根据 sf_id 列表批量获取风险详情信息。通过本接口，您可以获取以下内容：

### 可查询的风险信息
- **基础信息**：风险ID、漏洞名称、风险等级、CVE 编号、CVSS 分数
- **资产信息**：资产IP、资产名称、资产ID、资产类型、端口
- **状态信息**：处置状态、修复优先级、是否热点、是否高可用
- **时间信息**：发现时间、最近时间、更新时间

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | `OpenApiRiskInfoV2` |
| 所属业务域 | 脆弱性管理 - 风险详情 |
| 接口分类 | 详情查询 |
| 前置依赖 | 需先调用 `/api/xdr/v1/risk/list` 获取 sf_id 列表 |
| 关联接口 | `/api/xdr/v1/risk/list`、`/api/xdr/v1/risk/detail/common` |

## 使用场景

1. **批量详情查询**：根据 list 接口返回的 sf_id 列表，批量获取风险详情
2. **二次确认**：在风险列表中筛选后，调用本接口获取完整详情
3. **资产风险画像**：与 `/api/xdr/v1/vuls/asset/topn` 配合，先取 TopN 资产再查风险详情
4. **工单关联**：工单系统通过 sf_id 关联风险详情
5. **告警关联**：与告警系统配合，根据 sf_id 获取风险上下文

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/risk/info` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_INFO_SCHEMA)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **风险详情查询**：调用 `business.get_risk_info(req)`，根据 `sfids` 列表批量查询
4. **响应封装**：调用 `output(data=business.get_risk_info(req), open_api=True)` 走 openapi 通道

### 数据转换逻辑

- 入参字段：`sfids` 列表（**注意是 `sfids`，不是 `sf_ids`**）
- 出参字段：风险详情列表，字段名与 list 接口出参一致

### 默认行为

- 不传 `sfids` 时 schema 校验失败（必填字段），表现为 HTTP 200 + `code=1` + `msg`
- 返回所有匹配 sfId 的风险详情，不限制数量

### 特殊规则

- 成功响应 `code` 为字符串 `"Success"`；失败响应为整数 `1` + `msg` 字段
- `sfids` 必填，至少 1 个
- 返回结果顺序与 `sfids` 顺序无关

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| sfids | array&lt;string&gt; | 是 | - | SF ID 列表，每个 SFID 为字符串，至少 1 个 | ["SFID001", "SFID002"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为字符串 `"Success"`（非整数 200）；失败时 `"InvalidParameter"` 等字符串（实测） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| list | array&lt;object&gt; | 风险详情列表 |
| total | integer | 总数 |

### list 元素结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 风险 ID（md5_name_asset 格式） | 32 位 MD5 | "abc123def456..." |
| sfId | string | SF ID | - | "SFID001" |
| name | string | 漏洞名称 | - | "Apache Log4j2 远程代码执行漏洞" |
| dataType | string | 脆弱性类型，参考 enum-dictionary-python.md | `loophole`/漏洞, `weak_pwd`/弱密码 | "loophole" |
| riskLevel | integer | 风险等级，参考 enum-dictionary-python.md | -1/信息, 0/低, 1/中, 2/高, 3/严重 | 3 |
| level | string | 风险等级（英文），参考 enum-dictionary-python.md | `info`/`low`/`middle`/`high`/`critical` | "critical" |
| fixPriority | integer | 修复优先级，参考 enum-dictionary-python.md | 0/无, 1/低, 2/中, 3/高 | 3 |
| fixedStatus | integer | 处置状态，参考 enum-dictionary-python.md | 0/待处置, 1/处置中, 2/已修复, 3/已接受, 4/已忽略, 5/误报, 6/改善, 7/加白, 100/处置完成 | 1 |
| isHot | integer | 是否热点，参考 enum-dictionary-python.md | 0/否, 1/是 | 1 |
| isHighAvailability | integer | 是否高可用，参考 enum-dictionary-python.md | 0/否, 1/是 | 0 |
| asset | string | 资产 IP | - | "192.168.1.1" |
| assetId | integer | 资产 ID | - | 1001 |
| assetName | string | 资产名称 | - | "web-server-01" |
| assetType | string | 资产类型，参考 enum-dictionary-python.md | `server`/`terminal`/`other` | "server" |
| cve | string | CVE 编号 | - | "CVE-2021-44228" |
| cvss | number | CVSS 分数 | 0-10 | 9.8 |
| foundTime | integer | 发现时间 | Unix 时间戳 | 1719500000 |
| lastTime | integer | 最近时间 | Unix 时间戳 | 1719500000 |
| updateTime | integer | 更新时间 | Unix 时间戳 | 1719500000 |

## 调用示例

### 示例 1：批量获取风险详情

**请求示例**：
```json
{
  "sfids": ["SFID001", "SFID002", "SFID003"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "Success",
  "data": {
    "list": [
      {
        "id": "abc123def456abc123def456abc123de",
        "sfId": "SFID001",
        "name": "Apache Log4j2 远程代码执行漏洞",
        "dataType": "loophole",
        "riskLevel": 3,
        "level": "critical",
        "fixPriority": 3,
        "fixedStatus": 1,
        "isHot": 1,
        "isHighAvailability": 0,
        "asset": "192.168.1.1",
        "assetId": 1001,
        "assetName": "web-server-01",
        "assetType": "server",
        "cve": "CVE-2021-44228",
        "cvss": 9.8,
        "foundTime": 1719500000,
        "lastTime": 1719500000,
        "updateTime": 1719500000
      }
    ],
    "total": 1
  }
}
```

### 示例 2：单个风险详情查询

**请求示例**：
```json
{
  "sfids": ["SFID001"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "Success",
  "data": {
    "list": [
      {
        "sfId": "SFID001",
        "name": "Apache Log4j2 远程代码执行漏洞",
        "riskLevel": 3,
        "level": "critical"
      }
    ],
    "total": 1
  }
}
```

### 示例 3：缺少 sfids（必填校验失败）

**请求示例**：
```json
{}
```

**响应示例**（**实测**：必填字段缺失时 schema 校验失败，返回 HTTP 200 + `code=1` 而非 400）：
```json
{
  "code": 1,
  "msg": "sfids is required",
  "data": null
}
```

> **注意**：错误响应字段名为 `msg`（不是 `message`），且 HTTP 状态码为 **200**，`code` 为整数 `1`。调用方不能依赖 HTTP 状态码判断成败，必须解析 `code`。

### 示例 4：sfids 为空数组（校验失败）

**请求示例**：
```json
{
  "sfids": []
}
```

**响应示例**（**实测**：HTTP 200 + `code=1`，字段名 `msg`）：
```json
{
  "code": 1,
  "msg": "sfids is required",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `sfids` 至少 1 个，建议 ≤ 100 个（避免查询超时）
- 每个 sfId 长度有限制（具体见 SFID schema）

### 参数依赖关系

- 需先调用 `/api/xdr/v1/risk/list` 获取 sfId 列表

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `sfids` 数量建议 ≤ 100，超过会触发查询超时
- 大批量查询建议分批，每批 50-100 个

### 数据一致性说明

- 响应字段为小驼峰命名
- 请求体字段名为 **`sfids`**（无下划线），不是 `sf_ids`
- 成功响应 `code` 为字符串 `"Success"`；失败响应 HTTP 200 + 整数 `code=1` + `msg` 字段
- 时间字段精度为秒级 Unix 时间戳
- 返回结果顺序与 `sfids` 顺序无关，需通过 sfId 字段匹配

## 常见错误

| HTTP | code | msg | 原因 | 解决方案 |
|------|------|-----|------|----------|
| 200 | 1 | sfids is required | 缺少 `sfids`（或字段名误写成 `sf_ids`） | 补全 `sfids`，至少 1 个 |
| 200 | 1 | sfids is required | `sfids` 为空数组 | 至少传 1 个 sfId |
| 200 | 1 | 其他校验消息 | schema 校验失败 | 按 `msg` 提示修正参数 |

> **重要**：本接口校验失败**不会**返回 HTTP 400/500，而是 HTTP **200** + `code=1` + `msg`。请勿按 HTTP 状态码判断成败。

## 最佳实践

1. **先调 list 接口**：通过 `/api/xdr/v1/risk/list` 获取 sfId 列表
2. **批量查询**：单次请求 `sfids` 数量 ≤ 100，避免超时
3. **错误识别**：校验失败时 HTTP 仍为 200，须解析 `code`（整数 1）与 `msg` 字段
4. **结果匹配**：通过 sfId 字段匹配请求与响应（注意请求字段是 `sfids`）
5. **配合 detail/common**：需要更多详情时可调用 `/api/xdr/v1/risk/detail/common`

---
