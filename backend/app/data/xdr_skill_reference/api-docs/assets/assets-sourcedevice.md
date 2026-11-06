# GET /api/xdr/v1/assets/sourcedevice

## 接口概述

本接口用于获取全部资产数据源设备树（source device tree），返回按数据源来源类型分组的设备层级结构，含每个数据源下的采集设备列表及其子设备。数据来源于 `asset_config` 集合（Redis 缓存）与 SIEM 数据源配置（`source` 集合），通过 `SOURCE.SOURCE_DEV_TYPE_MAP` 动态聚合数据源类型与设备。本接口无 schema 校验，无请求参数。

### 可查询的数据源设备信息
- **数据源层级**：每个数据源含 `name`（长名）、`id`（数据源 `name` 标识）、`children`（设备列表，可选）
- **设备层级**：每个设备含 `id`（设备 ID）、`name`（设备名，已删除设备会追加"（已删除）"后缀）、`children`（子设备列表，可选）
- **全集占位项**：列表首项固定为 `{name: "全部", id: "all"}`，用于"全部数据源"选择场景

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1SourceDevice` |
| 所属业务域 | 资产管理 / 数据源设备查询 |
| 接口分类 | 数据查询（无写入、无 schema） |
| 前置依赖 | 无（可直接调用）；建议调用前已存在数据源与设备数据 |
| 关联接口 | （无） |

## 使用场景

1. **资产筛选下拉框**：前端资产列表页的数据源筛选下拉框，展示数据源与设备层级
2. **资产上报页面**：资产上报页选择数据源/设备时，通过本接口获取完整数据源设备树
3. **数据源设备一致性核对**：第三方平台同步前先获取本接口结果，核对本地与远端数据源/设备一致性
4. **配合资产查询接口**：作为资产查询接口（如 `POST /api/xdr/v1/assets/list`）的 `source`/`devId` 字段值的前置获取接口
5. **删除设备审计**：已删除设备在树中保留并追加"（已删除）"后缀，便于审计与追溯

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/assets/sourcedevice |
| Content-Type | 无（GET 请求无请求体） |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/sourcedevice` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/sourcedevice`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/views.py:196-201`（GET handler）。

## 业务逻辑

### 核心处理流程

1. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，`@trans_ctx_pid_query(PlatformMode.SELF, OPENAPI_FAILED_RESPONSE)` 注入平台级查询上下文（SELF 模式：仅限本平台）。**注**：本接口无 `@v1_open_api_validate` 装饰器，不进行 schema 校验。
2. **业务函数 `get_source_device_info()` 调用**（源码 `asset_web/app/common/business/asset.py:1577-1678`）：
   1. **初始化参数**：本接口 handler 调用 `get_source_device_info()` 不传 `data`，故 `ignore_no_device=False`、`retain_specified_source=False`
   2. **获取所有类型设备**：调用 `get_devs_by_type(return_exist_error=True, update_siem_source_cfg=False)` 获取全部设备列表，返回 `(devs, exist_error)`；`exist_error` 标识获取设备列表是否失败
   3. **按类型分组**：遍历 `devs`，按 `dev["type"]` 分组到 `dev_map`（`{type: [dev, ...]}`）
   4. **遍历数据源类型映射**：遍历 `SOURCE.SOURCE_DEV_TYPE_MAP`（动态从 `asset_config` 读取未删除数据源构造的 `{id: {short_name, long_name, name, vendor}}`）：
      - 跳过 `NOT_FIRST_LEVEL_SOURCE` 中的数据源（隐藏网络域，不展示）
      - 若该数据源类型在 `dev_map` 中有设备：
        - 遍历设备，构造 `{name, id}` 节点；`is_delete=1` 的设备 `name` 追加 `Message.Device.Deleted.message(dev['name'])`（"\<dev_name\>（已删除）"）后缀
        - 若设备含 `children`，递归构造 `[{id, name}]` 子设备列表，挂到 `data["children"]`
        - 已删除设备节点追加到 `delete_device` 列表，未删除追加到 `children` 列表；最终 `children += delete_device`（已删除设备排在末尾）
      - 构造数据源节点 `{name: long_name, id: name, children?}`，仅当 `children` 非空时挂载
   5. **过滤无设备数据源**（本接口 `ignore_no_device=False`，**不触发过滤**，所有数据源均展示，无论是否有设备）
   6. **排序**：按 `SOURCE.SOURCE_SORT`（数据源排序权重表）对 `source_device_info` 排序，未在表中的数据源排到最后
   7. **插入全集占位项**：`source_device_info.insert(0, {"name": Identity.Common.All.translate(), "id": "all"})`，首项为"全部"
   8. **添加全集 ID**：调用 `add_full_id(source_device_info, key='id')` 为各层节点添加 `full_id` 字段（用于级联选择的完整路径）
