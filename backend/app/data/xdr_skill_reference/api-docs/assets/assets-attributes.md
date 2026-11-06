# POST /api/xdr/v1/assets/attributes

## 接口概述

本接口用于根据资产 ID 列表批量获取资产的指定属性信息。通过本接口，您可以获取以下资产属性类别：

### 可查询的资产属性类别
- **interfaces（网络接口）**：IP/MAC、子网掩码、运营商、暴露面、是否动态、是否失效、首次/末次发现时间，含历史 IP
- **adapter（数据源适配器）**：sid、vendor、productType、productVer、originSid、originProductType、originProductVer、adapterType
- **device（设备基础信息）**：主机名、分类、在线状态、版本、版本分发、厂商、规格、详细、序列号、位置、重要性、备注
- **os（操作系统信息）**：cpe、type、bitness、lang、version、edition、kernelVersion、buildVersion、distribution、vendor、detail、activeStatus、accreditedTime、installTime、servicePack
- **user（账号信息）**：账号 uid、name、gid、groupName、authorityLevel、createTime、home、shell、status、type、risks 等

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1AssetAttributes`（`open_api/v1/resources/asset/views.py:267`） |
| 所属业务域 | 资产管理 / 资产属性查询 |
| 接口分类 | 数据查询（多资产多属性批量查询，无写入） |
| 前置依赖 | `assetIds` 中的资产 ID 应存在于 `assets` 集合；调用方需先通过 `POST /api/xdr/v1/assets/list` 等接口获取资产 ID |
| 关联接口 | `POST /api/xdr/v1/assets/list`（资产列表查询，获取 assetId）、`POST /api/xdr/v1/assets`（新增资产） |

## 使用场景

1. **批量查询资产网络接口**：根据一批资产 ID 获取其当前 IP/MAC 列表与历史 IP，用于资产关联分析、网络拓扑构建
2. **批量查询资产操作系统**：根据一批资产 ID 获取 OS 详情（type、version、distribution 等），用于补丁合规性检查
3. **批量查询资产设备信息**：根据一批资产 ID 获取 device 字段（hostname、classify、onlineStatus 等），用于资产大盘展示
4. **批量查询资产数据源适配器**：根据一批资产 ID 获取 adapter 信息，用于数据源追溯
5. **联动资产列表接口**：先调用 `/assets/list` 拿到资产 ID，再调用本接口补全属性详情

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/attributes |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/attributes` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/attributes`（asm.yaml 第 134-147 行，v1 assets wildcard 映射）。源码位于 v1 模块 `open_api/v1/resources/asset/views.py:267`，业务实现委托给 v2 模块 `open_api/v2/asset/business.py:639` 的 `handle_asset_attributes`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.V1_ASSET_ATTRIBUTES_REQ)` 校验请求体符合 JSON Schema 约束（详见"请求参数"段）。校验失败抛 `V1OpenAPIError(ERROR.V1_INVALID_PARAMETER)`。
2. **登录鉴权 + 上下文**：`@auth_expr(expression="")` 校验登录态（鉴权失败返回 `ACCESS_DENY_RESPONSE`）；本 Resource 未显式注入 `@trans_ctx_pid_query`，平台过滤由 `AssetDao.get_asset_data` 内部通过 `platform_filter=PlatformFlag.RWCTX` 自动注入。
3. **驼峰参数转下划线**：`data = transform_hump_params(data)` —— 将 `assetIds` → `asset_ids`、`pageIndex` → `page_index` 等驼峰键递归转换为下划线键，匹配 v2 业务函数入参约定（`open_api/v1/resources/common.py:21`）。
4. **委托 v2 业务函数 `handle_asset_attributes(data)`**（源码 `open_api/v2/asset/business.py:639`）：
   1. **分页参数注入**：`limit` 默认 50，`page_index` 默认 1，`skip = (page_index - 1) * limit`。
   2. **MongoDB 过滤构造**：`db_filters = {"asset_id": {"$in": asset_ids}}`，按资产 ID 列表批量查询 `assets` 集合。
   3. **投影字段构造**：`projection_dict = get_asset_attributes_projection(attributes)` —— 始终投影 `_id:0, belong_host:1, asset_id:1, platform_id:1`；按 `attributes` 选择性投影：
      - `interfaces` → 投影 `history_ips`、`ips`
      - `adapter` → 投影 `adapter`
      - `device`/`os`/`user` 等其他项 → 直接投影同名键
   4. **DAO 查询**：`AssetDao.get_asset_data(db_filters, projection_dict, skip=skip, limit=limit, sort=[("asset_id", 1)])`（`asset_common/dao/asset.py:319`），按 `asset_id` 升序排序，`allow_disk_use=True`。
   5. **device/os 字段集成**：若 `attributes` 含 `device` 或 `os`，调用 `integrate_data(cursors, extend_fields)` 补齐衍生字段（源码 `asset_web/app/common/integrate/integrate_adapter.py:194`）。
   6. **平台信息渲染**：对每个 cursor 调用 `render_platform_info(asset_id, platform_id, cursor)`，注入平台归属信息。
   7. **网端资产合并**：若 `belong_host != 0`，视为该资产是"网端"绑定资产，需要二次查询其归属的"端侧"资产信息，用端侧资产数据覆盖 `assets_dict[net_sort_id]`（保持原 `asset_id` 不变）。
   8. **属性输出转换**：`transform_attribute_output(cursor, attributes)`（源码 `open_api/v2/asset/business.py:615`）：
      - 移除 `belong_host`
      - `interfaces` 模式：将 `ips` 与 `history_ips` 合并为 `interfaces` 数组，每项 `addr` → `ip`，并补充 `is_invalid`（当前 IP 为 `IpInvalid.NO`，历史 IP 为 `IpInvalid.YES`）
      - `adapter` 模式：将 `sid` → `id`，补充 `adapter_type="big_data"`
   9. **构造返回字典**：`rslt = {v.pop("asset_id"): v for v in assets_dict.values()}` —— 以 `asset_id` 为 key，对应属性对象为 value。
