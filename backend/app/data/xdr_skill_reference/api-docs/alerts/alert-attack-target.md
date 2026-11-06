# POST /api/xdr/v1/alerts/attack/target

## 接口概述

本接口用于查询受攻击资产概览（攻击大屏专用），按受攻击资产维度聚合统计告警数 Top N，支持按访问方向、资产组、源国家、源省份、平台 ID 过滤，并支持排除特定源国家的告警。返回的资产信息含资产组 ID/IP/资产 ID/资产组名/被攻击 IP/攻击者 IP/告警次数/地域信息，并自动映射资产组名称。通过本接口，您可以获取以下内容：

### 可查询的受攻击资产维度
- **时间范围**：startTimestamp/endTimestamp（秒级 Long）
- **访问方向**：directions（1-内对外 / 2-外对内 / 3-内对内，最多 10 个）
- **资产组范围**：branchIds（最多 2000 个）
- **源国家过滤**：srcCountryNames（最多 10 个）
- **源省份过滤**：srcProvinceName（最多 10 个）
- **平台 ID**：platformIds（必传，最多 40 个）
- **排除参数**：excludeParam.srcCountryNames（排除特定源国家）

### 返回的受攻击资产信息
- **资产标识**：hostAssetId（资产 ID）、hostIp（资产 IP）
- **资产组信息**：hostBranchId（资产组 ID）、hostBranchName（资产组名，自动从缓存映射）
- **攻击信息**：srcIp（攻击者 IP）、dstIps（被攻击 IP 列表）、alertCount（告警次数）、area（地域信息）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口（攻击大屏专用） |
| 接口分类 | 攻击大屏 - 受攻击资产概览 |
| 前置依赖 | 需先获取资产组 ID（branchIds）和平台 ID |
| 关联接口 | `/api/xdr/v1/alerts/attack/sources` 攻击源资产概览、`/api/xdr/v1/alerts/attack/area` 攻击区域展示、`/api/xdr/v1/alerts/attack/link` 攻击区域连线 |

## 使用场景

1. **攻击大屏受攻击资产 Top N 展示**：按受攻击资产聚合统计告警数，展示 Top N 受攻击资产
2. **方向过滤分析**：按 directions 过滤内对外/外对内/内对内方向的受攻击资产
3. **资产组范围限定**：通过 branchIds 限定查询的资产组范围
4. **源国家/省份过滤**：通过 srcCountryNames/srcProvinceName 限定攻击源的国家和省份
5. **排除特定源国家**：通过 excludeParam.srcCountryNames 排除特定源国家的告警
6. **配合攻击源概览**：与 `/attack/sources` 接口组合展示攻击大屏的攻击源和受攻击资产全貌
7. **配合攻击区域展示/连线**：与 `/attack/area`、`/attack/link` 接口组合展示完整的攻击大屏

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/attack/target |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Validated + Service 层）：
   - Controller 触发 QO 字段校验（@NotNull/@Min/@Max/@Size/@Pattern/@Valid）
   - QO 通过 `convertAttackBranchQo()` 转换为内部 `AttackBranchQo`，保留 startTime、endTime、direction（映射为 directions）、branchIds、topNum（映射为 limit）、platformIds、srcCountryNames、srcProvinceName、excludeParam
   - Service `attackedFieldValidation` 校验：
     - `startTime > endTime` 时抛 `exception.attack.screen.time.negative`
     - 时间范围 > 180 天抛 `exception.attack.screen.time.exceed`
     - `directions` 中元素必须是 AttackDirectionEnum 的有效值（0/1/2/3），否则抛 `exception.attack.screen.time.direction.not.enum`
2. **查询资产组名称映射**：调用 `branchNameCache.getBranchIdToNameMap()` 获取 branchId → branchName 的映射缓存
3. **查询 ES**：调用 `alertDao.alertCountByBranchIds(qo)`，按受攻击资产聚合统计告警数 Top N，过滤条件含 direction、branchIds、srcCountryNames、srcProvinceName、platformIds、时间范围、excludeParam
4. **资产组名称映射**：遍历返回的 `attackAssetTop` 列表，对每个 `AttackAssetInfo`：
   - 将 `hostBranchId`（String）解析为 Integer
   - 从 `branchIdToNameMap` 取对应 branchName，找不到时默认空字符串
   - 回填到 `hostBranchName` 字段
5. **结果封装**：返回 `BigScreenAttackedAssetVo`，含 item 列表

### 数据转换逻辑

- ES 聚合按受攻击资产分桶 → AttackAssetInfo 各字段
- branchId（String）→ Integer → branchName（从 branchNameCache 缓存映射，找不到时为空字符串）
- 时间单位：入参秒级 Long，Service 层 `* 1000` 转毫秒给 ES

### 默认行为
- `limit` 未传时默认 10
- `directions` 可为空（不按方向过滤）
- `srcCountryNames`/`srcProvinceName` 可为空（不过滤源国家/省份）
- `excludeParam` 可为空（不排除任何源国家）
- branchName 找不到时默认空字符串

