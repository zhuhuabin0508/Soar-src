# POST /api/xdr/v1/assets/statistics/change/trend

## 接口概述

本接口用于统计指定时间范围内资产变化趋势（新增/出库累计曲线），按时间桶（hour/day）聚合 `Asset` 集合中资产的 `approve_time`（入库时间）与 `out_depot_time`（出库时间）事件，返回每个时间桶的新增累计、出库累计、按机构分组的资产数量趋势。

### 可查询的趋势数据
- **时间桶**：按 `<n>h`（小时）或 `<n>d`（天）间隔划分时间范围
- **机构维度**：返回各机构的资产累计数量曲线（`branchs` 字段）
- **汇总指标**：`addTotal`（期内新增总数）、`outTotal`（期内出库总数）、`totals`（每个时间桶的累计资产总数）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource 类 | `V1ChangeTrend` |
| 所属业务域 | 资产统计 / 资产变化趋势 |
| 接口分类 | 数据查询（时间序列聚合） |
| 前置依赖 | `interval` 必须为 `<n>h` 或 `<n>d` 格式；`beginTime`/`endTime` 实际必填，为毫秒级时间戳 |
| 关联接口 | `POST /api/xdr/v1/assets/statistics/inventory`（清单聚合）、`POST /api/xdr/v1/assets/statistics/branch/tag`（机构标签聚合） |

## 使用场景

1. **资产增长趋势分析**：按小时/天维度查看资产入库趋势，评估资产盘点进度
2. **资产出库趋势分析**：统计指定时间段内的出库资产数量，识别大规模资产变更
3. **按机构分组趋势**：传入 `branchIds` 后查看特定机构的资产变化趋势
4. **运维大盘展示**：用于资产大盘展示资产总量随时间的变化曲线
5. **资产运营报告**：生成日报/周报/月报的资产变化数据

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/assets/statistics/change/trend |
| Content-Type | application/json |
| 权限要求 | 已登录鉴权（`@auth_expr(expression='')` 空表达式，不要求具体策略角色） |

> **注**：对外路径 `/api/xdr/v1/assets/statistics/change/trend` 经 Apisix 网关映射到仓库内部路径 `/apps/asset/api/v1/openapi/assets/statistics/change/trend`（asm.yaml 第 134-147 行，v1 assets wildcard）。源码位于 v1 模块 `open_api/v1/resources/asset/statistics/views.py:41`。

## 业务逻辑

### 核心处理流程

1. **请求参数 schema 校验**：`@v1_open_api_validate(params.WEB_CHANGE_TREND)` 校验请求体，必填 `interval`（字符串，正则 `^[0-9]+[hd]$`），`beginTime`/`endTime`（integer，毫秒级时间戳）、`branchIds`（integer 数组）。校验失败抛 `V1_INVALID_PARAMETER`（HTTP 400）。
   - **注意**：`beginTime`/`endTime` 在 Schema（`statistics/params.py:53-56`）的 `required` 列表中确实未声明，但业务函数 `statistics/business.py:62-63` 裸下标强取这两个键，**实际必填**：不传任一 -> HTTP 200 + code=235 系统繁忙（**非 400**）