5. **响应外壳**：`res = transform_output(res)`（下划线键转回驼峰，`open_api/v1/resources/common.py:151`） → `v1_open_api_output(data=res)`，返回 OpenAPI 外壳 `{code, message, data}`。

### 数据转换逻辑

- **入参驼峰转下划线**：`assetIds` → `asset_ids`、`pageIndex` → `page_index`、`attributes` 保持不变（已为下划线兼容）
- **出参下划线转驼峰**：返回 data 字典的 key 仍为 `asset_id`（整数），但 value 对象内部所有下划线字段（如 `first_seen`、`is_invalid`、`platform_id`）会递归转换为驼峰（`firstSeen`、`isInvalid`、`platformId`）
- **interfaces 字段重组**：MongoDB 中 `ips` 与 `history_ips` 是独立数组，本接口合并为统一 `interfaces` 数组，每项添加 `ip`（原 `addr`）和 `isInvalid` 标记区分当前/历史
- **adapter 字段重命名**：`sid` → `id`，并注入 `adapterType="big_data"` 表示大数据来源
- **网端资产映射**：`belong_host` 字段在响应中被移除，但其值用于在网端资产和端侧资产之间做数据替换

### 默认行为

- `limit` 缺省 → 50
- `page_index` 缺省 → 1
- `attributes` 缺省（schema 必填，调用方必须传）→ 内部默认 `["interfaces"]`（`handle_asset_attributes` 内 `data.get("attributes", ["interfaces"])` 兜底）
- 排序固定按 `asset_id` 升序
- `additionalProperties` 未在 schema 中显式声明 `false`，因此请求体允许出现 schema 中未声明的字段（但会被 `transform_hump_params` 一并转换并最终忽略）

### 特殊规则

- **`assetIds` 与 `attributes` 均为必填**：缺任一字段会触发 schema 校验失败
- **`attributes` 枚举严格限制**：仅允许 `["interfaces", "adapter", "device", "os", "user"]` 五个值，`hardware` 因改为后端实时聚合已从枚举中删除
- **`assetIds` 上限 1000**：单次请求最多查询 1000 个资产
- **`attributes` 上限 12**：单次请求最多查询 12 个属性类别
- **网端资产合并逻辑**：若资产是网端绑定资产（`belong_host != 0`），会二次查询其归属的端侧资产，端侧资产属性会替换网端资产的属性；返回字典中保留的是网端资产的 `asset_id`，但属性数据来自端侧
- **`integrate_data` 副作用**：当请求 `device` 或 `os` 时，`integrate_data` 会就地修改 cursor 对象，补齐衍生字段

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetIds | array | 是 | 无 | maxItems=1000；元素为 integer，minimum=0；资产 ID 列表 | [1001, 1002, 1003] |
| attributes | array | 是 | 无 | maxItems=12；元素为 string，枚举值见下表；要查询的属性类别列表 | ["interfaces", "os"] |
| pageIndex | integer | 否 | 1 | minimum=1；页码，从 1 开始 | 1 |
| limit | integer | 否 | 50 | minimum=1；每页条数 | 50 |

#### attributes 枚举值说明

| 值 | 含义 | 投影字段 | 输出处理 |
|----|------|---------|---------|
| interfaces | 网络接口（IP/MAC/子网/暴露面等，含历史 IP） | `ips`、`history_ips` | 合并为 `interfaces` 数组，`addr` → `ip`，补 `isInvalid` 标记 |
| adapter | 数据源适配器信息 | `adapter` | `sid` → `id`，补 `adapterType="big_data"` |
| device | 设备基础信息（hostname、classify、onlineStatus 等） | `device` | 经 `integrate_data` 补齐衍生字段 |
| os | 操作系统信息（type、version、distribution 等） | `os` | 经 `integrate_data` 补齐衍生字段 |
| user | 账号信息（uid、name、gid、shell 等） | `user` | 原样输出 |

