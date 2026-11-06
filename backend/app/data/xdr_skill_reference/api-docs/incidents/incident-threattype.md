# GET /api/xdr/v1/incidents/threattype

## 接口概述

本接口用于获取安全事件二级分类（IncidentThreatType）的完整枚举值列表，含每个分类的展示名称（label，已国际化）与 id 值（value），支撑前端下拉选项、统计维度选择与分类字典查询。通过本接口，您可以获取/操作以下内容：

### 可查询的二级分类信息
- **分类列表**：每项含 label（国际化展示名）与 value（分类 id）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件分类字典 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/threatclass` 一级分类字典、`/incidents/aggregation` 通用聚合（按 incidentThreatType 分组）、`/incidents/list` 事件列表（含 incidentThreatType 字段） |

## 使用场景

1. **二级分类下拉选项**：前端事件二级分类下拉框选项填充
2. **层级分类联动**：先调 `/incidents/threatclass` 拿一级分类，用户选择一级后再调本接口拿二级分类做联动
3. **统计维度选择**：用户在事件统计页面选择二级分类作为分组维度时提供可选值
4. **配合聚合接口**：调用 `/incidents/aggregation` 前先获取二级分类列表，作为 aggBy=incidentThreatType 的合法值参考
5. **分类字典查询**：第三方系统同步事件二级分类字典

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/incidents/threattype |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 GET 请求（无参数）
2. 调用 `openApiIncidentService.getIncidentThreatType()`
3. Service 层遍历 `IncidentThreatTypeEnum.values()`：
   - 对每个枚举项，调用 `I18nUtils.i18n(item.getValue())` 获取国际化展示名称 → label
   - 取 `item.getKey()` 作为 id 值 → value
   - 构造 `OpenApiIncidentThreatTypeItem(label, value)` 加入列表
4. 封装 `OpenApiIncidentThreatTypeVo`（含 item 列表）返回
5. 返回 `OpenApiResponse<OpenApiIncidentThreatTypeVo>`，含 code/message/data 包装

### 数据转换逻辑

- 遍历 `IncidentThreatTypeEnum` 枚举（位于 xdr-incident-metadata），全部值转换为 label+value 列表
- label 通过 `I18nUtils.i18n(item.getValue())` 国际化解析
- value 为枚举 key（如 "0101_1"，格式为一级分类Key + "_" + 二级序号）

### 默认行为

- 无入参，直接返回完整枚举列表
- 国际化语言由请求 Locale 决定

### 特殊规则

- 接口返回 `OpenApiResponse<OpenApiIncidentThreatTypeVo>`，含 code/message/data 包装
- 枚举值数量众多，参考 enum-dictionary-pending.md 第 5 节"事件二级分类（incidentThreatType）"
- label 与 value 均为 Object 类型（实际均为 String）
- value 与一级分类 key 存在前缀关系：二级分类 value = 一级分类 key + "_" + 二级序号

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求无需请求体，可不传 |

### 请求体参数

无（GET 请求，无请求体）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，结构见下方 data 说明 |

### data 结构说明（来源：OpenApiIncidentThreatTypeVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| item | array[OpenApiIncidentThreatTypeItem] | 二级分类列表，见下方 item 结构 | 见示例 |

### item 元素结构说明（OpenApiIncidentThreatTypeItem）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| label | object | 安全事件二级分类展示名称（已国际化） | IncidentThreatTypeEnum 国际化标签 | "漏洞利用行为" |
| value | object | 安全事件二级分类 id 值 | IncidentThreatTypeEnum key，参考 enum-dictionary-pending.md | "0106_1" |

> 注意：label 与 value 字段类型在 VO 中声明为 Object，实际运行时均为 String。value 与一级分类 key 存在前缀关系。

## 调用示例

### 示例1：获取事件二级分类列表

**请求示例**：
```
GET /api/xdr/v1/incidents/threattype
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {"label": "漏洞利用行为", "value": "0106_1"},
            {"label": "弱口令检测", "value": "0202_1"},
            {"label": "SQL注入", "value": "0302_1"},
            {"label": "XSS攻击", "value": "0302_2"},
            {"label": "异常外联访问", "value": "0401_1"},
            {"label": "数据外传", "value": "0402_1"}
        ]
    }
}
```

> 说明：上方响应示例仅展示部分二级分类，完整列表需运行时获取，参考 enum-dictionary-pending.md 第 5 节。

### 示例2：权限不足

**错误响应示例**：
```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- 无入参，无限制

### 参数依赖关系
- 二级分类 value 与一级分类 key 存在前缀关系：二级分类 value = 一级分类 key + "_" + 二级序号
- 建议先调 `/incidents/threatclass` 获取一级分类，再调本接口获取二级分类做联动

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.suppress.log"，注意日志 action 复用了 suppress 的 key，属历史代码遗留）

### 性能建议
- 枚举值数量众多（数十到上百），单次响应体较大，建议缓存 30 分钟以上
- 国际化标签由后端 i18n 资源文件维护，枚举变更需后端发版

### 数据一致性说明
- 本接口无时间戳字段
- 枚举值完整列表参考 enum-dictionary-pending.md 第 5 节"事件二级分类（incidentThreatType）"
- 国际化标签由 `I18nUtils.i18n(item.getValue())` 解析，中文/国际版标签不同

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | internal error | 服务端异常 | 联系技术支持 |

## 最佳实践

1. **缓存 30 分钟**：枚举值变更频率低，前端可长缓存
2. **配合 threatclass 联动**：先调 `/incidents/threatclass` 拿一级分类，用户选择一级后再调本接口拿二级分类做联动
3. **作为聚合接口前置**：调用 `/incidents/aggregation` 前先获取二级分类列表，作为 aggBy=incidentThreatType 的合法值参考
4. **国际化处理**：label 已国际化，前端直接展示，无需再翻译
5. **关注 value 前缀**：二级分类 value 与一级分类 key 存在前缀关系，可用于客户端联动过滤
