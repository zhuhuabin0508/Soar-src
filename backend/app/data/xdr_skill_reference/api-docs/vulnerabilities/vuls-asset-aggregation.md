# POST /api/xdr/v1/vuls/asset/aggregation

## 接口概述

本接口用于按资产维度聚合统计脆弱性数量。通过本接口，您可以获取以下内容：

### 可查询的脆弱性资产聚合信息
- **聚合维度**：按资产ID、资产IP（asset 字段）、资产名称、责任人、资产组（business_id）、业务组（group_id）等任意资产属性分组
- **聚合指标**：漏洞数量、弱密码数量、风险数量等任意数值字段的 count/sum/avg/max/min/addToSet/first/uniq
- **过滤条件**：修复优先级、脆弱性类型、资产类型、处置状态、互联网暴露、资产重要性、关键字、CVE 等

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `VulsAssetAgg` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/asset/views.py`（注意：不在 `open_api/v1/` 也不在 `open_api/v2/`，由 `view/vuln/asset/openapi_v2.py:17` 注册到 `/vuls/asset/aggregation`） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/asset/business.py` → `get_vuls_asset_agg(data)` → DAO `soar/apps/vuln_web/app/models/soar_db/host_vul_middle.py` → `MyHostVulMiddle.get_vuls_asset_agg(data)`；聚合管道由 `vuln_common/model/vuln_agg.py` → `VulnAgg` 构造，过滤条件由 `vuln_common/model/query_builder.py` → `MyHostVulMiddleQuery.generate_query` 构造 |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/asset/params.py` → `VULS_ASSET_AGG_SCHEMA`（共用字段来自 `vuln_web/app/common/params.py`） |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/asset/aggregation` 经 etcd 路由 `openapi_asm_vuls_asset_aggregation_v1` 转后端 `/order/v2/openapi/vuls/asset/aggregation`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - 资产视角聚合 |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/asset/stats`（脆弱性资产数据统计）、`/api/xdr/v1/vuls/asset/topn`（资产 TopN） |

## 使用场景

1. **资产看板**：按资产维度聚合，统计每台资产的漏洞数量，用于资产脆弱性热力图
2. **责任分布**：按责任人聚合，统计每个责任人名下资产的脆弱性总数
3. **业务组统计**：按业务组聚合，对比各业务组的脆弱性分布
4. **趋势分析**：与 `/api/xdr/v1/vuls/risk/trends` 配合，先聚合当前状态，再查询时间趋势
5. **TopN 分析**：与 `/api/xdr/v1/vuls/asset/topn` 配合，先聚合后取 TopN 排序
6. **多维交叉**：同时按资产IP + 修复优先级聚合，交叉分析资产与优先级分布

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/asset/aggregation` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.VULS_ASSET_AGG_SCHEMA, open_api=True)` 对请求体执行 JSON Schema 校验，必填字段缺失或类型不匹配时直接返回 400
2. **权限校验**：`@auth_expr` 装饰器校验 `superAdmin` 或 `riskManageQuery` 权限，无权限返回 `ACCESS_DENY_RESPONSE`
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=False)` 处理 filterParam 内部字段（递归特殊重命名 + 小驼峰转下划线 + 时间戳转时间范围）
4. **agg_by 单独转换**：`new_data["agg_by"] = [camelcase_to_underscore(key) for key in new_data["agg_by"]]`——注意 `transform_openapi_params` **不递归到 `aggBy`**（它只对 `filterParam` 递归 `transform_special_params`），所以 aggBy 走的是另一条只做大小写转换的路径（`camelcase_to_underscore` = `re.sub(r'(?<!^)(?=[A-Z])', '_', key).lower()`，纯字母大小写切片，不做任何业务字段重命名）
5. **聚合查询**：`get_vuls_asset_agg(new_data)` → DAO `MyHostVulMiddle.get_vuls_asset_agg`：
   - 先 `data.update(data.get('filter_param', {}))` 把 filterParam 平铺到外层
   - `MyHostVulMiddleQuery.generate_query(data)` 生成 `$match` 过滤条件（filterParam 字段在此处被 query builder 做平台树展开、字段名映射）
   - `VulnAgg.build_unwind_operation` 对 `aggBy`/`aggFuncs.param` 中含 `asset`/`fixed_status`/`disposal_tag` 的字段自动 `$unwind`
   - `VulnAgg.build_group_operation` 构造 `$group`：`_id = {key: f"${key}" for key in agg_by}`，直接用 aggBy 元素作 MongoDB 字段名取值
   - `VulnAgg.build_flatten_project_operation` 把 `_id.{key}` 平铺回顶层字段
   - `build_sort_operation` 仅支持单字段 `field:asc|desc`，多字段会触发 ValueError
   - `$limit` 默认 5
