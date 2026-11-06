# GET /api/xdr/v1/assets/custom/list

## 接口概述

本接口用于获取系统中已配置的资产自定义属性列表。通过本接口，您可以获取以下内容：

### 可查询的自定义属性信息
- **属性标识**：`key`（自定义属性唯一标识）
- **属性展示名**：`name`（自定义属性展示名称，含国际化）
- **属性描述**：`comment`（自定义属性备注说明）

数据来源于 MongoDB `asset_config` 集合中 `config_type=custom_attribute` 的配置记录，通过 `AssetConfigDao.get_custom_attributes` 聚合管道 `$unwind` + `$group` 提取 `custom_attributes` 数组并归并展示。

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1AssetCustomList` |
| 所属业务域 | 资产管理 / 资产自定义属性 |
| 接口分类 | 数据查询（聚合查询，无写入） |
| 前置依赖 | 无（可直接调用）；返回结果依赖运维在 `asset_config` 中已配置的 `custom_attribute` 项 |
| 关联接口 | `POST /api/xdr/v1/assets`（新增资产时 `customAttributes` 字段使用本接口返回的 `key`）、`POST /api/xdr/v1/assets/list`（资产列表中 `customAttributes` 字段引用同 key） |

## 使用场景

1. **资产录入前获取属性清单**：第三方系统通过 OpenAPI 录入资产前，先调用本接口拉取可用的自定义属性 key 列表，再按需填充资产 `customAttributes` 字段
2. **前端动态表单渲染**：前端页面动态渲染自定义属性表单时，通过本接口获取属性 key/名称/描述以展示表单字段
3. **资产导出列模板构造**：批量导入/导出场景下，使用本接口返回的自定义属性列表构造 Excel 列模板
4. **配合资产列表查询**：调用 `POST /api/xdr/v1/assets/list` 后，将返回的 `customAttributes` 与本接口返回的 `key` 对照解析属性名
5. **资产属性变更监控**：周期性调用本接口对比自定义属性清单变化，识别新增/删除的自定义属性

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/custom/list |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/custom/list` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/custom/list`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/views.py:281`（`V1AssetCustomList.get`）。本接口不接收任何请求体或 query 参数，仅依赖登录态。

## 业务逻辑

### 核心处理流程