3. **响应转换**：handler 调用 `transform_output(get_source_device_info())` 将下划线字段名转换为驼峰（如 `full_id` → `fullId`）；本接口字段名多为单词（`name`/`id`/`children`），转换后保持不变
4. **响应构造**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`，`code` 默认成功，`message` 默认为 `message.open_api.success.default`。

### 数据转换逻辑

- **数据源 `id` 字段**：使用数据源的 `name` 标识（MD5 派生或 `source_name.lower()`），而非自增 `id`
- **数据源 `name` 字段**：使用数据源的 `long_name`（长名，便于展示）
- **设备 `id`/`name` 字段**：直接取 `dev["id"]` 与 `dev["name"]`；已删除设备 `name` 追加"（已删除）"后缀
- **子设备 `children`**：仅当设备含 `children` 字段时构造子设备列表，每个子设备含 `{id, name}`
- **`full_id` 派生**：`add_full_id` 为各层节点添加 `full_id`（级联选择完整路径），转换后变为驼峰 `fullId`
- **响应字段名**：`transform_output` 将下划线转驼峰，单单词字段保持不变

### 默认行为

- `ignore_no_device=False`：不过滤无设备的数据源，所有未删除数据源均展示
- `retain_specified_source=False`：不特殊保留人工、风险关联等无设备数据源
- 隐藏网络域数据源（`NOT_FIRST_LEVEL_SOURCE`）不展示
- 已删除设备展示在父数据源 `children` 列表末尾，`name` 追加"（已删除）"后缀
- 数据源按 `SOURCE.SOURCE_SORT` 排序，未在表中的排到末尾
- 列表首项固定为 `{name: "全部", id: "all"}`

### 特殊规则

- **无 schema 校验**：本接口无 `@v1_open_api_validate` 装饰器，不校验请求参数；GET 请求无请求体
- **`exist_error` 处理**：`get_devs_by_type` 返回 `exist_error=True` 时（获取设备列表失败），不进行无设备数据源过滤；本接口因 `ignore_no_device=False` 本就不过滤，故 `exist_error` 实际不影响本接口行为
- **隐藏数据源**：`NOT_FIRST_LEVEL_SOURCE` 中的数据源不展示
- **已删除设备展示**：设备 `is_delete=1` 时仍展示在树中，`name` 追加"（已删除）"后缀，便于审计
- **全集占位项**：首项固定为 `{name: "全部", id: "all"}`，调用方筛选时传 `id="all"` 或不传表示全集
- **`SOURCE_DEV_TYPE_MAP` 动态**：基于 `asset_config` 中未删除数据源动态构造，跳过仅认证信息数据源（`belongs` 仅含 `AUTH_INFO_BELONG`）
- **响应外壳**：使用 `v1_open_api_output`，通过 `code` 字段判断成功

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| 无 | - | - | GET 请求，无特殊请求头要求；建议携带鉴权 Cookie/Token |

### 请求参数

本接口无请求参数（无 query string、无请求体、无 path 参数）。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值（默认 `message.open_api.success.default`） |
| message | string | 国际化文案 key，成功时为 `"message.open_api.success.default"` |
| data | array | 数据源设备树列表，元素结构见下 |

### data 数组元素结构（数据源节点）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 数据源长名（`long_name`）或"全部"（首项） | "OpenAPI 采集源 01" |
| id | string | 数据源 `name` 标识或 "all"（首项） | "openapi_source_01" |
| fullId | string | 级联选择完整路径（由 `add_full_id` 注入） | "all,openapi_source_01" |
| children | array | 该数据源下的设备列表，元素结构见下；无设备时不出现该字段 | [ {...} ] |

### children 数组元素结构（设备节点）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 设备 ID | "abc123def456abcd" |
| name | string | 设备名称；已删除设备追加"（已删除）"后缀 | "核心交换机-01" |
| fullId | string | 级联选择完整路径 | "all,openapi_source_01,abc123def456abcd" |
| children | array | 子设备列表（可选，仅采集设备有子设备时出现），元素结构同本表 | [ {...} ] |

### children.children 数组元素结构（子设备节点）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| id | string | 子设备 ID | "sub_dev_001" |
| name | string | 子设备名称 | "采集探针-01" |
| fullId | string | 级联选择完整路径 | "all,openapi_source_01,abc123def456abcd,sub_dev_001" |

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "name": "全部",
      "id": "all",
      "fullId": "all"
    },
    {
      "name": "OpenAPI 采集源 01",
      "id": "openapi_source_01",
      "fullId": "all,openapi_source_01",
      "children": [
        {
          "id": "abc123def456abcd",
          "name": "核心交换机-01",
          "fullId": "all,openapi_source_01,abc123def456abcd"
        },
        {
          "id": "def456abc123def0",
          "name": "边界防火墙-02（已删除）",
          "fullId": "all,openapi_source_01,def456abc123def0"
        }
      ]
    },
    {
      "name": "内部采集器-华北",
      "id": "internal_collector_hb_01",
      "fullId": "all,internal_collector_hb_01",
      "children": [
        {
          "id": "collector_001",
          "name": "采集探针-01",
          "fullId": "all,internal_collector_hb_01,collector_001",
          "children": [
            {
              "id": "sub_probe_01",
              "name": "子探针-01",
              "fullId": "all,internal_collector_hb_01,collector_001,sub_probe_01"
            }
          ]
        }
      ]
    }
  ]
}
```