6. **响应转换**：`snake_to_camel(result)` 把下划线 key 转回小驼峰
7. **响应封装**：`output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道：`code` 字段值是 V1_ERROR_MAP 映射后的字符串（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno

### 数据转换逻辑

入参到 DB 的字段名映射有**两条不同的路径**，filterParam 与 aggBy 必须区分对待：

| 入参字段 | 路径 | 中间名 | DB 字段（最终匹配） |
|---|---|---|---|
| `filterParam.assetBranchIds` | `transform_special_params` 重命名为 `branchIds` → `camel_to_snake` → `branch_ids` → query builder `build_branch_and_group_query` | `branch_ids` | `business_id`（含子组展开） |
| `filterParam.assetGroupIds` | `transform_special_params` 重命名为 `groupIds` → `camel_to_snake` → `group_ids` → query builder `build_branch_and_group_query` | `group_ids` | `group_id`（含子组展开） |
| `filterParam.fixPriority` | `camel_to_snake` → `fix_priority` → query builder `build_fix_priority_query` | `fix_priority` | `fix_priority_level` |
| `filterParam.assetIp` | `camel_to_snake` → `asset_ip` → query builder `build_asset_ip_query` | `asset_ip` | `asset`（IP 全格式 + 模糊匹配） |
| `filterParam.assetType` | `camel_to_snake` → `asset_type` → query builder `build_asset_type_query` | `asset_type` | `asset_type` |
| `aggBy[i]` 任意元素 | **仅** `camelcase_to_underscore` 大小写转换，**不**经 query builder | 下划线形式 | `$group._id[key] = f"${key}"` 直接取 MongoDB 字段，**必须是 DB 真实字段名** |

> **关键**：`transform_special_params`（transform.py:37-64）只对 `filterParam` 递归，**完全不作用于顶层 `aggBy` 数组**。所以 filterParam 里能用 `assetBranchIds`/`assetGroupIds` 命中的字段，aggBy 里直接传同名 key 会变成 `asset_branch_ids`/`asset_group_ids`，无此 DB 字段，聚合全部归到 `_id: null` 单桶（详见下方 trap 表）。

出参下划线 → 小驼峰：`{"asset": "192.168.1.1", "total_count": 10}` → `{"asset": "192.168.1.1", "totalCount": 10}`

### 默认行为

- `need_default_time_range=False`：不传 `startTimestamp`/`endTimestamp` 时**不会**自动填充默认时间范围（schema 已强制要求，违反直接 1104）
- `agg_by` 未传时初始化为空列表 `[]`（schema 要求必填）
- `sort` 未传时**不排序**（聚合管道不追加 `$sort` 阶段，桶顺序由 MongoDB 自然顺序决定，不保证稳定）
- `limit` 未传时 DAO 默认 **5**（`data.get("limit", 5)`）；schema 限制 1-100

### 特殊规则

- `aggBy` 和 `aggFuncs` 为必填字段，缺失时 schema 校验失败
- `aggFuncs` 中 `name` 和 `func` 必填，`param` 可选；`func` 实际支持 `count`/`sum`/`max`/`min`/`avg`/`addToSet`/`first`/`uniq`（`uniq` 在 flatten_project 阶段转 `$size` 返回去重计数）；`param` 在 `func != count` 时必填，指向聚合字段名（同 aggBy 取值规则，须为 DB 真实字段名小驼峰形式）
- `filterParam` 内的过滤字段全部可选，不传时不过滤
- `timeField` 必须为 `update_time`/`found_time`/`last_time` 之一（schema 枚举），但 transform_timestamp2range 对 `last_time` 走默认分支（生成 `latest_time_range`），与命名不符——优先使用 `update_time`/`found_time`
- 聚合管道在 DAO 层执行 MongoDB aggregate，使用 `allowDiskUse=True` 支持大数据量聚合

### aggBy 取值规则（核心 trap）

aggBy 元素经 `camelcase_to_underscore` **只做大小写转换**，**不**经过 query builder 的字段名映射（`build_branch_and_group_query`、`build_fix_priority_query` 等只在 filterParam 路径上调用）。`$group._id[key] = f"${key}"` 直接用结果字符串当 MongoDB 字段名取值，**取不到值的字段会让所有记录归到 `_id: null` 单桶**。

#### 单桶症状对照表

| 现象 | 根因 | 修正 |
|------|------|------|
| 响应 `item` 只有 1 个桶，所有维度字段为 `null`/缺失，`totalCount = N`（总记录数） | aggBy 用了 schema 字段名（`assetBranchIds`/`assetGroupIds`/`fixPriority` 等）而非 DB 真实字段名 | 改用 DB 字段名小驼峰形式（见下表） |
| 响应 `item` 为空 `[]` 但 `meta` 非空 | filterParam 过滤条件把数据全滤掉了 | 缩小 filterParam 范围，或检查时间范围 |
| 响应 `item` 桶数远多于预期，每条源记录展开成多桶 | aggBy 含 `asset`/`fixed_status`/`disposal_tag` 等数组字段，被 `VulnAgg.build_unwind_operation` 自动 `$unwind` | 这是预期行为；若不希望展开，去掉该 aggBy 维度 |

#### aggBy 常用合法字段（小驼峰 → DB 字段）

| aggBy 入参 | camelcase_to_underscore 后 | DB 字段含义 | 是否数组字段（自动 unwind） |
|---|---|---|---|
| `asset` | `asset` | 资产 IP（全格式） | 是 |
| `assetId` | `asset_id` | 资产 ID | 否 |
| `assetName` | `asset_name` | 资产名称 | 否 |
| `assetType` | `asset_type` | 资产类型 | 否 |
| `assetManager` | `asset_manager` | 资产责任人 | 否 |
| `businessId` | `business_id` | 资产组 ID | 否 |
| `groupId` | `group_id` | 业务组 ID | 否 |
| `fixPriorityLevel` | `fix_priority_level` | 修复优先级 | 否 |
| `magnitude` | `magnitude` | 资产重要性 | 否 |
| `exposure` | `exposure` | 互联网暴露 | 否 |
| `assetStatus` | `asset_status` | 资产管理状态 | 否 |
| `status` | `status` | 处置状态（HostVulMiddle 用 `status`，注意与 `fixed_status` 区分） | 是 |
| `fixedStatus` | `fixed_status` | 处置状态（VulRiskMiddle 用，HostVulMiddle 上无此字段） | 是 |
| `disposalTag` | `disposal_tag` | 处置标签 | 是 |
| `assetTags` | `asset_tags` | 资产标签 | 否 |
| `name` | `name` | 漏洞名（按语言自动取 `name_zh`/`name_en`） | 否 |
| `level` | `level` | 风险等级（仅 VulRiskMiddle） | 否 |

> **不要直接传 schema 里的 `assetBranchIds`/`assetGroupIds`/`fixPriority`/`vulnType` 作 aggBy**——这些是 filterParam 字段名，进 aggBy 路径会变成 `asset_branch_ids`/`asset_group_ids`/`fix_priority`/`vuln_type`，DB 上无对应字段，全部归单桶。

> **meta.type 不可信**：`VUL_RISK_MIDDLE_FIELD_MAP` 只覆盖 4 个字段（`asset`→String、`deal_status`→Integer、`fix_priority_level`→Integer、`level`→Integer），其他字段一律回退到 `"Integer"`，即便真实类型是字符串。所以 `assetType`/`assetManager` 等字段的 meta.type 也会显示 `"Integer"`，不要据此判断字段实际类型。

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒） | 1717200000 |
| endTimestamp | integer | 是 | - | ≥ 0 的 Unix 时间戳（秒） | 1719800000 |
| timeField | string | 是 | - | 时间字段，schema 枚举 `update_time`/`found_time`/`last_time`。trap：transform_timestamp2range 仅对 `update_time`/`found_time`/`last_scan_time` 三个 key 有专门分支，`last_time` 会落入默认分支生成 `latest_time_range` 字段（而非 `last_time_range`），与命名暗示不符 | "found_time" |
| filterParam | object | 否 | - | 过滤条件对象 | 见下方 |
| aggBy | array&lt;string&gt; | 是 | - | 聚合维度字段名列表（小驼峰），maxLength=64，最少 1 个 | ["assetIp", "fixPriority"] |
| aggFuncs | array&lt;object&gt; | 是 | - | 聚合函数列表，至少 1 个 | 见下方 |
| sort | string | 否 | - | 排序表达式，schema 正则允许多字段 `^(\w+(:asc\|:desc)?)(,\w+(:asc\|:desc)?){0,4}$`，**但后端 `build_sort_operation` 仅支持单字段 `field:asc\|desc`**，多字段触发 `ValueError` → `"InternalError"` | "totalCount:desc" |
| limit | integer | 否 | 5 | ≥ 1，≤ 100（schema `LIMIT_MIN1` 限制），返回聚合桶上限，未传时 DAO 默认 5 | 100 |
| platformFilter | array&lt;object&gt; | 否 | - | 平台过滤数组，每个元素 `{"platformId": 必填, "branchIds": 可选, "groupIds": 可选}`。**`platformId` 必须是当前租户平台树中真实存在的 ID**——传不存在的 platformId 会触发 `TypeError: 'NoneType' object is not iterable`（后端按 platformId 展开子资产组时找不到节点）。如不确定 platformId，先用平台查询接口取真实值 | `[{"platformId": "P1", "branchIds": [101]}]` |

#### filterParam 结构

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| fixPriority | array&lt;integer&gt; | 否 | - | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| assetBranchIds | array&lt;integer&gt; | 否 | - | 资产组 ID 列表。filterParam 路径：`assetBranchIds` →（`transform_special_params` 重命名）`branchIds` →（`camel_to_snake`）`branch_ids` →（query builder `build_branch_and_group_query`，含子组展开）Mongo `business_id` | [101, 102] |
| assetGroupIds | array&lt;integer&gt; | 否 | - | 业务组 ID 列表。filterParam 路径：`assetGroupIds` → `groupIds` → `group_ids` → query builder → Mongo `group_id`（含子组展开）。**注意**：此映射仅在 filterParam 内有效；aggBy 里传同名 key 不走此路径，需传 `businessId`/`groupId` | [201, 202] |
| assetType | string | 否 | - | 资产类型，参考 enum-dictionary-python.md。`all`/全部, `server`/服务器, `terminal`/终端, `other`/其他 | "server" |
| vulnType | array&lt;string&gt; | 否 | - | 脆弱性类型，参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码, `baseline`/基线 | ["loophole"] |
| branchType | string | 否 | - | 业务组类型，枚举 `branch`/`group`。**必传字符串，传 integer（如 1）会触发 `branch_type格式有误` 校验错误** | "branch" |
| branchId | integer | 否 | - | 业务组 ID | 1 |
| keyword | string | 否 | - | 关键字模糊匹配，maxLength=100 | "log4j" |
| keywordAll | string | 否 | - | 关键字全字段匹配，maxLength=100 | "log4j" |
| fixedStatus | array&lt;integer&gt; | 否 | - | 处置状态，参考 enum-dictionary-python.md。0/待处置, 1/处置中, 2/已修复, 3/已接受, 4/已忽略, 5/误报, 6/改善, 7/加白, 100/处置完成 | [0, 1] |
| limit | integer | 否 | - | 0-100 | 50 |
| offset | integer | 否 | - | ≥ 0 | 0 |
| exposure | array&lt;string&gt; | 否 | - | 互联网暴露，参考 enum-dictionary-python.md。`yes`/暴露, `no`/未暴露, `unknown`/未知 | ["yes"] |
| magnitude | array&lt;string&gt; | 否 | - | 资产重要性，参考 enum-dictionary-python.md。`normal`/普通, `core`/核心 | ["core"] |
| assetTags | array&lt;string&gt; | 否 | - | 资产标签列表 | ["tag1"] |
| assetIp | object | 否 | - | 资产 IP 查询条件，**必须传 object**：`{"op": "="/"like", "val": string}`。`op` 仅支持 `"="`（精确相等）和 `"like"`（模糊匹配）；`val` 为 IP 字符串，多个 IP 用逗号分隔。**传字符串（如 `"192.168.1"`）会被拦截返回 `{"code":"InvalidParameter","message":"IP格式有误"}`**；`op` 传其他值触发 `ValueError: The ip does not support this query operator` | {"op": "like", "val": "192.168.1"} |
| assetManager | string | 否 | - | 资产责任人，maxLength=255 | "张三" |
| cve | object | 否 | - | CVE 编号查询条件，对象结构 `{"op": "eq"/"in"/"like", "val": string 或 array<string>}`。**必传 object，传字符串（如 "CVE-2021-44228"）会触发 `TypeError: string indices must be integers`** | {"op": "eq", "val": "CVE-2021-44228"} |
| assetStatus | array&lt;integer&gt; | 否 | - | 资产管理状态列表，**必须传数组**，传单个 integer 会校验失败 | [1] |

#### aggFuncs 元素结构

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| name | string | 是 | 聚合结果字段名，maxLength=64 | "totalCount" |
| func | string | 是 | 聚合函数名，支持 `count`/`sum`/`max`/`min`/`avg`/`addToSet`/`first`/`uniq`，maxLength=64。`uniq` 在 project 阶段转 `$size` 返回去重计数 | "count" |
| param | string | 否 | 聚合函数参数（`func != count` 时必填，指向聚合字段名，须为 DB 真实字段名小驼峰形式），maxLength=64 | "risk_num" |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（V1 OpenAPI 外壳，**字符串非整数**） |
| message | string | 响应消息，成功时为 `"success"` |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| meta | array&lt;object&gt; | 聚合维度元信息（描述每个 aggBy 字段） |
| item | array&lt;object&gt; | 聚合桶列表，每桶由 `aggBy` + `aggFuncs` 共同决定字段 |

> **注意本接口不返回 `data.list` 也不返回 `data.total`**：响应只有 `data.meta` + `data.item`。如需桶数用 `item.length`。

### meta 元素结构说明

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| name | string | 聚合维度字段名（小驼峰） | "assetIp" |
| type | string | 字段类型 | "string" |

### item 元素结构说明

item 元素为动态结构，由 `aggBy` 和 `aggFuncs` 共同决定：

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| {aggBy_0} | string/integer | 第 1 个聚合维度对应的字段值 | 由 aggBy 字段类型决定 | "192.168.1.1" |
| {aggBy_1} | string/integer | 第 2 个聚合维度对应的字段值 | 由 aggBy 字段类型决定 | 3 |
| {aggFuncs[0].name} | integer/number | 第 1 个聚合函数计算结果 | - | 42 |
| {aggFuncs[1].name} | integer/number | 第 2 个聚合函数计算结果 | - | 18 |

## 调用示例

### 示例 1：按资产 IP 聚合漏洞数量

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggBy": ["asset"],
  "aggFuncs": [{"name": "totalCount", "func": "count"}],
  "sort": "totalCount:desc",
  "limit": 10
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [{"name": "asset", "type": "String"}],
    "item": [
      {"asset": "192.168.1.1", "totalCount": 42},
      {"asset": "192.168.1.2", "totalCount": 18},
      {"asset": "10.0.0.5", "totalCount": 7}
    ]
  }
}
```

