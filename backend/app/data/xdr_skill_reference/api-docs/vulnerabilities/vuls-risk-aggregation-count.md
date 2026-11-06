# POST /api/xdr/v1/vuls/risk/aggregation/count

## 接口概述

本接口用于按**资产组**（branch）聚合统计漏洞、弱密码数量，并自动归并子资产组计数到祖先资产组。通过本接口，您可以获取以下内容：

### 可查询的脆弱性聚合信息
- **聚合维度**：按资产组（`branch_id`）+ 平台（`platform_id`）二维分组，每桶返回该资产组的漏洞/弱密码计数及风险数
- **聚合指标**：`vulnCount`（脆弱性记录条数）、`count`/`riskCount`（风险数 = `count` 字段累加）、`count` 字段同时包含子资产组归并值
- **过滤条件**：资产组（`assetBranchIds`，**自动展开到子树**）、业务组（`assetGroupIds`，**自动展开到子树**）、修复优先级、风险等级、处置状态、脆弱性类型、时间范围、平台

> **关键澄清（来自源码 `query_builder.py:AssetQueryBuilder.build_branch_and_group_query`）**：
> - **`assetBranchIds` = 资产组 ID 列表**（对应内部 `branch_ids` → Mongo `business_id`），**不是业务组**
> - **`assetGroupIds` = 业务组 ID 列表**（对应内部 `group_ids` → Mongo `group_id`），**不是资产组**
> - 字段命名容易望文生义，调用方必须严格按上述对应关系传参，否则过滤结果错误

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `RiskAggCount` |
| 视图文件 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:172`（注册于 `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:23` → `/vuls/risk/aggregation/count`，POST） |
| 业务函数 | `soar/apps/vuln_web/app/view/vuln/risk/views.py:185` → `get_risk_agg_count(data)`（`view/vuln/risk/business.py:364`）→ `MyVulRiskMiddle.risk_agg_count_by_branch` + `BranchModel.get_branch_tree/get_branch_asset_count/get_platform_business_names/get_branch_full_name` |
| 请求 Schema | `soar/apps/vuln_web/app/view/vuln/risk/params.py:207` → `RISK_AGG_COUNT_SCHEMA`（与 aggregation/attackType 共用同一常量） |
| 版本归属 | v2（外部路径 `/api/xdr/v1/vuls/risk/aggregation/count` 经 etcd 具体路由 `openapi_asm_vuls_risk_aggregation_count_v1` 转后端 `/order/v2/openapi/vuls/risk/aggregation/count`，upstream `vuln-web:7100`） |
| 所属业务域 | 脆弱性管理 - **风险视角**聚合 |
| 数据源表 | `vul_risk_middle`（**风险视角中间表**，按 `md5_name_asset` 去重的漏洞-资产关联记录） |
| 接口分类 | 聚合统计 |
| 前置依赖 | 无（可直接调用） |
| 关联接口 | `/api/xdr/v1/vuls/risk/aggregation/attackType`、`/api/xdr/v1/vuls/risk/aggregation/loopholeLevel`、`/api/xdr/v1/vuls/risk/aggregation/baselineLevel` |

> **风险视角 vs 资产视角（关键区分）**：本接口属于**风险视角**，数据源是 `vul_risk_middle` 表，与前端"漏洞风险列表"页面一致。**资产视角**接口（如 `POST /api/xdr/v1/vuls/asset/stats`、`POST /api/xdr/v1/vuls/asset/list`）数据源是 `host_vul_middle` 表，与前端"资产漏洞列表"页面一致。两个视角数据同步存在时差、字段映射差异，统计同一需求可能得到不同结果（实测同一筛选条件下风险视角 16 条 vs 资产视角 6 条）。**需求中出现"漏洞风险列表/漏洞风险数量"时，应选本接口或 `POST /api/xdr/v1/risk/list`（均为风险视角），不要选资产视角接口**。

## 使用场景

1. **资产组聚合统计**：传入一个或多个资产组 ID，获取每个资产组（含其全部子资产组归并）的漏洞/弱密码数量
2. **TopN 分析**：配合 `sort` + `limit` 取弱密码/漏洞数最多的 N 个资产组
3. **跨平台聚合**：传 `platform_ids` 跨平台聚合，每桶带 `platformId`
4. **多维分析**：与 attackType/loopholeLevel/baselineLevel 配合，从不同维度交叉分析

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/vuls/risk/aggregation/count` |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin") \|\| hasPolicies("riskManageQuery")` |

