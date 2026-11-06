# GET /api/xdr/v1/assets/assettag/allassettag

## 接口概述

本接口用于获取系统中已配置的资产标签（asset_tag）全量列表。通过本接口，您可以获取以下内容：

### 可查询的标签信息
- **标签标识**：`id`（标签唯一 ID）
- **标签名称**：`name`（标签名称，已国际化翻译）
- **标签类型**：`type`（`branch` 资产组标签 / `asset` 资产标签）
- **全部标签占位**：`isFilter=true` 时返回一个 `{name: 全部, type: all, id: all}` 占位项
- **默认标签标识**：`isDefault`（boolean），仅 `type=branch` 标签返回且恒为 `true`，`type=asset` 标签与"全部"占位项不返回

数据来源于 MongoDB `asset_config` 集合中 `config_type=asset_tag` 的配置记录，通过 `AssetConfigDao.read_config` 读取后由 `view/asset_tag/business.get_all_asset_tag` 进行类型过滤、名称国际化翻译和驼峰转换输出。

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1GetAllAssetTag` |
| 所属业务域 | 资产管理 / 资产标签 |
| 接口分类 | 数据查询（配置读取，无写入） |
| 前置依赖 | 无（可直接调用）；返回结果依赖运维在 `asset_config.asset_tag` 中已配置的标签 |
| 关联接口 | `POST /api/xdr/v1/assets`（新增资产时 `tags` 字段使用本接口返回的 `name`）、`POST /api/xdr/v1/assets/list`（资产列表查询时按 `tags` 过滤） |

## 使用场景

1. **资产录入前获取可用标签**：第三方系统录入资产前调用本接口拉取所有 `type=asset` 的标签名称，再选择填入资产 `tags` 字段
2. **资产组绑定标签前拉取标签列表**：资产组配置场景下拉取 `type=branch` 的标签，供资产组绑定使用
3. **前端标签筛选下拉框渲染**：资产列表/资产组列表页面的标签筛选下拉框，通过 `isFilter=true` 调用本接口获取含 "全部" 占位的下拉选项
4. **配合资产新增接口校验标签合法性**：调用 `POST /api/xdr/v1/assets` 前，使用本接口返回的 `name` 列表校验入参 `tags` 是否为系统中已配置的标签
5. **标签变更监控**：周期性调用本接口对比标签列表变化，识别新增/删除的标签

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/assettag/allassettag |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/assettag/allassettag` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/assettag/allassettag`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/asset_tag/views.py:20`（`V1GetAllAssetTag.get`）。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.GET_ASSET_TAG_REQ)` 校验 query 参数（GET 请求从 `request.args.to_dict()` 读取）符合 JSON Schema 约束：
   - `type` 必填，字符串枚举 `["all", "branch", "asset"]`
   - `isFilter` 可选，字符串枚举 `["false", "true"]`
   - `additionalProperties=false`，不允许出现 schema 中未声明的 query 参数
   - 校验失败抛 `V1_INVALID_PARAMETER`（HTTP 400，code=1104）
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，鉴权失败返回 `ACCESS_DENY_RESPONSE`；`@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（SELF 模式：仅限本平台）。
3. **业务函数 `business.get_asset_tag(data)` 调用**（源码 `open_api/v1/resources/asset/asset_tag/business.py:13`）：
   1. **驼峰参数转下划线**：`transform_hump_params(data)` 将 `isFilter` 转换为 `is_filter`（`type` 本身为小写无变化）。
   2. **`is_filter` 字符串转布尔**：业务层显式判断 `params['is_filter'] == 'false'` 时设为 `False`，`== 'true'` 时设为 `True`（schema 中 `isFilter` 是字符串枚举而非 boolean，故此处手动转换）。
   3. **调用 `get_all_asset_tag(params)`**（源码 `view/asset_tag/business.py:321`）：
      1. **读取标签配置**：`AssetConfigDao.read_config(AssetConfigModel.ConfigType.ASSET_TAG)` 从 `asset_config` 集合读取 `config_type="asset_tag"` 的配置文档（`clear=True` 默认删除 `_id`/`config_type`/`platform_id`/`change_time` 等元字段，仅保留标签条目）。
      2. **可选注入"全部"占位项**：若 `data.get("is_filter")` 为真值，构造 `{name: Identity.Common.All.translate(), type: "all", id: "all"}` 占位项加入结果列表头部（用于前端筛选下拉框的"全部"选项）。
      3. **类型过滤 + 名称国际化翻译**：遍历配置字典 `cfg.items()`：
         - 跳过非字典类型项（`isinstance(one_tag, dict)` 为 False 的元字段被过滤）
         - 若 `data_type != one_tag["type"]` 且 `data_type != "all"`，跳过该标签（按 `type` 入参筛选）
         - 注入 `one_tag["id"] = id_`（将字典 key 作为 `id` 字段写入标签对象）
         - 调用 `Identity.Tag.translate(one_tag.get("name"))` 对标签名称做国际化翻译
         - 加入 `result_data` 列表
      4. **对结果列表做 `TransformEntityBuilder` 处理**：再次遍历 `result_data`，调用 `TransformEntityBuilder(r).set_type(TransformType.OUTER).trans("name", VoTransform.Tag).builder()` 对 `name` 字段做外层转换（与上一步翻译互补，确保 `name` 字段输出格式一致）。
      5. **返回**：返回 `result_data` 列表（**未排序，保持配置字典遍历顺序**）。
   4. **包装响应**：`{"item": result}` —— 将标签列表包在 `item` 字段中。
   5. **响应字段驼峰转换**：`transform_output(result)` 将响应体 key 从下划线转为驼峰（`item` 不变，列表元素中 `type`/`id`/`name` 本身无下划线不变化）。
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认 `"Success"`，`message` 省略。