## 调用示例

### 示例1：获取完整数据源设备树

**请求示例**：
```
GET /api/xdr/v1/assets/sourcedevice
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "name": "全部",
      "id": "all",
      "fullId": "all"
    },
    {
      "name": "OpenAPI 采集源 01",
      "id": "openapi_source_01",
      "fullId": "all,openapi_source_01",
      "children": [
        {
          "id": "abc123def456abcd",
          "name": "核心交换机-01",
          "fullId": "all,openapi_source_01,abc123def456abcd"
        }
      ]
    }
  ]
}
```

### 示例2：无数据源场景

**请求示例**：
```
GET /api/xdr/v1/assets/sourcedevice
```

**响应示例**（无数据源时仅返回全集占位项）：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": [
    {
      "name": "全部",
      "id": "all",
      "fullId": "all"
    }
  ]
}
```

### 示例3：错误示例——鉴权失败

**请求示例**（未携带有效 token）：
```
GET /api/xdr/v1/assets/sourcedevice
```

**错误响应示例**（HTTP 403，鉴权失败）：
```json
{
  "code": "ACCESS_DENY",
  "message": "<鉴权失败国际化文案>",
  "data": null
}
```

### 示例4：错误示例——系统错误

**请求示例**：
```
GET /api/xdr/v1/assets/sourcedevice
```

**错误响应示例**（HTTP 500，`SourceDao` 异常或 MongoDB 连接失败）：
```json
{
  "code": "V1_SYSTEM_ERROR",
  "message": "<系统错误信息>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- 本接口无请求参数，无 schema 校验
- 无请求体，无 query string，无 path 参数

### 参数依赖关系

- 本接口无入参依赖，但响应内容依赖系统中已创建的数据源与设备

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据，跨平台调用会失败

### 性能建议

- 业务层读取全量数据源配置与设备列表，数据源/设备数量较多时单次响应可能较大
- `SOURCE_DEV_TYPE_MAP` 动态从 `asset_config` 读取，Redis 缓存命中时性能较好；缓存未命中会回查 MongoDB
- 响应体含全部数据源与设备，建议前端做客户端缓存，避免高频调用

### 数据一致性说明

- **已删除设备仍展示**：设备 `is_delete=1` 时仍出现在树中，`name` 追加"（已删除）"后缀，便于审计；调用方应通过后缀识别已删除设备
- **隐藏数据源不展示**：`NOT_FIRST_LEVEL_SOURCE` 中的数据源不展示，调用方无法通过本接口获取这些数据源
- **全集占位项固定**：列表首项固定为 `{name: "全部", id: "all"}`，调用方筛选时传 `id="all"` 或不传表示全集
- **`fullId` 用于级联选择**：`fullId` 是各层 `id` 的逗号拼接，用于前端级联选择组件的完整路径回填
- **`id` 为数据源 `name` 而非自增 ID**：调用方关联资产时使用数据源 `name` 标识，而非自增 `id`
- **Redis 缓存与 MongoDB 同步**：`SourceDao.get_asset_source_cfg` 优先读 Redis，缓存未命中回查 MongoDB 并回填

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | 不适用 | 本接口无 schema 校验，不会触发该错误 | - |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | `get_devs_by_type` 内部异常被捕获 | 联系运维检查服务状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | `SourceDao` 查询异常、MongoDB 连接失败、SIEM 数据源配置读取失败 | 联系运维检查 MongoDB 连接与 Redis 可用性 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **作为数据源筛选的前置接口**：调用资产查询接口前先调用本接口，获取有效数据源 `id` 与设备 `id` 列表
2. **客户端缓存响应**：数据源/设备树变更频率低，前端应做客户端缓存（如 5 分钟），避免高频调用本接口
3. **通过"（已删除）"后缀识别已删除设备**：已删除设备仍展示，调用方应通过 `name` 后缀识别并过滤
4. **全集占位项 `id="all"`**：首项为全集，调用方筛选全部数据源时传 `id="all"` 或不传
5. **`fullId` 用于级联选择回填**：前端级联选择组件应使用 `fullId` 字段做完整路径回填，避免逐层查询
6. **隐藏数据源不展示**：如需获取 `NOT_FIRST_LEVEL_SOURCE` 中的数据源，联系运维直接查询 MongoDB
7. **响应字段为驼峰**：经 `transform_output` 转换，字段名为驼峰（如 `fullId`），调用方按驼峰消费