2. **登录鉴权 + 上下文注入**：`@auth_expr(expression="")` 校验登录态，`@trans_ctx_pid_query(PlatformMode.SELF)` 注入平台级查询上下文（SELF 模式）。
3. **业务函数 `business.get_asset_change_trend(data)` 调用**（源码 `statistics/business.py:59`）：
   1. **解析 `interval` 参数**：从 `<n>h` 或 `<n>d` 解析出数值与单位。若单位既不是 `h` 也不是 `d`，抛 `FrontendError(ERROR.INVALID_PARAMETER)`（错误码 104，HTTP 200）。
   2. **时间戳规范化**：将 `beginTime`/`endTime` 从毫秒级转为秒级（除以 1000），并按 `interval` 划分时间桶。
   3. **基线资产数量计算**：通过 `AssetDao.coll.aggregate(...)` 聚合管道：
      - `$match`：`approve_time < begin_time` 且 `out_depot_time > begin_time` 或为 null
      - `$group`：按 `branch_id` 分组，统计每组资产数
      - 构造基线 `branch_asset_counts`：每个机构在 `begin_time` 时刻的初始资产数量
   4. **增量事件查询**：调用 `AssetDao.find(filters)` 查询 `Asset` 集合：
      - `approve_time` 或 `out_depot_time` 落在 `[begin, end]` 区间
      - `belong_host == 0`（仅查询主资产，不查网侧资产）
      - 可选过滤 `branch_id $in branchIds`
   5. **时间桶分箱**：遍历查询结果，按 `approve_time`/`out_depot_time` 落入的时间桶累加：
      - `approve_time` 落入桶 → +1（新增）
      - `out_depot_time` 落入桶 → -1（出库）
      - 按机构分组累计，以基线为起点
   6. **统计汇总**：
      - `addTotal`：期内新增总数（`manage_status $in ManageStatus.IN_DEPOT_LIST`）
      - `outTotal`：期内出库总数（`manage_status $in ManageStatus.OUT_DEPOT_LIST`）
   7. **机构名称补全**：调用 `BranchDao.get_id_name_map()` 查询 `Branch` 集合，将 `branch_id` 映射为 `branchName`
   8. **返回**：`{times, totals, branchs: [{branchId, branchName, assetTotals}], addTotal, outTotal}`
4. **响应外壳**：`v1_open_api_output(data=...)` —— OpenAPI 外壳 `{code, message, data}`。

### 数据转换逻辑

- **时间戳单位**：`beginTime`/`endTime` 入参为毫秒级 13 位时间戳，业务层转为秒级 10 位时间戳进行计算
- **`interval` 解析**：`<n>h` 表示按 n 小时为桶宽，`<n>d` 表示按 n 天为桶宽；正则 `^[0-9]+[hd]$` 确保格式正确
- **机构基线**：基线资产数量通过聚合管道查询 `approve_time < begin_time` 且未出库的资产，按机构分组计数

### 默认行为

- `interval` 必填，无默认值
- `beginTime`/`endTime` **实际必填**（Schema 未在 `required` 中声明，但业务层裸下标强取）：不传任一 -> HTTP 200 + code=235 系统繁忙（**非 400**）
- `branchIds` 缺省 → 查询所有机构的资产变化
- 时间桶按 `interval` 划分，桶内时间点为桶起始时间

### 特殊规则

- **`interval` 单位必须是 `h` 或 `d`**：其他单位（如 `m`、`w`、`y`）会触发 `FrontendError(ERROR.INVALID_PARAMETER)`，错误码 104，HTTP 200（注意：与 `V1_INVALID_PARAMETER` 不同，HTTP 状态码为 200，错误码字段为 104）
- **`belong_host == 0` 过滤**：仅查询主资产，不包含网侧资产（belong_host 非零的资产为网侧资产）
- **基线计算**：基线资产数量为 `begin_time` 时刻已入库且未出库的资产，作为后续累计的起点
- **`additionalProperties=false`**：请求体不允许出现 schema 中未声明的字段

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| interval | string | 是 | 无 | 正则 `^[0-9]+[hd]$`，时间桶宽度（如 `1h`=1 小时，`1d`=1 天，`6h`=6 小时，`7d`=7 天） | "1d" |
| beginTime | integer | 是 | 无 | 毫秒级 13 位时间戳，统计起始时间；**实际必填**：Schema 未声明 required，但业务层裸下标强取，不传 -> HTTP 200 + code=235 系统繁忙（非 400） | 1724428800000 |
| endTime | integer | 是 | 无 | 毫秒级 13 位时间戳，统计结束时间；**实际必填**：Schema 未声明 required，但业务层裸下标强取，不传 -> HTTP 200 + code=235 系统繁忙（非 400） | 1724515200000 |
| branchIds | array | 否 | 无 | 元素为 integer，机构 ID 列表；传入后只统计指定机构 | [100, 101] |

#### interval 格式说明

| 格式 | 含义 | 示例 |
|------|------|------|
| `<n>h` | n 小时为桶宽 | `1h`、`6h`、`12h` |
| `<n>d` | n 天为桶宽 | `1d`、`7d`、`30d` |

> 注：`n` 必须为正整数，单位必须为 `h` 或 `d`，其他格式会被 schema 拒绝；运行时单位校验由业务层二次执行，非 `h`/`d` 单位抛 `INVALID_PARAMETER`（错误码 104，HTTP 200）。