### 特殊规则
- `branchIds` 必传，最多 2000 个元素
- `platformIds` 必传，最多 40 个，每个长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN
- `directions` 最多 10 个元素，每个必须是 AttackDirectionEnum 有效值
- `srcCountryNames`/`srcProvinceName` 最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- `excludeParam.srcCountryNames` 最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- `limit` 默认 10，最大 100
- 时间范围最长 180 天

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long，[0, 9999999999]） | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long，[0, 9999999999]） | 1783209600 |
| directions | array[integer] | 是 | - | 访问方向列表，最多 10 个，取值见 AttackDirectionEnum（0/1/2/3） | [2] |
| limit | integer | 否 | 10 | TOP 数量，最大 100 | 10 |
| platformIds | array[string] | 是 | - | 平台 ID 列表，最多 40 个，每个长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN | ["platform1"] |
| branchIds | array[integer] | 是 | - | 资产组 ID 列表，最多 2000 个 | [1,2,3] |
| srcCountryNames | array[string] | 否 | - | 源国家过滤（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["China"] |
| srcProvinceName | array[string] | 否 | - | 源省份过滤（数据库字段 provinceName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Beijing"] |
| excludeParam | object | 否 | - | 排除字段，结构见下方 AttackBranchExcludeQo 子结构表 | {"srcCountryNames":["Unknown"]} |

#### directions 枚举（AttackDirectionEnum，参考 enum-dictionary.md）

| 取值 | 说明 |
|------|------|
| 0 | 无（NON） |
| 1 | 内->外（IN_TO_OUT） |
| 2 | 外->内（OUT_TO_IN） |
| 3 | 内->内（IN_TO_IN） |

> 注意：本接口 directions 接受 0（无）。

#### excludeParam 子结构（AttackBranchExcludeQo）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| srcCountryNames | array[string] | 否 | 排除的源国家（数据库字段 countryName），最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN | ["Unknown"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（BigScreenAttackedAssetVo） |

### data 结构说明（BigScreenAttackedAssetVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[object] | 受攻击资产 Top N 列表，结构见下方 AttackAssetInfo 子结构表 |

#### item 子结构（BigScreenAttackedAssetVo.AttackAssetInfo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| hostBranchId | string | 资产组 ID | - | "1" |
| hostIp | string | 资产 IP | - | "192.168.1.10" |
| hostAssetId | string | 资产 ID | - | "101" |
| hostBranchName | string | 资产组名（从 branchNameCache 映射，找不到时为空字符串） | - | "总部" |
| dstIps | array[string] | 被攻击 IP 列表（前端放一个显示加 n） | - | ["192.168.1.10","192.168.1.11"] |
| srcIp | string | 攻击者 IP | - | "8.8.8.8" |
| alertCount | long | 被攻击次数（即告警次数） | - | 234 |
| area | string | 地域信息 | - | "United States" |

## 调用示例

### 示例1：查询外对内方向的受攻击资产 Top 10

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "directions": [2],
  "limit": 10,
  "platformIds": ["platform-001"],
  "branchIds": [1, 2, 3]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"hostBranchId": "1", "hostIp": "192.168.1.10", "hostAssetId": "101", "hostBranchName": "总部", "dstIps": ["192.168.1.10"], "srcIp": "8.8.8.8", "alertCount": 234, "area": "United States"},
      {"hostBranchId": "1", "hostIp": "192.168.1.11", "hostAssetId": "102", "hostBranchName": "总部", "dstIps": ["192.168.1.11"], "srcIp": "5.5.5.5", "alertCount": 198, "area": "Russia"},
      {"hostBranchId": "2", "hostIp": "10.0.0.5", "hostAssetId": "201", "hostBranchName": "数据中心", "dstIps": ["10.0.0.5"], "srcIp": "1.1.1.1", "alertCount": 156, "area": "Australia"}
    ]
  }
}
```

### 示例2：带源国家过滤和排除的查询

**请求示例**：
```json
{
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "directions": [2, 3],
  "limit": 5,
  "platformIds": ["platform-001", "platform-002"],
  "branchIds": [1, 2],
  "srcCountryNames": ["China", "Russia"],
  "excludeParam": {
    "srcCountryNames": ["Unknown"]
  }
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"hostBranchId": "1", "hostIp": "192.168.1.10", "hostAssetId": "101", "hostBranchName": "总部", "dstIps": ["192.168.1.10"], "srcIp": "5.5.5.5", "alertCount": 412, "area": "Russia"},
      {"hostBranchId": "2", "hostIp": "10.0.0.5", "hostAssetId": "201", "hostBranchName": "数据中心", "dstIps": ["10.0.0.5"], "srcIp": "6.6.6.6", "alertCount": 298, "area": "China"}
    ]
  }
}
```

### 示例3：错误响应 - branchIds 未传

**请求示例**（缺必填字段）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "directions": [2],
  "platformIds": ["platform-001"]
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "资产组范围不能为空",
  "data": null
}
```

### 示例4：错误响应 - direction 非法

