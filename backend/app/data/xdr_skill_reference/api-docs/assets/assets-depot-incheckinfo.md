# GET /api/xdr/v1/assets/depot/incheckinfo

## 接口概述

本接口用于获取资产入库信息检查的当前配置。通过本接口，您可以获取以下内容：

### 可查询的入库检查信息
- **服务器入库检查**：`server`（server 类型资产入库时需检查的信息项）
- **终端入库检查**：`terminal`（terminal 类型资产入库时需检查的信息项）
- **其他入库检查**：`other`（other 类型资产入库时需检查的信息项）

每个分类下包含 `{isOpen: bool, list: []}` 结构，分别表示该分类是否启用入库信息检查以及具体的检查规则列表。数据来源于 MongoDB `asset_config` 集合中 `config_type=in_depot_info_check` 的配置记录，通过 `AssetConfigDao.read_config` 读取后由 `common.business.config.get_in_depot_info_check` 按 `AssetClassifyEn.ALL_ITEM`（server/terminal/other）维度重组。

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1InDepotInfoCheck` |
| 所属业务域 | 资产管理 / 入库配置 |
| 接口分类 | 数据查询（配置读取，无写入） |
| 前置依赖 | 无（可直接调用）；返回结果依赖运维在 `asset_config.in_depot_info_check` 中已配置的入库检查规则 |
| 关联接口 | 资产入库相关接口（`POST /api/xdr/v1/assets` 等写入接口在执行入库校验时引用本配置） |

## 使用场景

1. **入库前展示入库检查规则**：第三方系统在录入资产前调用本接口展示当前生效的入库信息检查规则，便于调用方预判资产是否能通过入库校验
2. **配置审计**：管理员审计入库信息检查规则配置是否合理，识别未启用的分类
3. **配合资产录入接口校验**：调用 `POST /api/xdr/v1/assets` 录入资产前，根据本接口返回的 `list` 中规则判断资产必填字段是否齐全
4. **运维巡检**：周期性调用本接口对比配置变化，识别入库规则变更
5. **前端配置页展示**：前端"入库信息检查"配置页通过本接口拉取当前配置回显表单

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/depot/incheckinfo |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/depot/incheckinfo` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/depot/incheckinfo`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/config/views.py:20`（`V1InDepotInfoCheck.get`）。本接口不接收任何请求体或 query 参数，仅依赖登录态。

## 业务逻辑

### 核心处理流程

1. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`；`@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（SELF 模式：仅限本平台）。本接口无 schema 校验装饰器（无 `@v1_open_api_validate`），不校验请求体/查询参数。
2. **业务函数 `business.get_in_depot_info_check()` 调用**（源码 `common/business/config.py:101`）：
   1. **读取配置**：`AssetConfigDao.read_config(AssetConfigModel.ConfigType.IN_DEPOT_INFO_CHECK)` 从 `asset_config` 集合读取 `config_type="in_depot_info_check"` 的配置文档（源码 `asset_common/dao/asset_config.py:71`）：
      - `cls.coll.find_one({'config_type': 'in_depot_info_check'})` —— 单条查询
      - `clear=True` 默认删除 `_id`/`config_type`/`change_time`/`platform_id`/`update_time`/`upgrade` 等元字段
      - 若配置不存在，返回 `{}` 空字典
   2. **按 `AssetClassifyEn.ALL_ITEM` 维度重组**（源码 `common/constants.py:211`）：
      - `AssetClassifyEn.ALL_ITEM = ['server', 'terminal', 'other']` —— 三个资产分类
      - 字典推导式：`{classify: conf.get(classify, {'is_open': False, 'list': []}) for classify in AssetClassifyEn.ALL_ITEM}`
      - 对于每个分类（`server`/`terminal`/`other`）：
        - 若 `conf` 中存在该分类键，取其值（应为 `{is_open: bool, list: [...]}` 结构）
        - 若 `conf` 中不存在该分类键，使用默认值 `{'is_open': False, 'list': []}`（该分类入库检查未启用，无检查规则）
   3. **返回**：返回重组后的字典 `{'server': {...}, 'terminal': {...}, 'other': {...}}`
3. **响应字段驼峰转换**：`transform_output(...)` 将响应字段名从下划线转驼峰：
   - 顶层 `server`/`terminal`/`other` 无下划线不变
   - 子字段 `is_open` → `isOpen`，`list` 不变
   - `list` 内部元素的 `_` 字段也会被递归转换
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 省略。