### 数据转换逻辑

- **query 参数 `isFilter` → `is_filter`**：`transform_hump_params` 完成驼峰转下划线
- **`is_filter` 字符串 → 布尔**：业务层显式判断 `"true"/"false"` 字符串转布尔（schema 强制 string 枚举，避免 boolean 在 query 中传输歧义）
- **`type` 字段无转换**：`type` 已为小写无下划线
- **`cfg` 字典 key → 标签 `id` 字段**：`AssetConfigDao.read_config` 返回的字典以标签 ID 为 key，业务层将 key 注入标签对象作为 `id` 字段返回
- **`name` 国际化翻译**：通过 `Identity.Tag.translate` 将存储的标签名 key 翻译为对应语言文案；外层 `VoTransform.Tag` 转换确保输出格式统一
- **响应字段 `item` 嵌套**：业务层用 `{"item": result}` 包装，再经 `transform_output` 转换（`item` 字段名无下划线保持不变）

### 默认行为

- 不传 `isFilter` → 不注入"全部"占位项，仅返回真实标签列表
- 不传 `type` → schema 校验失败（`type` 必填）
- 标签返回顺序遵循 `AssetConfigDao.read_config` 返回字典的迭代顺序（Python 3.7+ 字典保持插入顺序，即配置写入顺序），**业务层未显式排序**（与 `get_asset_tag_list` 不同，后者按 `id` 升序）

### 特殊规则

- **`type` 必填且必须为枚举值**：传入非 `all`/`branch`/`asset` 的值会触发 schema 校验失败（`V1_INVALID_PARAMETER`）
- **`isFilter` 字符串枚举而非 boolean**：schema 定义 `isFilter` 为 `["false", "true"]` 字符串枚举，业务层手动转换为布尔值
- **`additionalProperties=false`**：query 参数不允许出现 schema 中未声明的字段
- **`isFilter=true` 时返回"全部"占位项**：占位项 `id="all"`、`type="all"`，调用方识别 `id="all"` 时应作为"全部"选项处理
- **非字典类型的配置项被过滤**：`read_config` 返回的字典中除标签条目外的元字段（如 `_id`/`config_type` 已被 `clear=True` 删除）通过 `isinstance(one_tag, dict)` 校验过滤，避免污染结果
- **`type=all` 时返回所有标签**：不区分 `branch`/`asset` 类型，全量返回
- **`isDefault` 与 `type` 强相关**：`type=branch` 的标签全部带 `isDefault:true`，`type=asset` 的标签全部不带该字段，`isFilter=true` 的"全部"占位项也不带；该字段来自配置透传，但其出现与否由标签 `type` 决定
- **DAO 不做平台过滤**：`read_config` 直接 `find_one({'config_type': 'asset_tag'})`，依赖 `AssetConfig` 集合的 `PlatformInject` 在写入时已注入平台 ID；本接口由 `@trans_ctx_pid_query(PlatformMode.SELF)` 限定为本平台数据

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求无请求体，可不传；若传建议 application/json |
| Authorization | string | 是 | 登录鉴权 Token（由网关层 `@auth_expr` 校验） |

### 请求体参数

本接口为 GET 请求，参数通过 query string 传递（`request.args.to_dict()`）。

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| type | string | 是 | 无 | 标签类型枚举：`all`（全部）/`branch`（资产组标签）/`asset`（资产标签） | "all" |
| isFilter | string | 否 | 无 | 是否返回"全部"占位项枚举：`true`（返回）/`false`（不返回） | "true" |