## 业务逻辑

### 核心处理流程

1. **请求校验**：通过 `@frontend_validate(params.RISK_AGG_COUNT_SCHEMA, open_api=True)` 执行 JSON Schema 校验
2. **权限校验**：`@auth_expr` 装饰器校验权限
3. **OpenAPI 参数转换**：调用 `transform_openapi_params(data, need_default_time_range=False)` 转换参数
   - `assetBranchIds` → `branchIds` → `branch_ids`
   - `assetGroupIds` → `groupIds` → `group_ids`
   - `startTimestamp`/`endTimestamp` + `timeField` → 对应的 `*_time_range` 列表
4. **聚合查询**：调用 `MyVulRiskMiddle.risk_agg_count_by_branch(data)`，按 `business_id`（资产组 ID）+ `platform_id` 分组，得到每个资产组的 `vuln_count`（记录条数）和 `risk_count`（`count` 字段累加）
5. **子树归并**：调用 `BranchModel.get_branch_asset_count`，将子资产组的 `vuln_count`/`risk_count` 递归累加到祖先资产组，使每条资产组返回的计数包含其全部后代资产组的贡献
6. **资产组名解析**：通过 `BranchModel.get_platform_business_names` / `get_branch_full_name` 实时获取资产组名（中间表 `business_name` 可能未同步）
7. **结果过滤**：用 `branch_ids`（来自 `assetBranchIds`）对最终列表做交集过滤，**只返回入参明确指定的资产组**（子资产组的计数已归并到祖先，但不会作为独立桶返回）
8. **排序与截断**：按 `sort` 排序（默认 `count:desc,branch_id:asc`），再按 `limit` 截断
9. **响应转换**：通过 `snake_to_camel(result)` 转回小驼峰
10. **响应封装**：调用 `output(data=tr_result, v1_open_api=True)` 走 V1 OpenAPI 错误码映射通道

### 子树自动展开（核心规则）

`AssetQueryBuilder.build_branch_and_group_query` 对每个传入的 `branch_id` 调用 `BranchModel.get_branch_ids_by_parent_id(bid, BranchType.BRANCH)`，得到 **该资产组本身 + 全部后代资产组 ID**，再用 `business_id $in [self + descendants]` 做过滤。

- **调用方无需自己递归收集子资产组 branchId**：直接传父资产组 ID，服务端自动展开到整棵子树
- **计数归并方向相反**：聚合是按"叶子到根"展开查询，但**返回时**祖先资产组的 `count`/`vulnCount`/`riskCount` 包含其全部后代资产组的累加值
- **返回桶列表只包含入参 `assetBranchIds` 中显式列出的资产组**：后代资产组不作为独立桶出现（其计数已并入祖先桶）

> 例：资产组树 `A → {D → F, E}`，传 `assetBranchIds=[A]`：
> - 服务端展开为 `[A, D, E, F]` 做 Mongo 过滤
> - 返回列表只有 1 个桶：`{branchId: A, count: <A+D+E+F 累加>}`
> - 若传 `assetBranchIds=[A, D]`，返回 2 个桶：`{A: A+D+E+F 累加}, {D: D+F 累加}`

### 默认行为