### 数据转换逻辑

- **`asset_config` 文档 → 三分类字典**：业务层按 `AssetClassifyEn.ALL_ITEM` 固定输出 `server`/`terminal`/`other` 三个分类，未配置的分类用默认值 `{isOpen: False, list: []}` 填充
- **`is_open` → `isOpen`**：`transform_output` 将 `is_open` 转为驼峰 `isOpen` 输出
- **`list` 内部字段驼峰化**：`list` 数组中元素的 key 若含下划线（如 `field_name`），会被 `transform_output` 递归转为驼峰（如 `fieldName`）
- **元字段过滤**：`read_config(clear=True)` 删除了 `_id`/`config_type`/`change_time`/`platform_id`/`update_time`/`upgrade` 等元字段，不会出现在响应中

### 默认行为

- 无请求参数，行为不依赖调用方传参
- 系统未配置 `in_depot_info_check` 时，`conf` 为 `{}`，三个分类均使用默认值 `{'is_open': False, 'list': []}` 返回
- 某分类未配置时（如仅配置了 `server`/`terminal`，未配置 `other`），`other` 使用默认值 `{'is_open': False, 'list': []}` 返回

### 特殊规则

- **不校验请求参数**：本接口未挂载 `@v1_open_api_validate`，任何 query 参数都会被忽略，不会触发 schema 校验错误
- **三分类固定输出**：响应顶层结构固定为 `server`/`terminal`/`other` 三个 key，与 `AssetClassifyEn.ALL_ITEM` 定义一致；新增分类需修改源码常量
- **DAO 不做平台过滤但写入时注入了平台 ID**：`read_config` 直接 `find_one({'config_type': 'in_depot_info_check'})`，依赖 `AssetConfig` 集合的 `PlatformInject(RWSELF)` 在写入时已注入平台 ID；本接口由 `@trans_ctx_pid_query(PlatformMode.SELF)` 限定为本平台数据
- **默认值 `{is_open: False, list: []}` 经过驼峰转换**：业务层返回的默认值是下划线形式 `is_open`，经 `transform_output` 转换后输出 `isOpen`

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
| message | string | 国际化文案 key，本接口成功时省略该字段 |
| data | object | 入库信息检查配置，结构见下 |

### data 字段说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| server | object | server 类型资产的入库检查配置 |
| terminal | object | terminal 类型资产的入库检查配置 |
| other | object | other 类型资产的入库检查配置 |

#### server/terminal/other 子结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| isOpen | boolean | 该分类是否启用入库信息检查 | true/false | true |
| list | array | 该分类的入库检查规则列表，元素结构由配置决定 | 系统中已配置的检查规则对象数组 | [...] |

> 注：`list` 数组元素的具体结构由 `asset_config.in_depot_info_check` 配置决定，通常含检查字段名、检查类型、必填标志等字段，字段名经 `transform_output` 驼峰化后输出。

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "server": {
      "isOpen": true,
      "list": [
        {
          "fieldName": "ip",
          "required": true
        },
        {
          "fieldName": "branchId",
          "required": true
        }
      ]
    },
    "terminal": {
      "isOpen": false,
      "list": []
    },
    "other": {
      "isOpen": false,
      "list": []
    }
  }
}
```

## 调用示例

### 示例1：获取入库信息检查配置

**请求示例**：
```
GET /api/xdr/v1/assets/depot/incheckinfo
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "server": {
      "isOpen": true,
      "list": [
        {
          "fieldName": "ip",
          "required": true
        },
        {
          "fieldName": "branchId",
          "required": true
        },
        {
          "fieldName": "assetName",
          "required": false
        }
      ]
    },
    "terminal": {
      "isOpen": true,
      "list": [
        {
          "fieldName": "ip",
          "required": true
        }
      ]
    },
    "other": {
      "isOpen": false,
      "list": []
    }
  }
}
```

### 示例2：系统未配置入库检查（全部走默认值）

**请求示例**：
```
GET /api/xdr/v1/assets/depot/incheckinfo
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "server": {
      "isOpen": false,
      "list": []
    },
    "terminal": {
      "isOpen": false,
      "list": []
    },
    "other": {
      "isOpen": false,
      "list": []
    }
  }
}
```

### 示例3：部分分类未配置（other 走默认值）

**请求示例**：
```
GET /api/xdr/v1/assets/depot/incheckinfo
Authorization: Bearer <token>
```

**响应示例**（仅配置了 `server` 和 `terminal`，`other` 使用默认值）：
```json
{
  "code": "Success",
  "data": {
    "server": {
      "isOpen": true,
      "list": [
        {
          "fieldName": "ip",
          "required": true
        }
      ]
    },
    "terminal": {
      "isOpen": true,
      "list": [
        {
          "fieldName": "ip",
          "required": true
        }
      ]
    },
    "other": {
      "isOpen": false,
      "list": []
    }
  }
}
```

### 示例4：错误示例——未登录

**请求示例**（无 Authorization 头）：
```
GET /api/xdr/v1/assets/depot/incheckinfo
```

**错误响应示例**（HTTP 403）：
```json
{
  "code": "ACCESS_DENY",
  "message": "<鉴权失败文案>"
}
```

### 示例5：错误示例——系统异常

**请求示例**：
```
GET /api/xdr/v1/assets/depot/incheckinfo
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
- 返回结构固定为 `server`/`terminal`/`other` 三个分类，无额外顶层字段

