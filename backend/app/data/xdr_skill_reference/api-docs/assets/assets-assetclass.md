# GET /api/xdr/v1/assets/assetclass

## 接口概述

本接口用于获取资产分类配置树（资产大类 + 二级分类），供前端筛选、资产编辑、资产组配置等场景下拉选择使用。通过本接口，您可以获取以下内容：

### 可查询的资产分类信息
- **资产大类（classify1）**：服务器、终端、网络设备、安全设备、其他等大类，过滤内网/互联网大类后展示
- **二级分类（classify）**：每个大类下的细分类型，可选展开（`isFilter=false` 时含 `children`）
- **"全部"占位项**：当 `isFilter=true` 时返回带"全部"占位的树结构，便于筛选场景

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1AssetClass`（`open_api/v1/resources/asset/views.py:188`） |
| 所属业务域 | 资产管理 / 资产分类配置查询 |
| 接口分类 | 配置查询（无写入，数据来自 `MetaData.Classify` 元数据） |
| 前置依赖 | 无（可直接调用）；元数据由 `asset_language.translations.source.config.metadata.MetaData.Classify` 提供 |
| 关联接口 | `POST /api/xdr/v1/assets`（新增资产时使用 `classify1Id`、`classifyId`）、`POST /api/xdr/v1/assets/list`（资产列表筛选时使用分类） |

## 使用场景

1. **资产列表筛选下拉**：前端资产列表页"资产类型"筛选框，调用本接口获取分类树供用户选择
2. **资产编辑表单填充**：编辑资产时调用本接口获取可选的分类列表，回填到表单
3. **新增资产分类选择**：新增资产前调用本接口获取有效 `classify1Id` 与 `classifyId`，避免硬编码错误的分类 ID
4. **资产组配置**：配置资产组规则时，调用本接口获取分类选项用于规则匹配
5. **大屏展示**：大屏资产分布统计按分类维度展示时，调用本接口获取分类元数据

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/assetclass |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/assetclass` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/assetclass`（asm.yaml 第 134-147 行，v1 assets wildcard 映射）。源码位于 v1 模块 `open_api/v1/resources/asset/views.py:188`，业务函数 `get_asset_class`（`open_api/v1/resources/asset/business.py:932`）委托 `asset_web/app/common/business/asset.py:1536` 的 `get_asset_class_cfg`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.GET_ASSET_CLASS_CFG)` 校验查询参数。GET 请求的参数来自 query string，校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`。
2. **登录鉴权 + 上下文**：`@auth_expr(expression="")` 校验登录态；`@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（SELF 模式：仅限本平台）。
3. **业务函数 `get_asset_class(data)` 调用**（源码 `open_api/v1/resources/asset/business.py:932`）：
   1. **数据类型转换**：`transform_asset_class_data_type(data)` —— 将 `isFilter`/`needAuto` 字符串 `"true"`/`"false"` 转为 Python 布尔值 `True`/`False`。
   2. **参数下划线转换**：`params = transform_params(data)` —— 将 `viewRegionId` → `view_region_id` 等驼峰键转换为下划线键（继承通用 `transform_params`，源码 `open_api/v1/resources/common.py:32`）。
   3. **委托 `get_asset_class_cfg(params)`**（源码 `asset_web/app/common/business/asset.py:1536`）：
      - **遍历 `MetaData.Classify.translate()`**：对每个 `class_id`（资产大类 ID）：
        - **跳过内网/互联网大类**：`int(class_id) in [Classify1Id.INTRANET, Classify1Id.INTERNET]` 的不展示
        - **构造大类节点**：`{id: class_id * TRANSFORM_CLASS, classify1_id: class_id, name: ...}`
        - **可选展开二级分类**：若 `data.get("is_filter")` 为 `False`，调用 `deal_asset_class_cfg(one_cfg.get("classify"))` 构造 `children` 列表
      - **处理"未知"分类位置**：
        - `data.get("need_auto")` 为 `True` → 将"未知"分类从列表头部移除，并在头部插入 `{classify1_id: 0, id: 0, name: "自动"}` 占位
        - 否则 → 将"未知"分类（原本在头部）移动到列表末尾
      - **`is_filter` 模式包裹**：若 `data.get("is_filter")` 为 `True`，将整个列表包裹为 `[{"name": "全部", "id": "all", "classify1_id": "all", "children": [...]}]`
   4. **响应转换**：`transform_output(get_asset_class_cfg(params))` —— 递归将下划线键转为驼峰键（`classify1_id` → `classify1Id`）。
4. **返回**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认成功，`message` 默认 `message.open_api.success.default`。

### 数据转换逻辑