- 不传 `startTimestamp`/`endTimestamp` 时不自动填充默认时间（`need_default_time_range=False`）
- 不传 `dataType` 时查询所有类型（漏洞 + 弱密码）
- `sort` 未传时默认 `count:desc,branch_id:asc`
- `limit` 未传时返回全部过滤后的桶
- `assetBranchIds`/`assetGroupIds` 未传或包含 `-1`/`None` 时，不做该维度过滤（视为"全部"）

### 特殊规则

- `fixedStatus` 字段在 schema 中存在但**不展示在 OpenAPI 文档**（schema 注释明确说明）
- `limit` 字段最小值为 0，与通用 LIMIT 不同（通用 LIMIT 为 0-100）
- `platform_ids` 接受字符串数组（平台 ID 是字符串），不是整数数组
- `platformFilter` 是对象数组（每个元素含 `branchIds`/`platformId`/`groupIds`），不是 boolean

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| assetBranchIds | array&lt;integer&gt; | 否 | - | **资产组 ID 列表**（对应内部 `branch_ids` → Mongo `business_id`）。每个 ID 自动展开为"自身 + 全部后代资产组"做过滤；返回桶列表只包含此参数显式列出的资产组 | [1, 11] |
| assetGroupIds | array&lt;integer&gt; | 否 | - | **业务组 ID 列表**（对应内部 `group_ids` → Mongo `group_id`）。每个 ID 自动展开为"自身 + 全部后代业务组"做过滤 | [101, 102] |
| platform_ids | array&lt;string&gt; | 否 | - | 平台 ID 列表（字符串数组，可传 `"all"` 表示全部平台） | ["all"] |
| riskLevels | array&lt;integer&gt; | 否 | - | 风险等级，参考 enum-dictionary-python.md。0/低, 1/中, 2/高, 3/严重 | [2, 3] |
| fixedStatus | array&lt;integer&gt; | 否 | - | 处置状态（**不上 OpenAPI 文档**），参考 enum-dictionary-python.md。0/待处置, 1/处置中, 2/已修复, 3/已接受, 4/已忽略, 5/误报, 6/改善, 7/加白, 100/处置完成 | [0, 1] |
| fixPriority | array&lt;integer&gt; | 否 | - | 修复优先级，参考 enum-dictionary-python.md。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| limit | integer | 否 | 全部 | ≥ 0，返回结果上限 | 10 |
| startTimestamp | integer | 否 | - | ≥ 0 的 Unix 时间戳（秒）。与 `endTimestamp` 必须同时传或同时不传 | 1787760000 |
| endTimestamp | integer | 否 | - | ≥ 0 的 Unix 时间戳（秒）。与 `startTimestamp` 必须同时传或同时不传 | 1788364800 |
| timeField | string | 否 | - | 时间字段，参考 enum-dictionary-python.md。`update_time`/更新时间, `found_time`/发现时间, `last_time`/最近时间 | "found_time" |
| dataType | string | 否 | 全部 | 脆弱性类型，参考 enum-dictionary-python.md。`loophole`/漏洞, `weak_pwd`/弱密码 | "weak_pwd" |
| sort | string | 否 | `count:desc,branch_id:asc` | 排序表达式，正则 `^(\w+(:asc\|:desc)?)(,\w+(:asc\|:desc)?){0,4}$`。**可用排序字段：`count`/`riskCount`/`vulnCount`/`branchId`/`branchName`/`branchFullName`/`platformId`**（实际后端会 `camelcase_to_underscore` 转换）。注意：`totalCount` 不存在 | "count:desc" |
| platformFilter | array&lt;object&gt; | 否 | - | 平台过滤，每元素含 `branchIds`（资产组 ID 数组）/ `groupIds`（业务组 ID 数组）/ `platformId`（字符串，必填）。**`platformId` 必须是当前租户平台树中真实存在的 ID——传不存在的 platformId 会触发 `TypeError: 'NoneType' object is not iterable`** | [{"platformId": "P1", "branchIds": [101]}] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为 `"Success"`（V1 OpenAPI 外壳 `v1_open_api_output`，**字符串非整数**） |
| message | string | 国际化文案 key，成功时为 `"success"` |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array&lt;object&gt; | 聚合结果桶列表，每桶对应 `assetBranchIds` 中显式列出的一个资产组 |