### 参数依赖关系

- 无入参依赖
- 返回的 `list` 中规则字段（如 `fieldName`/`required`）为入库校验逻辑参考，调用方录入资产时应确保必填字段（`required=true`）齐全

### 权限要求

- `@auth_expr(expression="")` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据，跨平台调用会失败

### 性能建议

- 本接口为单次 `find_one` 配置读取，性能瓶颈在 `asset_config.in_depot_info_check` 配置体量
- 入库检查规则通常为个位数到几十条，单次响应体很小，可放心周期性调用
- 不建议在资产录入循环中嵌套调用本接口，应先缓存 `isOpen` 与规则列表在客户端本地

### 数据一致性说明

- **`isOpen` 字段为布尔类型**：响应中 `isOpen` 为 `true`/`false` 布尔值（经 `transform_output` 后保持布尔类型，不做字符串转换）
- **未配置分类使用默认值**：`conf.get(classify, {'is_open': False, 'list': []})` 确保三个分类始终返回，调用方无需处理缺失键
- **`list` 内部字段名驼峰化**：经 `transform_output` 转换，原始下划线字段名（如 `field_name`）会变为驼峰（如 `fieldName`），调用方按驼峰读取
- **配置变更即时生效**：运维在 `asset_config.in_depot_info_check` 中修改配置后，下次调用本接口即返回最新结果，无缓存延迟
- **元字段已过滤**：`_id`/`config_type`/`change_time`/`platform_id`/`update_time` 等元字段不会出现在响应中

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息 | 本接口未挂载 schema 校验，正常情况下不会出现；若网关层强制校验请求格式则可能触发 | 检查请求头是否符合 GET 规范 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<系统错误信息>` | 业务层抛出未知异常（如 `AssetConfigDao.read_config` 失败被中间件捕获） | 联系运维检查 MongoDB 连接与 `asset_config` 集合状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<message.open_api.system_busy>` | MongoDB 查询超时、连接异常等系统级错误 | 重试或联系运维检查 MongoDB 服务可用性 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 Token |

## 最佳实践

1. **资产录入前调用本接口预校验**：通过 `POST /api/xdr/v1/assets` 录入资产前先调用本接口拉取入库检查规则，根据 `list` 中 `required=true` 的字段预判资产是否能通过入库校验，减少录入失败率
2. **本地缓存 `isOpen` 与规则列表**：入库检查规则变更不频繁，建议在客户端本地缓存，资产录入循环中本地校验，避免重复调用本接口
3. **按资产分类选择规则**：录入 server 类型资产应参考 `server.list` 规则；录入 terminal 类型资产参考 `terminal.list` 规则；录入 other 类型资产参考 `other.list` 规则
4. **未启用分类（`isOpen=false`）可跳过校验**：若某分类 `isOpen=false`，该分类资产入库不强制校验 `list` 中的规则，调用方仍建议传入完整资产属性以提高识别准确度
5. **配置变更后刷新缓存**：运维修改入库检查规则后，调用方应主动重新拉取本接口刷新本地缓存
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时为 `"Success"`），`message` 字段成功时省略，不要依赖 `message` 字段判断成功