1. **登录鉴权**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`。本接口无 schema 校验装饰器（无 `@v1_open_api_validate`），不校验请求体/查询参数。
2. **业务函数 `business.get_asset_custom_list()` 调用**（源码 `open_api/v1/resources/asset/business.py:1191`）：
   1. **构造聚合管道**：
      - `filters = dict()` —— 不附加业务过滤条件
      - `group = {'_id': 0, 'total': {'$first': '$total'}, 'custom_attributes': {'$push': '$custom_attributes'}}` —— 将展开后的属性数组重新聚合
   2. **调用 DAO**：`AssetConfigDao.get_custom_attributes(filters, group)` 执行聚合管道（源码 `asset_common/dao/asset_config.py:457`）：
      - `$match`：`config_type = AssetConfigModel.ConfigType.CUSTOM_ATTRIBUTE`（即 `"custom_attribute"`）
      - `$unwind`：`$custom_attributes`（展开自定义属性数组）
      - `$sort`：`{"platform_id": 1, "custom_attributes.id": 1}`（先按平台 ID 升序，再按属性 ID 升序）
      - `$group`：将展开的属性按配置文件维度重新聚合，返回 `{custom_attributes: [...]}` 结构
   3. **空结果短路**：若 `attrs` 为空列表（未配置任何自定义属性），直接返回 `{'list': []}` 跳过后续处理
   4. **字段裁剪**：仅保留 `keys_to_keep = ['key', 'name', 'comment']` 三个字段，过滤掉 `id`、`platform_id`、`is_default` 等内部字段
   5. **构造返回**：返回 `{'list': new_custom_list}`
3. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 省略（无成功文案 key）。

### 数据转换逻辑

- **`custom_attributes` 数组 → `list` 数组**：DAO 层将 MongoDB 文档中的 `custom_attributes` 嵌套数组展开后重新聚合，业务层只保留 `key`/`name`/`comment` 三个字段
- **不进行驼峰转换**：本接口未调用 `transform_output`，响应字段名 `list`/`key`/`name`/`comment` 全部为小写无下划线，与 schema 字段保持一致
- **不进行国际化翻译**：本接口未调用 `Identity.*.translate`，`name`/`comment` 直接透传数据库存储的值（数据库中已按平台存储为对应语言文案）

### 默认行为

- 无请求参数，行为不依赖调用方传参
- 系统未配置任何自定义属性时，返回 `{"list": []}`（不报错）
- 自定义属性按 `platform_id` + `custom_attributes.id` 升序排列（聚合管道 `$sort` 阶段决定）

### 特殊规则

- **不校验请求参数**：本接口未挂载 `@v1_open_api_validate`，任何 query 参数都会被忽略，不会触发 schema 校验错误
- **`platform_filter=PlatformFlag.RWSELF`**：DAO 层默认使用 `RWSELF` 平台过滤，仅返回当前平台可读的自定义属性配置（包含本平台自有 + 上级平台下发）
- **`get_custom_attributes` 内部不会调用 `i18n_render_attr`**：因本接口未传 `group` 走 `new_root=False` 分支，DAO 不会执行 i18n 渲染（`i18n_render_attr` 仅在返回结构含 `group_attributes` 时触发），故 `name`/`comment` 字段为数据库原值
- **仅返回 `key/name/comment` 三字段**：DAO 内部字段（如 `id`、`is_default`、`platform_id`）不会返回给调用方

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求无请求体，可不传；若传建议 application/json |
| Authorization | string | 是 | 登录鉴权 Token（由网关层 `@auth_expr` 校验） |

### 请求体参数

本接口为 GET 请求，无请求体，也不接收 query 参数。任何 query 参数都会被忽略。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"` |
| message | string | 国际化文案 key，本接口成功时省略该字段（`v1_open_api_output` 在 `message=None` 时不写入） |
| data | object | 自定义属性列表，结构见下 |

### data 字段说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| list | array | 自定义属性列表，元素结构见下；系统未配置时为空数组 `[]` |