> **注意**：本接口返回 `data.item`，**不返回 `data.list`，也不返回 `data.total`**。如果调用方需要总桶数，请用 `data.item.length`；需要弱密码总数请客户端累加各桶 `count`/`vulnCount`。

### item 元素结构说明

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| branchId | integer | 资产组 ID（对应入参 `assetBranchIds` 中的某个 ID） | - | 11 |
| platformId | string | 平台 ID | - | "platform_001" |
| branchName | string | 资产组名称（实时查询 `BranchModel.get_platform_business_names`，未归类组返回"未归类"） | - | "服务器区" |
| branchFullName | string | 资产组全路径名（如 "管理IP范围/服务器区"），通过 `get_branch_full_name` 拼接，未匹配时返回空字符串 | - | "管理IP范围/服务器区" |
| count | integer | 风险数（= `riskCount`），含子资产组归并值。`dataType=weak_pwd` 时表示弱密码风险数；`dataType=loophole` 时表示漏洞风险数 | - | 42 |
| riskCount | integer | 风险数，与 `count` 完全相同（保留两个字段为兼容旧调用方） | - | 42 |
| vulnCount | integer | 脆弱性记录条数（每条记录计 1，不累加 `count` 字段），含子资产组归并值 | - | 38 |

> **`count` 与 `vulnCount` 的区别**：Mongo 中间表 `vul_risk_middle` 每条记录有 `count` 字段表示该脆弱性在资产上的发生次数。`vulnCount` 是"记录条数"（`$sum: 1`），`count`/`riskCount` 是"发生次数累加"（`$sum: $count`）。
>
> **实测结论（修正早期文档错误）**：早期文档称"对漏洞 `dataType=loophole` 一般每条 `count=1`，二者相等"——**该描述不准确**。实测同一环境、同一时间窗口、`dataType=loophole`：某根资产组桶 `vulnCount=10`（10 条记录），`count=14`（10 条记录的 `count` 字段累加 = 14），说明**该 10 条记录中有 4 条 `count>1`**（同一漏洞在多次扫描或多个资产上重复命中累加）。`vulnCount` 与 `count` 在 `loophole` 类型下**也可能不相等**，调用方拿"漏洞风险总数"时必须明确口径：
> - **记录条数口径**（与"漏洞风险列表"页面显示一致）→ 取 `vulnCount` 累加 = 12
> - **发生次数累加口径**（计算的总数，含重复命中）→ 取 `count` 累加 = 16
>
> 两个口径都合法，具体取哪个由业务需求决定，不可混用。

## 调用示例

### 示例 1：按资产组聚合弱密码数量（子树自动展开）

**需求**：查询"管理IP范围"资产组下、近 7 天新发现的各资产组弱密码数量。

**前置步骤**：先调 `POST /api/xdr/v1/branches/list` 用 `search="管理IP范围"` 查到 `branchId`（如 `branchId=1`）。

**请求示例**：
```json
{
  "startTimestamp": 1787760000,
  "endTimestamp": 1788364800,
  "timeField": "found_time",
  "dataType": "weak_pwd",
  "assetBranchIds": [1],
  "sort": "count:desc",
  "limit": 10
}
```