#### type 枚举值说明

| 值 | 含义 | 返回范围 | 典型用途 |
|----|------|---------|---------|
| all | 全部标签 | 返回 `branch` + `asset` 所有类型标签 | 标签管理页面、跨类型场景 |
| branch | 资产组标签 | 仅返回 `type=branch` 的标签 | 资产组绑定标签下拉框 |
| asset | 资产标签 | 仅返回 `type=asset` 的标签 | 资产录入/资产列表筛选下拉框 |

#### isFilter 枚举值说明

| 值 | 含义 | 行为 |
|----|------|------|
| true | 返回"全部"占位项 | 结果列表头部插入 `{name: "全部", type: "all", id: "all"}` |
| false | 不返回"全部"占位项 | 仅返回真实标签列表 |

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"` |
| message | string | 国际化文案 key，本接口成功时省略该字段 |
| data | object | 标签列表包装对象，结构见下 |

### data 字段说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array | 标签列表，元素结构见下；系统未配置时为空数组 `[]` |

#### item 数组元素结构

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 标签唯一 ID（来自 `asset_config.asset_tag` 配置字典的 key） | 字符串形式的整数 ID；`isFilter=true` 时含占位项 `"all"` | "1" |
| name | string | 标签名称（已通过 `Identity.Tag.translate` 国际化翻译） | 系统中已配置的标签名翻译文案 | "核心资产" |
| type | string | 标签类型 | `branch` / `asset`；`isFilter=true` 时占位项为 `"all"` | "asset" |
| isDefault | boolean | 是否为默认标签；**仅 `type=branch` 标签返回、恒为 `true`**；`type=asset` 标签与 `isFilter=true` 的"全部"占位项均不返回该字段 | `true`（branch 标签）/ 缺省（asset 标签与占位项） | true |

> 注：`isDefault` 是与 `type` 强相关的条件字段，**不是**"配置中恰好存在才透传"的偶然字段：实测 `type=branch` 的标签全部返回 `isDefault:true`，`type=asset` 的标签全部不返回该字段，`isFilter=true` 的"全部"占位项也不返回。调用方应稳定依赖 `id`/`name`/`type`/`isDefault`（`isDefault` 仅对 `branch` 标签有意义）四个字段；如需判断某标签是否为默认标签，应同时校验 `type=branch` 与 `isDefault=true`。

### 响应示例

```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "id": "all",
        "name": "全部",
        "type": "all"
      },
      {
        "id": "1",
        "name": "核心资产",
        "type": "asset"
      },
      {
        "id": "2",
        "name": "DMZ区资产组",
        "type": "branch"
      }
    ]
  }
}
```

## 调用示例

### 示例1：获取所有资产标签（含"全部"占位项）

**请求示例**：
```
GET /api/xdr/v1/assets/assettag/allassettag?type=all&isFilter=true
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "id": "all",
        "name": "全部",
        "type": "all"
      },
      {
        "id": "1",
        "name": "核心资产",
        "type": "asset"
      },
      {
        "id": "2",
        "name": "DMZ区资产组",
        "type": "branch"
      },
      {
        "id": "3",
        "name": "测试资产",
        "type": "asset"
      }
    ]
  }
}
```

### 示例2：仅获取资产组标签（type=branch）

**请求示例**：
```
GET /api/xdr/v1/assets/assettag/allassettag?type=branch
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "id": "2",
        "name": "DMZ区资产组",
        "type": "branch"
      },
      {
        "id": "5",
        "name": "办公网资产组",
        "type": "branch"
      }
    ]
  }
}
```

### 示例3：仅获取资产标签（type=asset）

**请求示例**：
```
GET /api/xdr/v1/assets/assettag/allassettag?type=asset
Authorization: Bearer <token>
```

**响应示例**：
```json
{
  "code": "Success",
  "data": {
    "item": [
      {
        "id": "1",
        "name": "核心资产",
        "type": "asset"
      },
      {
        "id": "3",
        "name": "测试资产",
        "type": "asset"
      }
    ]
  }
}
```

### 示例4：错误示例——缺少必填字段

**请求示例**（缺少 `type`）：
```
GET /api/xdr/v1/assets/assettag/allassettag?isFilter=true
Authorization: Bearer <token>
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'type: required'>",
  "data": null
}
```

### 示例5：错误示例——type 枚举非法

**请求示例**（`type=unknown`）：
```
GET /api/xdr/v1/assets/assettag/allassettag?type=unknown
Authorization: Bearer <token>
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'type: not in enum'>",
  "data": null
}
```

### 示例6：错误示例——传入了 schema 未声明的参数