**请求示例**（direction 值不在枚举）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "directions": [9],
  "platformIds": ["platform-001"],
  "branchIds": [1]
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "访问方向非枚举值",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp`/`endTimestamp`：秒级 Long，[0, 9999999999]
- `directions`：最多 10 个元素，每个为 AttackDirectionEnum 有效值（0/1/2/3）
- `limit`：默认 10，最大 100
- `platformIds`：必传，最多 40 个，每个长度 ≤ 64，须符合 COMMON_LEGAL_CHAR_PATTERN
- `branchIds`：必传，最多 2000 个元素
- `srcCountryNames`/`srcProvinceName`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- `excludeParam.srcCountryNames`：最多 10 个，须符合 COMMON_LEGAL_CHAR_PATTERN
- 时间范围：最长 180 天

### 参数依赖关系
- `branchIds` 和 `platformIds` 必传
- `directions` 中元素必须是 AttackDirectionEnum 有效值
- `excludeParam.srcCountryNames` 用于排除特定源国家，与 `srcCountryNames`（包含过滤）配合使用

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `branchIds` 数量建议精简，过多会增加 ES 查询开销
- `limit` 建议按大屏展示需求设置（如 Top 10），不要传超大值
- 时间范围建议 ≤ 30 天，避免长范围查询影响响应速度

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- `hostBranchName` 从 `branchNameCache` 缓存映射，资产组未配置名称时为空字符串（非 null）
- `hostBranchId`/`hostAssetId` 字段在 VO 中为 String 类型（ES 返回后转字符串）
- `alertCount` 为聚合后的告警次数，非去重计数

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.attack.screen.time.negative | startTime > endTime | 确保 startTimestamp ≤ endTimestamp |
| 500 | exception.attack.screen.time.exceed | 时间范围超过 180 天 | 缩小时间范围至 180 天内 |
| 500 | exception.attack.screen.time.direction.not.enum | directions 含非枚举值 | 使用 0/1/2/3 |
| 400 | param.attack.screen.branch.startTime.null | startTimestamp 未传 | 必传 startTimestamp |
| 400 | param.attack.screen.branch.startTime.min | startTimestamp < 0 | startTimestamp ≥ 0 |
| 400 | param.attack.screen.branch.startTime.max | startTimestamp > 9999999999 | startTimestamp ≤ 9999999999 |
| 400 | param.attack.screen.branch.endTime.null | endTimestamp 未传 | 必传 endTimestamp |
| 400 | param.attack.screen.branch.endTime.min | endTimestamp < 0 | endTimestamp ≥ 0 |
| 400 | param.attack.screen.branch.endTime.max | endTimestamp > 9999999999 | endTimestamp ≤ 9999999999 |
| 400 | param.attack.screen.branch.direction.null | directions 未传 | 必传 directions |
| 400 | param.attack.screen.branch.direction.size.limit | directions 元素数 > 10 | 减少 directions 数量 |
| 400 | param.attack.screen.branch.limit | limit > 100 | limit ≤ 100 |
| 400 | param.attack.screen.branch.platform.null | platformIds 未传 | 必传 platformIds |
| 400 | param.attack.screen.branch.platform.size.limit | platformIds 元素数 > 40 | 减少 platformIds 数量 |
| 400 | param.attack.screen.branch.platform.value.limit | platformId 长度 > 64 | 缩短 platformId |
| 400 | param.attack.screen.branch.platform.value.format | platformId 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |
| 400 | param.attack.screen.branch.branchId.null | branchIds 未传 | 必传 branchIds |
| 400 | param.attack.screen.branch.branchId.size.limit | branchIds 元素数 > 2000 | 减少 branchIds 数量 |
| 400 | srcCountryNames fields size out of range | srcCountryNames 元素数 > 10 | 减少 srcCountryNames 数量 |
| 400 | srcCountryNames invalid field format | srcCountryNames 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |
| 400 | srcProvinceName fields size out of range | srcProvinceName 元素数 > 10 | 减少 srcProvinceName 数量 |
| 400 | srcProvinceName invalid field format | srcProvinceName 含非法字符 | 须符合 COMMON_LEGAL_CHAR_PATTERN |

## 最佳实践

1. **directions 选择**：分析外部攻击受影响资产用 [2]（外对内），分析内部横向移动受影响资产用 [3]（内对内），多方向组合用 [1,2,3]
2. **limit 取值**：大屏展示建议 Top 10，详细分析可适当增加但不超过 100
3. **branchIds 范围**：按业务关注的资产组范围传值，避免传过多资产组导致查询变慢
4. **srcCountryNames 与 excludeParam 配合**：先按 srcCountryNames 包含过滤特定国家，再用 excludeParam.srcCountryNames 排除其中的特定国家（如 Unknown）
5. **配合攻击源概览**：与 `/api/xdr/v1/alerts/attack/sources` 接口组合展示攻击大屏的攻击源和受攻击资产全貌
6. **时间范围优化**：大屏实时展示建议查询最近 1-7 天数据，避免长范围查询影响响应速度
7. **hostBranchName 处理**：资产组未配置名称时为空字符串，前端需兜底显示（如显示 hostBranchId）