> **无需递归收集子资产组 branchId**：服务端自动展开 `[1]` 到 `[1, 11, 12, 121, ...]` 整棵子树做过滤。但返回桶列表只包含 `branchId=1` 这一个桶（其 `count`/`vulnCount` 已包含全部后代的归并值）。如需每个子资产组独立计数，必须显式传入所有子资产组 ID。

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "branchId": 1,
        "platformId": "platform_001",
        "branchName": "管理IP范围",
        "branchFullName": "管理IP范围",
        "count": 70,
        "riskCount": 70,
        "vulnCount": 65
      }
    ]
  }
}
```

### 示例 2：传入多个子资产组 ID，分别获取每个子组的弱密码数

**请求示例**：
```json
{
  "startTimestamp": 1787760000,
  "endTimestamp": 1788364800,
  "timeField": "found_time",
  "dataType": "weak_pwd",
  "assetBranchIds": [11, 12, 121],
  "sort": "count:desc",
  "limit": 10
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"branchId": 11, "platformId": "platform_001", "branchName": "服务器区", "branchFullName": "管理IP范围/服务器区", "count": 42, "riskCount": 42, "vulnCount": 40},
      {"branchId": 12, "platformId": "platform_001", "branchName": "终端区", "branchFullName": "管理IP范围/终端区", "count": 18, "riskCount": 18, "vulnCount": 17},
      {"branchId": 121, "platformId": "platform_001", "branchName": "研发终端", "branchFullName": "管理IP范围/终端区/研发终端", "count": 7, "riskCount": 7, "vulnCount": 7}
    ]
  }
}
```

### 示例 3：按业务组过滤聚合漏洞数量

**请求示例**：
```json
{
  "startTimestamp": 1787760000,
  "endTimestamp": 1788364800,
  "timeField": "update_time",
  "dataType": "loophole",
  "assetGroupIds": [1000001],
  "riskLevels": [2, 3],
  "sort": "count:desc"
}
```

> `assetGroupIds` 是**业务组** ID 列表，服务端自动展开 `[1000001]` 到 `[1000001, ...]` 整棵业务组子树做过滤。返回桶仍按**资产组**分组（接口本身按资产组聚合，不按业务组分桶），即"业务组 1000001 子树下涉及的各资产组的漏洞数"。

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"branchId": 5, "platformId": "platform_001", "branchName": "资产组a", "branchFullName": "资产组a", "count": 7, "riskCount": 7, "vulnCount": 7},
      {"branchId": 6, "platformId": "platform_001", "branchName": "资产组b", "branchFullName": "资产组b", "count": 5, "riskCount": 5, "vulnCount": 2}
    ]
  }
}
```

### 示例 4：空参数调用，返回全量资产组聚合

**请求示例**：
```json
{}
```