- **入参字符串转布尔**：`isFilter`/`needAuto` 在 schema 中是 string 枚举 `["true", "false"]`，业务层 `transform_asset_class_data_type` 转为 `bool`
- **入参驼峰转下划线**：`viewRegionId` → `view_region_id`，由 `transform_params` 完成
- **出参下划线转驼峰**：`classify1_id` → `classify1Id`，由 `transform_output` 递归完成
- **`id` 字段计算**：大类的 `id` 字段为 `class_id * TRANSFORM_CLASS`（`TRANSFORM_CLASS` 为分类 ID 段间隔常量，用于将一级分类 ID 与二级分类 ID 区分到不同段）
- **"未知"分类位置调整**：默认 `MetaData.Classify.translate()` 中"未知"在头部；`need_auto=True` 时被替换为"自动"占位（`id=0`），否则被移到末尾

### 默认行为

- `isFilter` 缺省 → `False`（不包裹"全部"，展开二级分类 `children`）
- `needAuto` 缺省 → `False`（"未知"分类被移到末尾，不在头部插入"自动"占位）
- 内网（`Classify1Id.INTRANET`）与互联网（`Classify1Id.INTERNET`）大类始终被过滤掉，不返回
- 二级分类 `children` 在 `isFilter=False` 时返回，`isFilter=True` 时不返回（外层包裹"全部"项，children 是大类列表）

### 特殊规则

- **`isFilter` 与 `needAuto` 为字符串枚举**：schema 声明为 `enum: ["true", "false"]`，调用方必须传字符串而非布尔值
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段
- **`viewRegionId` 可选**：用于地域过滤，maxLength=24，pattern 由 `DATA_REGION_ID` 定义
- **"未知"分类处理**：`need_auto=True` 时"未知"被替换为"自动"占位（`id=0, classify1_id=0`）；否则"未知"被移到末尾
- **"全部"占位**：`is_filter=True` 时，外层包一层"全部"项，`id="all"`、`classify1_id="all"`，原大类列表成为其 `children`
- **元数据驱动**：分类数据来自 `MetaData.Classify.translate()`，不查询 MongoDB，响应较快

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求通常无需 Content-Type |

### 请求体参数

本接口为 GET 请求，参数通过 query string 传递。

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| isFilter | string | 否 | "false" | enum：`["true", "false"]`；`"true"` 时返回带"全部"占位的树（不展开 children）；`"false"` 时展开二级分类 children | "true" |
| needAuto | string | 否 | "false" | enum：`["true", "false"]`；`"true"` 时"未知"分类被替换为"自动"占位（id=0）；`"false"` 时"未知"被移到末尾 | "false" |
| viewRegionId | string | 否 | 无 | maxLength=24；地域 ID，用于地域过滤（实际业务函数 `get_asset_class_cfg` 未直接使用该字段，但参数被透传） | "region-001" |

#### isFilter 枚举值说明

| 值 | 含义 | 影响 |
|----|------|------|
| "true" | 筛选模式 | 外层包裹"全部"占位项（`id="all"`、`classify1_id="all"`），原大类列表成为其 `children`；不展开二级分类 |
| "false" | 详情模式 | 直接返回大类列表，每个大类含 `children` 二级分类列表 |

#### needAuto 枚举值说明

| 值 | 含义 | 影响 |
|----|------|------|
| "true" | 需要自动分类 | "未知"分类被移除，头部插入"自动"占位（`id=0`、`classify1_id=0`、`name="自动"`） |
| "false" | 不需要自动分类 | "未知"分类从头部移动到列表末尾 |

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值 |
| message | string | 国际化文案 key，成功时为 `message.open_api.success.default` |
| data | array | 资产分类树列表，元素结构见下 |

### data 数组元素结构（isFilter=false 模式）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | integer | 大类 ID（= `class_id * TRANSFORM_CLASS`） | 1000 |
| classify1Id | integer | 一级分类 ID（原 `class_id`） | 1 |
| name | string | 大类名称（多语言文案） | "服务器" |
| children | array | 二级分类列表，元素结构见下 | [...] |

##### children 数组元素结构

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | integer | 二级分类 ID | 1001 |
| classify1Id | integer | 所属一级分类 ID | 1 |
| name | string | 二级分类名称 | "Web 服务器" |

### data 数组元素结构（isFilter=true 模式）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 固定值 `"all"` | "all" |
| classify1Id | string | 固定值 `"all"` | "all" |
| name | string | "全部"占位文案 | "全部" |
| children | array | 大类列表（无 children 展开），元素结构同上"大类元素"但不含 `children` | [...] |

### 响应示例

#### isFilter=false 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "id": 1000,
      "classify1Id": 1,
      "name": "服务器",
      "children": [
        {"id": 1001, "classify1Id": 1, "name": "Web 服务器"},
        {"id": 1002, "classify1Id": 1, "name": "数据库服务器"}
      ]
    },
    {
      "id": 2000,
      "classify1Id": 2,
      "name": "终端",
      "children": [
        {"id": 2001, "classify1Id": 2, "name": "PC"},
        {"id": 2002, "classify1Id": 2, "name": "移动终端"}
      ]
    },
    {
      "id": 9000,
      "classify1Id": 9,
      "name": "未知"
    }
  ]
}
```

#### isFilter=true 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "id": "all",
      "classify1Id": "all",
      "name": "全部",
      "children": [
        {"id": 1000, "classify1Id": 1, "name": "服务器"},
        {"id": 2000, "classify1Id": 2, "name": "终端"}
      ]
    }
  ]
}
```