### 示例 2：按修复优先级聚合，过滤核心资产

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "update_time",
  "filterParam": {
    "magnitude": ["core"],
    "vulnType": ["loophole"]
  },
  "aggBy": ["fixPriorityLevel"],
  "aggFuncs": [{"name": "vulnCount", "func": "count"}],
  "sort": "fixPriorityLevel:desc"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [{"name": "fixPriorityLevel", "type": "Integer"}],
    "item": [
      {"fixPriorityLevel": 3, "vulnCount": 12},
      {"fixPriorityLevel": 2, "vulnCount": 35},
      {"fixPriorityLevel": 1, "vulnCount": 88},
      {"fixPriorityLevel": 0, "vulnCount": 4}
    ]
  }
}
```

### 示例 3：按业务组 + 资产类型二维聚合

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "update_time",
  "filterParam": {
    "fixedStatus": [0, 1]
  },
  "aggBy": ["groupId", "assetType"],
  "aggFuncs": [
    {"name": "totalCount", "func": "count"},
    {"name": "highRiskCount", "func": "sum", "param": "risk_num"}
  ]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [{"name": "groupId", "type": "Integer"}, {"name": "assetType", "type": "Integer"}],
    "item": [
      {"groupId": 201, "assetType": "server", "totalCount": 42, "highRiskCount": 12},
      {"groupId": 201, "assetType": "terminal", "totalCount": 18, "highRiskCount": 3},
      {"groupId": 202, "assetType": "server", "totalCount": 7, "highRiskCount": 2}
    ]
  }
}
```