**响应示例**（结构示意，`branchId`/`branchName`/`count` 等具体值由当前租户的资产组配置决定）：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {
        "branchFullName": "<某根资产组全路径名>",
        "branchId": <某根资产组ID>,
        "branchName": "<某根资产组名>",
        "count": <该资产组的风险数，含子树归并>,
        "platformId": "<平台ID>",
        "riskCount": <与count相同>,
        "vulnCount": <该资产组的记录条数>
      },
      {
        "branchFullName": "未归类组",
        "branchId": 0,
        "branchName": "未归类组",
        "count": <未归类资产的风险数>,
        "platformId": "<平台ID>",
        "riskCount": <与count相同>,
        "vulnCount": <未归类资产的记录条数>
      }
    ]
  }
}
```

> **实测结论（修正早期文档错误）**：不传 `assetBranchIds` 时**不再返回 `item: []`**，而是返回全量资产组桶，通常包含：
> - 各根资产组（每个根资产组一桶，含其全部子树归并值）
> - `branchId=0` "未归类组"（不属于任何资产组的资产）
>
> **`branchId` 与 `branchName` 的具体值由当前租户的资产组配置决定**，没有固定映射关系——某租户的某个 `branchId` 可能对应"管理IP范围"，另一租户可能是别的名字或根本不存在。调用方不应假设某个 `branchId` 对应固定名称，需要通过 `branchName`/`branchFullName` 字段确认桶的实际归属。
>
> 调用方查询全量漏洞风险总数时，**无需传 `assetBranchIds`**，直接累加 `data.item[].count`（发生次数累加口径）或 `data.item[].vulnCount`（记录条数口径）即可。早期文档"不传返回空，必须传 `assetBranchIds`"的描述与实测不符，已修订。

### 示例 5：错误响应 - timeField 不在枚举内

**请求示例**：
```json
{
  "timeField": "create_time",
  "dataType": "loophole"
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

> V1 OpenAPI 外壳的 `code` 是字符串：成功为 `"Success"`，失败为错误码字符串（如 `"InvalidParameter"`）。

## 注意事项与限制

### 参数限制

- `limit` 最小值 0（与通用 LIMIT 0-100 不同），无明确上限但性能建议 ≤ 1000
- `dataType` 仅支持 `loophole`/`weak_pwd`，不支持 `baseline`（基线请用 `/api/xdr/v1/vuls/risk/aggregation/baselineLevel`）
- 所有字段均可选；**不传 `assetBranchIds` 时返回全量资产组桶**（各根资产组 + `branchId=0` 未归类组），**不再返回 `item: []`**——早期文档"不传返回空"的描述与实测不符，已修订（详见示例 4）

### 参数依赖关系

- `startTimestamp` 和 `endTimestamp` 必须同时传或同时不传
- `timeField` 与时间范围配套使用
- `assetBranchIds`/`assetGroupIds` 中传入 `-1` 或 `None` 时视为"全部"，不做该维度过滤
- `platformFilter` 中每个元素必须包含 `platformId`（schema required）

### 子树展开规则

- `assetBranchIds` 中每个 ID 自动展开为"自身 + 全部后代资产组"
- `assetGroupIds` 中每个 ID 自动展开为"自身 + 全部后代业务组"
- **调用方无需自己递归收集子资产组/业务组 ID**，直接传父节点 ID 即可
- **返回桶列表只包含 `assetBranchIds` 显式列出的资产组**，子资产组的计数已归并到祖先桶

### 权限要求

- 必须拥有 `superAdmin` 或 `riskManageQuery` 权限

### 性能建议

- `limit` ≤ 1000，超过会触发 MongoDB 内存限制
- 时间范围跨度建议 ≤ 90 天
- `fixPriority`/`riskLevels`/`assetBranchIds` 过滤可大幅减少聚合数据量

### 数据一致性说明

- 响应字段为小驼峰命名（`snake_to_camel` 转换）
- 错误码使用 V1_ERROR_MAP 映射，`code` 为字符串（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`）
- `fixedStatus` 不展示在 OpenAPI 文档（schema 注释说明）
- 资产组名实时查询 `BranchModel`，中间表 `business_name` 可能未同步更新

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| `"InvalidParameter"` | InvalidParameter | timeField 不在枚举内 | 使用 `update_time`/`found_time`/`last_time` |
| `"InvalidParameter"` | InvalidParameter | dataType 不在枚举内 | 使用 `loophole`/`weak_pwd` |
| `"InvalidParameter"` | InvalidParameter | sort 字段名不存在（如误用 `totalCount`） | 使用 `count`/`riskCount`/`vulnCount`/`branchId`/`branchName`/`branchFullName`/`platformId` |
| `"Unknown.SerComError"` | Unknown.SerComError | 数据库聚合超时 | 缩小时间范围、减小 `assetBranchIds` 子树规模 |
| `"InternalError"` | InternalError | 系统内部异常 | 联系运维排查 |
| Access Denied | - | 无 `superAdmin`/`riskManageQuery` 权限 | 联系管理员授权 |

## 最佳实践

1. **`assetBranchIds` vs `assetGroupIds` 不要混用**：`assetBranchIds` 是资产组、`assetGroupIds` 是业务组。望文生义会传错。
2. **传父资产组 ID 即可拿整棵子树聚合**：不需要客户端递归收集后代 branchId。但若需每个子资产组作为独立桶返回，必须显式列出所有子资产组 ID。
3. **dataType 选择**：漏洞用 `loophole`，弱密码用 `weak_pwd`，基线用 baselineLevel 接口
4. **limit 合理设置**：业务看板建议 10-20，详细分析建议 100，最大不超过 1000
5. **sort 字段名**：用 `count`/`riskCount`/`vulnCount`/`branchId`，**不要用 `totalCount`**（不存在）
6. **平台过滤**：跨平台查询传 `platform_ids: ["all"]`，单平台传具体 platformId 字符串
7. **timeField 选择**：按业务场景选择时间字段，"近 N 天新发现"用 `found_time`，"近 N 天最近更新"用 `update_time`/`last_time`
8. **弱密码总数**：`count`/`riskCount` 是弱密码风险数累加，`vulnCount` 是记录条数。若需"弱密码总数"通常取 `count` 或客户端累加各桶 `count`。

---

## 源码证据

| 事实 | 证据位置 |
|------|---------|
| 路由 `/vuls/risk/aggregation/count` → `RiskAggCount` | `soar/apps/vuln_web/app/view/vuln/risk/openapi_v2.py:23` |
| 视图类 `RiskAggCount.post` | `soar/apps/vuln_web/app/view/vuln/risk/views.py:172-190` |
| Schema `RISK_AGG_COUNT_SCHEMA`：`assetGroupIds=GROUP_IDS`、`assetBranchIds=BRANCH_IDS` | `soar/apps/vuln_web/app/view/vuln/risk/params.py:207-230` |
| `BRANCH_IDS` → `Param.Common.BranchId`（资产组）；`GROUP_IDS` → `Param.Common.GroupIds`（业务组） | `soar/apps/vuln_web/app/common/params.py:512-529` |
| OpenAPI 参数转换：`assetBranchIds` → `branchIds` → `branch_ids`；`assetGroupIds` → `groupIds` → `group_ids` | `soar/apps/vuln_web/app/common/openapi/transform.py:46-51` |
| 业务函数 `get_risk_agg_count`：返回 `{"item": branch_list}`，每桶 `branch_id/platform_id/branch_name/branch_full_name/count/risk_count/vuln_count` | `soar/apps/vuln_web/app/view/vuln/risk/business.py:364-418` |
| 聚合分组按 `business_id`（资产组 ID）+ `platform_id`，`vuln_count=$sum:1`、`risk_count=$sum:$count` | `soar/apps/vuln_web/app/models/soar_db/vul_risk_middle.py:514-553` |
| 子树归并 `BranchModel.get_branch_asset_count` 递归累加后代计数到祖先 | `soar/apps/vuln_common/model/ts_db/branch.py:304-342` |
| `branch_ids` 自动展开为"自身 + 全部后代"做 Mongo `business_id $in` 过滤 | `soar/apps/vuln_common/model/query_builder.py:233-264` |
| `MyVulRiskMiddleQuery.generate_query` 调用 `build_branch_and_group_query` 等 | `soar/apps/vuln_common/model/query_builder.py:1501-1514` |
| 测试用例期望 `{"code": "Success", "data": {"item": [{"branchId", "branchName", "branchFullName", "count", "riskCount", "vulnCount", "platformId"}]}}` | `testcases/mss/external_api/openapi/test_openapi_vuls_agg_count.py:85-110, 155-204` |
| 测试数据注释 `"business_id": branch_id,  # 资产组ID assetBranchIds`、`"group_id": 1000001,  # 业务组ID assetGroupIds` | `testcases/mss/external_api/openapi/test_openapi_vuls_agg_count.py:46-48` |
| V1 OpenAPI 外壳 `code` 为字符串 `"Success"`（非 1001） | `testcases/mss/external_api/openapi/test_openapi_vuls_agg_count.py:85, 102, 156-157` |