## 调用示例

### 示例1：获取展开的分类树（含二级分类）

**请求示例**：
```
GET /api/xdr/v1/assets/assetclass?isFilter=false
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "id": 1000,
      "classify1Id": 1,
      "name": "服务器",
      "children": [
        {"id": 1001, "classify1Id": 1, "name": "Web 服务器"},
        {"id": 1002, "classify1Id": 1, "name": "数据库服务器"}
      ]
    },
    {
      "id": 2000,
      "classify1Id": 2,
      "name": "终端",
      "children": [
        {"id": 2001, "classify1Id": 2, "name": "PC"}
      ]
    },
    {
      "id": 9000,
      "classify1Id": 9,
      "name": "未知"
    }
  ]
}
```

### 示例2：获取筛选模式的分类树（含"全部"占位）

**请求示例**：
```
GET /api/xdr/v1/assets/assetclass?isFilter=true
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "id": "all",
      "classify1Id": "all",
      "name": "全部",
      "children": [
        {"id": 1000, "classify1Id": 1, "name": "服务器"},
        {"id": 2000, "classify1Id": 2, "name": "终端"}
      ]
    }
  ]
}
```

### 示例3：自动分类模式（"未知"被"自动"占位替换）

**请求示例**：
```
GET /api/xdr/v1/assets/assetclass?needAuto=true
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {"id": 0, "classify1Id": 0, "name": "自动", "children": [
        {"id": 1001, "classify1Id": 1, "name": "Web 服务器"}
    ]},
    {"id": 2000, "classify1Id": 2, "name": "终端", "children": [
        {"id": 2001, "classify1Id": 2, "name": "PC"}
    ]}
  ]
}
```

### 示例4：错误示例——isFilter 枚举非法

**请求示例**（`isFilter=yes` 不在 `["true", "false"]` 中）：
```
GET /api/xdr/v1/assets/assetclass?isFilter=yes
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'isFilter: yes is not one of [true, false]'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `isFilter` 与 `needAuto` 必须为字符串 `["true", "false"]` 之一，传布尔值或整数会被 schema 拒绝
- `viewRegionId` maxLength=24，pattern 由 `DATA_REGION_ID` 定义
- `additionalProperties=false`，请求不允许出现 schema 中未声明的字段
- GET 请求参数通过 query string 传递，类型均为字符串

### 参数依赖关系

- `isFilter` 与 `needAuto` 独立，可单独使用或组合使用
- `isFilter=true` 时不会展开二级分类 `children`，与 `isFilter=false` 的输出结构不同
- `needAuto=true` 与 `needAuto=false` 对"未知"分类的位置处理不同

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据

### 性能建议

- 本接口数据来自内存元数据 `MetaData.Classify.translate()`，不查询 MongoDB，响应较快
- 响应体较小（通常几十个分类节点），无需分页
- 建议前端缓存分类树，避免高频调用

### 数据一致性说明

- **元数据驱动**：分类数据来自 `MetaData.Classify`，与 MongoDB 中资产的 `classify1_id`/`classify_id` 字段值需保持一致
- **内网/互联网大类被过滤**：返回结果不含 `Classify1Id.INTRANET` 与 `Classify1Id.INTERNET`，调用方不应期望获取这两类
- **`id` 字段计算规则**：大类的 `id` 是 `class_id * TRANSFORM_CLASS`，与 `classify1Id` 不同；调用方做资产分类匹配时应使用 `classify1Id` 字段，而非 `id`
- **多语言文案**：`name` 字段来自 `MetaData.Classify.translate()`，随系统语言切换而变化

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `isFilter: yes is not one of [true, false]`、`viewRegionId: too long`） | 请求参数不符合 JSON Schema 约束 | 按错误信息修正参数，对照"请求参数"段检查类型/枚举/长度约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<业务异常信息>` | `transform_params` 转换异常 / `get_asset_class_cfg` 内部异常 | 联系运维检查服务状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | 元数据加载失败 / `MetaData.Classify.translate()` 异常 | 联系运维检查元数据配置 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **筛选场景用 `isFilter=true`**：资产列表筛选下拉、资产组规则配置等需要"全部"占位的场景，传 `isFilter=true`
2. **编辑/详情场景用 `isFilter=false`**：资产编辑表单、详情展示等需要展开二级分类的场景，传 `isFilter=false`（默认）
3. **自动分类场景用 `needAuto=true`**：资产自动分类配置场景传 `needAuto=true`，"未知"被"自动"占位替换
4. **缓存分类树**：分类数据变化不频繁，前端应缓存分类树，避免高频调用本接口
5. **使用 `classify1Id` 而非 `id` 匹配资产**：资产文档中 `classify1_id` 字段对应本接口的 `classify1Id`，`id` 是计算字段（`class_id * TRANSFORM_CLASS`），不应直接用于资产匹配
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含分类树列表