## 返回参数

### 响应结构

本接口使用 **OpenAPI 响应外壳 `v1_open_api_output`**，结构如下：

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 错误码，成功时为成功值 |
| message | string | 国际化文案 key，成功时为 `"message.open_api.success.default"` |
| data | object | 资产变化趋势数据，结构见下 |

### data 字段说明

| 字段名 | 类型 | 说明 |
|--------|------|------|
| times | array | 时间桶起始时间戳列表（秒级 10 位），与 `totals`/`branchs[].assetTotals` 一一对应 |
| totals | array | 每个时间桶的资产总数（所有机构累计），与 `times` 一一对应 |
| branchs | array | 按机构分组的趋势数据，元素结构见下 |
| addTotal | integer | 期内新增资产总数（`manage_status $in IN_DEPOT_LIST`） |
| outTotal | integer | 期内出库资产总数（`manage_status $in OUT_DEPOT_LIST`） |

#### branchs 数组元素结构

| 字段名 | 类型 | 说明 |
|--------|------|------|
| branchId | integer | 机构 ID |
| branchName | string | 机构名称（来自 `Branch` 集合 `name` 字段） |
| assetTotals | array | 该机构每个时间桶的资产累计数量，与 `times` 一一对应 |

### 响应示例

```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "times": [1724428800, 1724515200, 1724601600],
    "totals": [1200, 1245, 1230],
    "branchs": [
      {
        "branchId": 100,
        "branchName": "总部",
        "assetTotals": [800, 820, 815]
      },
      {
        "branchId": 101,
        "branchName": "分公司A",
        "assetTotals": [400, 425, 415]
      }
    ],
    "addTotal": 50,
    "outTotal": 20
  }
}
```

## 调用示例

### 示例1：按天统计 7 天资产变化趋势

**请求示例**：
```json
{
  "interval": "1d",
  "beginTime": 1724428800000,
  "endTime": 1725033600000
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "times": [1724428800, 1724515200, 1724601600, 1724688000, 1724774400, 1724860800, 1724947200],
    "totals": [1200, 1245, 1230, 1280, 1290, 1310, 1325],
    "branchs": [
      {"branchId": 100, "branchName": "总部", "assetTotals": [800, 820, 815, 850, 860, 870, 880]}
    ],
    "addTotal": 130,
    "outTotal": 25
  }
}
```

### 示例2：按机构过滤按小时统计

**请求示例**：
```json
{
  "interval": "6h",
  "beginTime": 1724428800000,
  "endTime": 1724486400000,
  "branchIds": [100, 101]
}
```

**响应示例**：
```json
{
  "code": "<成功码>",
  "message": "message.open_api.success.default",
  "data": {
    "times": [1724428800, 1724450400, 1724472000],
    "totals": [800, 815, 825],
    "branchs": [
      {"branchId": 100, "branchName": "总部", "assetTotals": [500, 510, 515]},
      {"branchId": 101, "branchName": "分公司A", "assetTotals": [300, 305, 310]}
    ],
    "addTotal": 30,
    "outTotal": 5
  }
}
```

### 示例3：错误示例——interval 格式非法

**请求示例**（`interval="1w"` 不匹配正则）：
```json
{
  "interval": "1w"
}
```

**错误响应示例**（HTTP 400，schema 校验失败）：
```json
{
  "code": "V1_INVALID_PARAMETER",
  "message": "<schema 校验错误信息，如 'interval: pattern mismatch'>",
  "data": null
}
```

### 示例4：错误示例——interval 单位不支持（运行时校验）

**请求示例**（`interval="1m"` 通过 schema 正则但单位非 h/d）：

> 注：正则 `^[0-9]+[hd]$` 限制单位只能是 h 或 d，`1m` 实际无法通过 schema 校验。若绕过 schema 强制传入，业务层会抛 `INVALID_PARAMETER`（错误码 104，HTTP 200）：

```json
{
  "code": "INVALID_PARAMETER",
  "message": "<参数错误信息>",
  "data": null
}
```

## 注意事项与限制

### 参数限制