> 注：`hardware` 项已从枚举中删除（后端改为实时聚合，暂无外部调用需求）。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值（具体成功码值以 `app_util.v1_open_api_output` 默认实现为准） |
| message | string | 国际化文案 key，成功时为 `message.open_api.success.default` |
| data | object | 资产属性查询结果，以 `asset_id`（整数）为 key，属性对象为 value |

### data 结构说明

`data` 是一个对象，键为资产 ID（integer），值为该资产对应的属性对象。属性对象的字段取决于请求的 `attributes` 列表。

#### 通用字段（所有查询均返回）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| platformId | string | 资产所属平台 ID |

#### interfaces 模式下属性对象字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| interfaces | array | 网络接口列表，元素结构见下 |

##### interfaces 数组元素结构

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| ip | string | IP 地址（原 MongoDB `addr` 字段） | "10.1.1.100" |
| mac | string | MAC 地址 | "aa:bb:cc:dd:ee:ff" |
| subnet | integer | 子网掩码长度，0-128 | 24 |
| exposure | integer | 暴露面枚举，0-3 | 1 |
| carrier | integer | 运营商枚举，0-4 | 0 |
| isDynamic | integer | 是否动态 IP，0/1 | 0 |
| isInvalid | integer | 是否失效（NO=当前 IP，YES=历史 IP） | 0 |
| type | integer | IP 类型枚举，0/1 | 0 |
| firstSeen | integer | 首次发现时间戳（秒） | 1695000000 |
| lastSeen | integer | 末次发现时间戳（秒） | 1695100000 |

#### adapter 模式下属性对象字段

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| adapter | array | 数据源适配器列表，元素结构见下 |

##### adapter 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | string | 适配器 sid（原 MongoDB `sid`） |
| vendor | string | 厂商 |
| productType | string | 产品类型 |
| productVer | string | 产品版本 |
| adapterType | string | 固定值 `"big_data"` |
| originSid | string | 源 sid（可选） |
| originProductType | string | 源产品类型（可选） |
| originProductVer | string | 源产品版本（可选） |

#### device / os / user 模式

