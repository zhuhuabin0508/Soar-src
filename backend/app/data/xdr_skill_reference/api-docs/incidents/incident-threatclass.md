# GET /api/xdr/v1/incidents/threatclass

## 接口概述

本接口用于获取安全事件一级分类（IncidentThreatClass）的完整枚举值列表，含每个分类的展示名称（label，已国际化）与 id 值（value），支撑前端下拉选项、统计维度选择与分类字典查询。通过本接口，您可以获取/操作以下内容：

### 可查询的一级分类信息
- **分类列表**：每项含 label（国际化展示名）与 value（分类 id）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 事件分类字典 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/incidents/threattype` 二级分类字典、`/incidents/aggregation` 通用聚合（按 incidentThreatClass 分组）、`/incidents/tag/count` 一级标签统计 |

## 使用场景

1. **下拉选项填充**：前端事件一级分类下拉框选项填充
2. **统计维度选择**：用户在事件统计页面选择一级分类作为分组维度时提供可选值
3. **分类字典查询**：第三方系统同步事件一级分类字典
4. **配合聚合接口**：调用 `/incidents/aggregation` 前先获取一级分类列表，作为 aggBy 字段的合法值参考
5. **配合 threattype**：先调本接口拿一级分类，再调 `/incidents/threattype` 拿二级分类，组合展示层级分类

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/incidents/threatclass |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery |

## 业务逻辑

### 核心处理流程

1. Controller 接收 GET 请求（无参数）
2. 调用 `openApiIncidentService.getIncidentThreatClasses()`
3. Service 层遍历 `IncidentThreatClassEnum.values()`：
   - 对每个枚举项，调用 `I18nUtils.i18n(item.getValue())` 获取国际化展示名称 → label
   - 取 `item.getKey()` 作为 id 值 → value
   - 构造 `OpenApiIncidentThreatClassItem(label, value)` 加入列表
4. 封装 `OpenApiIncidentThreatClassVo`（含 item 列表）返回
5. 返回 `OpenApiResponse<OpenApiIncidentThreatClassVo>`，含 code/message/data 包装

### 数据转换逻辑

- 遍历 `IncidentThreatClassEnum` 枚举（位于 xdr-incident-metadata），全部值转换为 label+value 列表
- label 通过 `I18nUtils.i18n(item.getValue())` 国际化解析（中文/国际版根据 Locale 返回不同标签）
- value 为枚举 key（如 "0101"）

### 默认行为

- 无入参，直接返回完整枚举列表
- 国际化语言由请求 Locale 决定

### 特殊规则

- 接口返回 `OpenApiResponse<OpenApiIncidentThreatClassVo>`，含 code/message/data 包装
- 枚举值约 30+ 个，参考 enum-dictionary-pending.md 第 4 节"事件一级分类（incidentThreatClass）"
- label 与 value 均为 Object 类型（实际 label 为 String，value 为 String）

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

### data 结构说明（来源：OpenApiIncidentThreatClassVo）

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| item | array[OpenApiIncidentThreatClassItem] | 一级分类列表，见下方 item 结构 | 见示例 |

### item 元素结构说明（OpenApiIncidentThreatClassItem）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| label | object | 安全事件展示名称（已国际化） | IncidentThreatClassEnum 国际化标签 | "恶意软件" |
| value | object | 安全事件 id 值 | IncidentThreatClassEnum key，参考 enum-dictionary-pending.md | "0101" |

> 注意：label 与 value 字段类型在 VO 中声明为 Object，实际运行时均为 String。

## 调用示例

### 示例1：获取事件一级分类列表

**请求示例**：
```
GET /api/xdr/v1/incidents/threatclass
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {"label": "恶意软件", "value": "0101"},
            {"label": "勒索软件", "value": "0102"},
            {"label": "木马后门", "value": "0103"},
            {"label": "蠕虫", "value": "0104"},
            {"label": "僵尸网络", "value": "0105"},
            {"label": "漏洞利用", "value": "0106"},
            {"label": "暴力破解", "value": "0201"},
            {"label": "弱口令", "value": "0202"},
            {"label": "Web攻击", "value": "0301"},
            {"label": "注入攻击", "value": "0302"},
            {"label": "异常访问", "value": "0401"},
            {"label": "数据外泄", "value": "0402"},
            {"label": "策略违规", "value": "0501"},
            {"label": "拒绝服务", "value": "0601"},
            {"label": "钓鱼", "value": "0701"},
            {"label": "垃圾邮件", "value": "0702"},
            {"label": "扫描探测", "value": "0801"},
            {"label": "挖矿", "value": "0901"},
            {"label": "脆弱性", "value": "1001"},
            {"label": "其他", "value": "1101"}
        ]
    }
}
```

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
- 无

### 权限要求
- 需要 `superAdmin` 或 `incidentQuery` 权限
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.incidents.suppress.log"，注意日志 action 复用了 suppress 的 key，属历史代码遗留）

### 性能建议
- 枚举值约 30+ 个，单次响应体较小，可缓存较长时间（≥ 30 分钟）
- 国际化标签由后端 i18n 资源文件维护，枚举变更需后端发版

### 数据一致性说明
- 本接口无时间戳字段
- 枚举值完整列表参考 enum-dictionary-pending.md 第 4 节"事件一级分类（incidentThreatClass）"
- 国际化标签由 `I18nUtils.i18n(item.getValue())` 解析，中文/国际版标签不同

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 incidentQuery 权限 |
| 500 | internal error | 服务端异常 | 联系技术支持 |

## 最佳实践

1. **缓存 30 分钟**：枚举值变更频率低，前端可长缓存
2. **配合 threattype**：先调本接口拿一级分类，再调 `/incidents/threattype` 拿二级分类组合展示
3. **作为聚合接口前置**：调用 `/incidents/aggregation` 前先获取一级分类列表，作为 aggBy=incidentThreatClass 的合法值参考
4. **国际化处理**：label 已国际化，前端直接展示，无需再翻译
5. **配合 tag/count**：本接口拿分类字典，配合 `/incidents/tag/count` 拿分类统计数