**请求示例**（多传 `search` 字段）：
```
GET /api/xdr/v1/assets/assettag/allassettag?type=all&search=core
Authorization: Bearer <token>
```

**错误响应示例**（HTTP 400，`additionalProperties=false` 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'search: additional properties not allowed'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `type` 必填，必须为 `all`/`branch`/`asset` 之一
- `isFilter` 可选，若传必须为 `"true"` 或 `"false"`（字符串而非 boolean）
- `additionalProperties=false`，query 参数不允许出现 schema 中未声明的字段（如 `search`/`page`/`pageSize` 均不允许）

### 参数依赖关系

- `type=all` 时返回所有类型标签，`type=branch`/`asset` 时分别按类型过滤
- `isFilter=true` 与 `type` 无互斥关系，可同时使用（占位项 `type=all` 始终出现在列表头部，不受 `type` 过滤影响）

### 权限要求

- `@auth_expr(expression="")` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`（HTTP 403）
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据，跨平台调用会失败

### 性能建议

- 本接口为单次 `find_one` 配置读取 + 内存遍历，性能瓶颈在 `asset_config.asset_tag` 配置体量
- 标签通常为几十到几百条，单次响应体很小，可放心周期性调用；`isDefault` 仅对 `branch` 标签返回，不影响响应体量
- 不建议在资产列表查询循环中嵌套调用本接口，应先缓存 `id → name` 映射在客户端本地

### 数据一致性说明

- **响应不排序**：本接口返回顺序遵循 `AssetConfigDao.read_config` 字典迭代顺序（配置写入顺序），不保证按 `id` 升序；如需排序，调用方应自行按 `id` 排序
- **`name` 字段经过国际化翻译**：与直接读取数据库原值不同，调用方收到的 `name` 已按当前语言环境翻译；如需原始 key 请走其他接口
- **`isFilter` 占位项不参与类型过滤**：占位项 `id=all`、`type=all` 始终在 `isFilter=true` 时出现在列表头部，即使 `type=branch`/`asset` 也不会被过滤
- **配置变更即时生效**：运维在 `asset_config.asset_tag` 中新增/删除标签后，下次调用本接口即返回最新结果
- **`isDefault` 是条件字段而非偶然透传**：`isDefault` 仅在 `type=branch` 标签上返回且恒为 `true`，不可假定其一定存在；调用方读取前应先判断 `type`，避免在 `asset` 标签上取到 `undefined`

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `type: required` | 缺少必填字段 `type` | 在 query 中添加 `type=all` 或 `type=branch` 或 `type=asset` |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `type: not in enum` | `type` 传入了非 `all`/`branch`/`asset` 的值 | 检查 `type` 取值，仅允许三个枚举值 |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `isFilter: not in enum` | `isFilter` 传入了非 `true`/`false` 的值（如 `1`/`yes`） | `isFilter` 仅允许字符串 `"true"` 或 `"false"` |
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | `<additional properties not allowed>` | query 中传入了 schema 未声明的字段 | 仅允许 `type` 和 `isFilter` 两个 query 参数 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<系统错误信息>` | 业务层抛出未知异常（如 `AssetConfigDao.read_config` 失败被中间件捕获） | 联系运维检查 MongoDB 连接与 `asset_config` 集合状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | `<message.open_api.system_busy>` | MongoDB 查询超时、连接异常等系统级错误 | 重试或联系运维检查 MongoDB 服务可用性 |
| ACCESS_DENY (HTTP 403) | `<鉴权失败>` | 未登录或登录态失效 | 重新登录获取有效 Token |

## 最佳实践

1. **资产录入前调用 `type=asset` 获取可用标签**：通过 `POST /api/xdr/v1/assets` 录入资产前先调用本接口拉取 `type=asset` 的标签 `name`，避免传入系统未配置的标签
2. **前端筛选下拉框用 `isFilter=true`**：列表页面筛选下拉框应使用 `isFilter=true` 拿到"全部"占位项，便于用户清除筛选
3. **本地缓存 `id → name` 映射**：标签变更不频繁，建议在客户端本地缓存 `id → name` 与 `name → type` 映射，资产列表展示时本地翻译，减少接口调用
4. **`type=all` 适合标签管理页面**：跨类型展示标签时使用 `type=all`；分类展示时分别用 `type=branch`/`type=asset`
5. **识别"全部"占位项**：`isFilter=true` 返回的占位项 `id=all` 不应作为真实标签处理，调用方应在用户选择"全部"时清空标签筛选条件
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功（成功时为 `"Success"`），`message` 字段成功时省略，不要依赖 `message` 字段判断成功