- `interval` 必填，必须匹配正则 `^[0-9]+[hd]$`，数值部分为正整数，单位为 `h` 或 `d`
- `beginTime`/`endTime` **实际必填**，必须为 integer 类型，毫秒级时间戳；不传任一 -> HTTP 200 + code=235 系统繁忙（**非 400**）
- `branchIds` 元素必须为 integer 类型
- `additionalProperties=false`，请求体不允许出现 schema 中未声明的字段

### 参数依赖关系

- `beginTime` 与 `endTime` 必须成对传入（两者均为**实际必填**），且 `beginTime <= endTime`；不传任一 -> HTTP 200 + code=235 系统繁忙（**非 400**），不存在业务层默认时间范围
- `interval` 决定时间桶宽度，桶数量 = `(endTime - beginTime) / interval`，过大区间+小桶宽会产生大量桶
- `branchIds` 可选，传入后只统计指定机构的资产变化

### 权限要求

- `@auth_expr(expression='')` 空表达式，**不要求具体策略角色**，仅需登录鉴权通过
- 鉴权失败返回 `ACCESS_DENY_RESPONSE`
- `@trans_ctx_pid_query(PlatformMode.SELF)` 限制查询为本平台数据

### 性能建议

- 大时间范围 + 小桶宽会产生大量时间桶，建议按统计粒度合理设置：日报用 `1d`，小时报用 `1h` 或 `6h`
- `branchIds` 传入可缩小查询范围，减少聚合管道数据量
- 基线计算（`approve_time < begin_time`）在资产数量大时较慢，建议 `beginTime` 不要太早

### 数据一致性说明

- **`times` 时间戳单位**：返回的 `times` 为秒级 10 位时间戳（与入参 `beginTime`/`endTime` 毫秒级不同）
- **`totals` 累计含义**：每个桶的资产总数为基线 + 期内累计变化，不是新增数
- **`addTotal`/`outTotal`**：分别是期内 `IN_DEPOT_LIST` 状态新增数与 `OUT_DEPOT_LIST` 状态出库数
- **`belong_host == 0` 过滤**：仅统计主资产，不包含网侧资产
- **基线资产**：`approve_time < begin_time` 且 `out_depot_time > begin_time` 或为 null 的资产

## 常见错误

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|----------|------|----------|
| V1_INVALID_PARAMETER (HTTP 400, code=1104) | schema 校验错误信息（如 `interval: required`、`interval: pattern mismatch`、`beginTime: must be integer`） | 请求体不符合 JSON Schema 约束 | 按错误信息修正请求体字段 |
| INVALID_PARAMETER (HTTP 200, code=104) | 参数错误 | `interval` 单位非 `h`/`d`（运行时业务层校验） | 使用 `h` 或 `d` 作为单位 |
| V1_UNKNOWN (HTTP 400, code=1103) | 系统错误 | 业务层异常 | 联系运维检查服务状态 |
| SYSTEM_BUSY (HTTP 200, code=235) | 系统繁忙 | 未传 `beginTime` 或 `endTime`，业务层裸下标强取触发 KeyError（Schema 未标 required，但实际必填） | 补传 `beginTime`/`endTime`（毫秒级 integer）；注意此错误 HTTP 状态码为 **200**，须通过 `code=235` 识别 |
| V1_SYSTEM_ERROR (HTTP 500, code=1235) | 系统错误 | MongoDB 聚合管道异常或 `Branch` 集合查询失败 | 联系运维检查 MongoDB 连接 |

## 最佳实践

1. **`interval` 按统计粒度选择**：日报用 `1d`，小时报用 `1h` 或 `6h`，避免过细粒度产生大量空桶
2. **`beginTime`/`endTime` 必须成对传入**：两者均为实际必填，不传 -> HTTP 200 + code=235 系统繁忙；不存在业务层默认值可依赖
3. **`branchIds` 缩小范围**：机构较多时传入 `branchIds` 提升查询性能
4. **响应 `totals` 是累计值**：不是新增数，调用方应理解为资产总量随时间的变化
5. **`times` 是秒级时间戳**：与入参毫秒级不同，前端展示需 *1000 转毫秒
6. **响应外壳判断**：本接口使用 `v1_open_api_output`，通过 `code` 字段判断成功，`data` 字段含趋势数据