#### list 数组元素结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| key | string | 自定义属性唯一标识（数据库 `custom_attributes.key`） | 系统中已配置的属性 key 字符串 | "asset_owner_email" |
| name | string | 自定义属性展示名（数据库 `custom_attributes.name`，未做国际化翻译） | 系统中已配置的属性名称字符串 | "资产责任人邮箱" |
| comment | string | 自定义属性备注说明（数据库 `custom_attributes.comment`，未做国际化翻译） | 系统中已配置的备注字符串，可能为空字符串 | "用于记录资产责任人邮箱" |

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "list": [
      {
        "key": "asset_owner_email",
        "name": "资产责任人邮箱",
        "comment": "用于记录资产责任人邮箱"
      },
      {
        "key": "asset_use_status",
        "name": "资产使用状态",
        "comment": "在用/闲置/报废"
      }
    ]
  }
}
```

## 调用示例

### 示例1：获取所有自定义属性

**请求示例**：
```
GET /api/xdr/v1/assets/custom/list
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "list": [
      {
        "key": "asset_owner_email",
        "name": "资产责任人邮箱",
        "comment": "用于记录资产责任人邮箱"
      },
      {
        "key": "asset_use_status",
        "name": "资产使用状态",
        "comment": "在用/闲置/报废"
      },
      {
        "key": "data_sensitivity",
        "name": "数据敏感级别",
        "comment": "高/中/低"
      }
    ]
  }
}
```

### 示例2：未配置任何自定义属性

**请求示例**：
```
GET /api/xdr/v1/assets/custom/list
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "list": []
  }
}
```

### 示例3：错误示例——未登录

**请求示例**（无 Authorization 头）：
```
GET /api/xdr/v1/assets/custom/list
```

**错误响应示例**（HTTP 403）：
```json
{
  "code": "ACCESS_DENY",
  "message": "<鉴权失败文案>"
}
```

### 示例4：错误示例——系统异常

**请求示例**：
```
GET /api/xdr/v1/assets/custom/list
Authorization: Bearer <token>
```

**错误响应示例**（HTTP 500，MongoDB 查询失败等）：
```json
{
  "code": "V1_SYSTEM_ERROR",
  "message": "<message.open_api.system_busy>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- 本接口不接受任何请求参数，无字段长度/类型/枚举限制
- 返回的 `list` 数组长度由系统已配置的自定义属性数量决定，无上限分页

### 参数依赖关系

- 无入参依赖
- 返回的 `key` 字段为后续调用 `POST /api/xdr/v1/assets`、`POST /api/xdr/v1/assets/list` 时 `customAttributes` 字段的取值依据

### 权限要求

- `@auth_expr(expression="")` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- DAO 层 `platform_filter=PlatformFlag.RWSELF`：仅返回当前登录平台可读的自定义属性（含本平台自有 + 上级平台下发）

### 性能建议

- 本接口为单次聚合查询，无分页、无过滤条件，性能瓶颈在 `asset_config` 集合中 `custom_attribute` 配置的体量
- 自定义属性通常为个位数到几十条，单次响应体很小，可放心周期性调用
- 不建议在资产列表查询循环中嵌套调用本接口，应先缓存 `key → name` 映射在客户端本地

### 数据一致性说明

- **`name`/`comment` 字段不做国际化翻译**：本接口直接返回数据库存储的原始文案，调用方按字符串消费；如需多语言展示，应由调用方根据自身语言环境匹配
- **响应不含 `id`/`platform_id`/`is_default`**：DAO 内部字段被业务层裁剪掉，调用方无法区分某属性是平台内置默认还是用户自定义
- **配置变更即时生效**：运维在 `asset_config` 中新增/修改/删除自定义属性后，下次调用本接口即返回最新结果，无缓存延迟

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息 | 本接口未挂载 schema 校验，正常情况下不会出现；若网关层强制校验请求格式则可能触发 | 检查请求头是否符合 GET 规范 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<系统错误信息>` | 业务层抛出未知异常（如 `AssetConfigDao` 聚合失败被中间件捕获） | 联系运维检查 MongoDB 连接与 `asset_config` 集合状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<message.open_api.system_busy>` | MongoDB 查询超时、连接异常等系统级错误 | 重试或联系运维检查 MongoDB 服务可用性 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 Token |

## 最佳实践

1. **录入资产前先调用本接口**：通过 `POST /api/xdr/v1/assets` 录入资产前先调用本接口拉取可用自定义属性 key，避免传入系统未配置的 key 导致资产录入失败
2. **本地缓存 key → name 映射**：本接口返回数据量小且变更不频繁，建议在客户端本地缓存 `key → name` 映射，资产列表展示时本地翻译 `customAttributes` 字段，减少对资产详情接口的依赖
3. **配置变更后主动刷新缓存**：运维新增/删除自定义属性后，调用方应主动重新拉取本接口刷新本地缓存，避免使用过期 key
4. **不要硬编码 key 列表**：调用方应动态获取 key 而非硬编码，以适配不同租户/平台的自定义属性差异
5. **结合 `assets/list` 解析资产详情**：本接口返回的 `key` 与 `POST /api/xdr/v1/assets/list` 返回的 `customAttributes` 对象的 key 一一对应，可组装为 `{key: value}` 形式展示资产的自定义属性
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时为 `"Success"`），`message` 字段成功时省略，不要依赖 `message` 字段判断成功