返回 MongoDB 中对应字段的原始结构（经 `integrate_data` 处理后），字段名按驼峰命名转换。

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "1001": {
      "platformId": "platform-001",
      "interfaces": [
        {
          "ip": "10.1.1.100",
          "mac": "aa:bb:cc:dd:ee:ff",
          "subnet": 24,
          "exposure": 1,
          "isDynamic": 0,
          "isInvalid": 0,
          "firstSeen": 1695000000,
          "lastSeen": 1695100000
        },
        {
          "ip": "10.1.1.200",
          "mac": "",
          "subnet": 24,
          "exposure": 0,
          "isDynamic": 1,
          "isInvalid": 1,
          "firstSeen": 1694000000,
          "lastSeen": 1694500000
        }
      ]
    },
    "1002": {
      "platformId": "platform-001",
      "interfaces": [
        {
          "ip": "10.1.1.101",
          "mac": "aa:bb:cc:dd:ee:00",
          "subnet": 24,
          "isInvalid": 0
        }
      ]
    }
  }
}
```

## 调用示例

### 示例1：查询资产的网络接口信息

**请求示例**：
```json
{
  "assetIds": [1001, 1002, 1003],
  "attributes": ["interfaces"]
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "1001": {
      "platformId": "platform-001",
      "interfaces": [
        {"ip": "10.1.1.100", "mac": "aa:bb:cc:dd:ee:ff", "subnet": 24, "isInvalid": 0}
      ]
    },
    "1002": {
      "platformId": "platform-001",
      "interfaces": [
        {"ip": "10.1.1.101", "mac": "aa:bb:cc:dd:ee:00", "subnet": 24, "isInvalid": 0}
      ]
    },
    "1003": {
      "platformId": "platform-001",
      "interfaces": [
        {"ip": "10.1.1.102", "mac": "aa:bb:cc:dd:ee:11", "subnet": 24, "isInvalid": 0}
      ]
    }
  }
}
```

### 示例2：分页查询资产的操作系统信息

**请求示例**：
```json
{
  "assetIds": [1001, 1002, 1003, 1004, 1005],
  "attributes": ["os"],
  "pageIndex": 1,
  "limit": 2
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "1001": {
      "platformId": "platform-001",
      "os": {"type": "Linux", "distribution": "CentOS", "version": "7.9.2009", "bitness": 64}
    },
    "1002": {
      "platformId": "platform-001",
      "os": {"type": "Windows", "version": "10.0.19041", "bitness": 64}
    }
  }
}
```

### 示例3：组合查询多个属性类别

**请求示例**：
```json
{
  "assetIds": [1001],
  "attributes": ["interfaces", "device", "os", "user"]
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "1001": {
      "platformId": "platform-001",
      "interfaces": [{"ip": "10.1.1.100", "mac": "aa:bb:cc:dd:ee:ff", "isInvalid": 0}],
      "device": {"hostname": "db-server-01", "classify1Id": 1, "classifyId": 1, "onlineStatus": 1},
      "os": {"type": "Linux", "version": "7.9", "distribution": "CentOS"},
      "user": [{"uid": "root", "name": "root", "gid": 0, "status": 1}]
    }
  }
}
```

### 示例4：错误示例——缺少必填字段

**请求示例**（缺少 `attributes`）：
```json
{
  "assetIds": [1001]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'attributes: required'>",
  "data": null
}
```

### 示例5：错误示例——attributes 枚举非法

**请求示例**（`attributes` 含未定义值 `"hardware"`）：
```json
{
  "assetIds": [1001],
  "attributes": ["hardware"]
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'attributes: hardware is not one of [interfaces, adapter, device, os, user]'>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `assetIds` 必填，maxItems=1000，元素必须为 integer 且 `>= 0`
- `attributes` 必填，maxItems=12，元素必须为枚举值 `["interfaces", "adapter", "device", "os", "user"]`
- `pageIndex` 可选，必须为 integer 且 `>= 1`
- `limit` 可选，必须为 integer 且 `>= 1`
- schema 未显式声明 `additionalProperties=false`，但建议只传 schema 中声明的字段

### 参数依赖关系

- `assetIds` 决定查询范围，`attributes` 决定投影字段；二者独立但都必填
- `pageIndex` 与 `limit` 共同决定分页（`skip = (pageIndex - 1) * limit`）
- `device` 与 `os` 属性会触发 `integrate_data`，可能引入额外的衍生字段

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `AssetDao.get_asset_data` 内部默认通过 `platform_filter=PlatformFlag.RWCTX` 注入平台过滤，限制返回本平台可见资产

### 性能建议

- `assetIds` 上限 1000，建议批量调用而非单条循环
- `attributes` 项越多，单次查询投影字段越多、响应体越大；按需选择属性类别
- 查询使用 `allowDiskUse=True`，大数据集可能使用磁盘临时文件
- 网端资产合并逻辑会触发二次查询，若 `assetIds` 中网端资产较多会有额外开销

### 数据一致性说明

- **网端资产数据替换**：返回字典的 key 为网端资产 `asset_id`，但属性数据可能来自其绑定的端侧资产；调用方应按 key 索引数据，不要假设属性一定属于该 `asset_id` 对应的物理资产
- **历史 IP 标记**：`interfaces` 数组中 `isInvalid=1` 的项为历史 IP，`isInvalid=0` 为当前 IP
- **响应 key 为整数**：`data` 对象的 key 为 `asset_id`（integer），JSON 序列化后会变成字符串，调用方消费时应做类型兼容
- **下划线转驼峰**：响应体内部所有下划线字段会被递归转为驼峰，调用方应按驼峰命名消费

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `assetIds: required`、`attributes: required`、`attributes: hardware is not one of ...`、`assetIds: too many items`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段，对照"请求参数"段检查类型/必填/长度/枚举约束 |
| V1_UNKNOWN (HTTP 400, code=1103) | `<业务异常信息>` | `handle_asset_attributes` 内部抛出业务异常（如查询条件不合法） | 联系运维检查请求参数与服务状态 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 查询失败 / `integrate_data` 失败 / 网端资产二次查询失败 | 联系运维检查 MongoDB 连接与 `assets` 集合状态 |
| ACCESS_DENY (HTTP 403) | 鉴权失败 | 未登录或登录态失效 | 重新登录获取有效 token |

## 最佳实践

1. **`assetIds` 控制在合理范围**：单次请求不超过 1000，过大会导致响应体过大、查询超时；建议分批调用
2. **`attributes` 按需选择**：仅请求业务需要的属性类别，避免一次性请求所有属性导致响应体过大
3. **联动 `/assets/list` 获取 assetId**：本接口不提供资产列表，调用方应先通过 `POST /api/xdr/v1/assets/list` 查询并提取 `assetId`，再调用本接口补全属性
4. **网端资产识别**：消费响应时，若属性数据与预期不符，可能是因为该 `asset_id` 是网端绑定资产，实际属性来自端侧资产
5. **历史 IP 区分**：`interfaces` 中 `isInvalid=1` 的项为历史 IP，调用方做网络拓扑分析时应过滤或单独标记
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含属性查询结果（以 `asset_id` 为 key 的字典）