### 示例 4：按责任人聚合，统计每个人名下资产漏洞数

**请求示例**：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "filterParam": {
    "vulnType": ["loophole", "weak_pwd"]
  },
  "aggBy": ["assetManager"],
  "aggFuncs": [{"name": "totalCount", "func": "count"}],
  "sort": "totalCount:desc",
  "limit": 20
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "meta": [{"name": "assetManager", "type": "string"}],
    "item": [
      {"assetManager": "张三", "totalCount": 156},
      {"assetManager": "李四", "totalCount": 89},
      {"assetManager": "王五", "totalCount": 42}
    ]
  }
}
```

### 示例 5：错误响应 - 缺少必填字段

**请求示例**（缺少 `aggFuncs`）：
```json
{
  "startTimestamp": 1717200000,
  "endTimestamp": 1719800000,
  "timeField": "found_time",
  "aggBy": ["assetIp"]
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

- `aggBy` 至少 1 个字段，每个字段名 maxLength=64，必须为 DB 真实字段名的小驼峰形式（详见上方 aggBy 取值规则表）
- `aggFuncs` 至少 1 个，每个 `name`/`func` maxLength=64
- `limit` 1-100，未传时 DAO 默认 **5**
- `filterParam.limit` 0-100，`filterParam.offset` ≥0——**注意**：DAO 通过 `data.update(data.get('filter_param', {}))` 把 filterParam 平铺到外层后再取 `data.get("limit", 5)`，**filterParam.limit 会覆盖外层 `limit`**（聚合桶数限制），两者语义不同但会冲突
- `startTimestamp` 必须小于 `endTimestamp`，否则聚合结果为空

### 参数依赖关系

- `aggFuncs.param` 在 `func=count` 时可省略，其他 `func`（`sum`/`avg`/`max`/`min`/`addToSet`/`first`/`uniq`）必须提供 `param` 指定字段名；`param` 同样要求是 DB 真实字段名的小驼峰形式
- `filterParam` 内的 `limit`/`offset` 平铺后覆盖外层同名字段（陷阱：filterParam.limit 覆盖聚合桶数 limit）
- `timeField` 决定时间范围过滤的字段，必须与 `startTimestamp`/`endTimestamp` 配套使用；`last_time` 走默认分支生成 `latest_time_range`，与命名暗示不符
- aggBy/aggFuncs.param 含 `asset`/`fixed_status`/`disposal_tag` 数组字段时，`VulnAgg.build_unwind_operation` 自动追加 `$unwind`，每条记录展开成多桶
- aggBy 含 `name` 时，`build_group_operation` 自动按 `name_{lang}`（如 `name_zh`）分组，但 project 输出 key 仍为 `name`

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限
- 无权限时返回 `ACCESS_DENY_RESPONSE`，HTTP 403

### 性能建议

- `aggBy` 字段数量建议 ≤2，超过 2 维会导致分组爆炸
- 时间范围跨度建议 ≤90 天，跨度太大可能导致聚合管道超时
- `filterParam` 应尽量过滤，减少聚合数据量
- 高频查询场景，建议业务侧缓存结果

### 数据一致性说明

- 响应字段为小驼峰命名（由 `snake_to_camel` 转换），与 DB 字段命名（下划线）不同
- 错误码使用 V1_ERROR_MAP 映射（trap #4：`output(v1_open_api=True)` 走 V1_ERROR_MAP 通道，与 `output(open_api=True)` 走 `str(code)` 通道不同）
- 时间字段精度为秒级 Unix 时间戳

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | 缺少必填字段（startTimestamp/endTimestamp/timeField/aggBy/aggFuncs） | 补全必填字段 |
| `"InvalidParameter"` | InvalidParameter | aggBy 元素超过 maxLength=64 | 缩短字段名 |
| `"InvalidParameter"` | InvalidParameter | timeField 不在 `update_time`/`found_time`/`last_time` 枚举内 | 使用合法枚举值 |
| `"InvalidParameter"` | InvalidParameter | aggBy 用了非 DB 字段名（如 `assetIp`/`assetBranchIds`）导致单桶 | 改用 DB 真实字段名（`asset`/`businessId` 等） |
| `"InternalError"` | InternalError | sort 多字段触发 `build_sort_operation` ValueError | sort 仅传单字段 `field:asc\|desc` |
| `"InternalError"` | InternalError | 数据库聚合管道超时 | 缩小时间范围或过滤条件 |
| `"Unknown.SerComError"` | Unknown.SerComError | 系统内部异常 | 联系运维排查 |

> 注：v1_open_api 通道的 `code` 字段是 V1_ERROR_MAP 映射后的**字符串**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno（1001/1103/1104/1235 是内部 errno，不会出现在响应外层）。

## 最佳实践

1. **聚合维度优先级**：优先按 `assetIp`/`assetManager` 等高基数字段聚合，避免按 `id` 等唯一字段聚合（结果退化为 1 条/组）
2. **过滤条件必带**：业务场景下必须传 `filterParam` 缩小范围，否则全量扫描会导致性能问题
3. **sort 配合 limit**：聚合后务必 `sort` + `limit` 取 TopN，避免返回大量结果
4. **timeField 选择**：趋势分析用 `found_time`，活跃度分析用 `last_time`，更新监控用 `update_time`
5. **aggFuncs.param 校验**：使用 `sum`/`avg` 时确认 `param` 字段是数值类型，否则聚合结果为 0
6. **平台过滤**：跨平台查询时显式设置 `platformFilter`（数组对象，每个元素含 `platformId` 必填、`branchIds`/`groupIds` 可选），不传时默认只查当前平台。**`platformId` 必须是租户平台树中真实存在的 ID**，传不存在 ID 会触发 `TypeError: 'NoneType' object is not iterable`
7. **错误码识别**：本接口 `code` 字段是字符串（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），不是整数 errno，调用方需按字符串比较

---
