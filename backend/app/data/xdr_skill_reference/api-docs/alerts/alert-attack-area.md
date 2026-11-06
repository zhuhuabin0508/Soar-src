# POST /api/xdr/v1/alerts/attack/area

## 接口概述

本接口用于按攻击大屏区域分组聚合统计受攻击资产信息，支持按多个区域（每个区域由资产组 ID 集合定义）+ 访问方向 + 时间范围 + 平台 ID 过滤，返回各区域内的受攻击资产列表（含资产 ID、资产 IP、资产组、严重等级）。通过本接口，您可以获取以下内容：

### 可查询的攻击区域信息
- **区域分组**：areaName（区域名称）+ branchIds（资产组 ID 列表）
- **访问方向**：direction（1-内对外 / 2-外对内 / 3-内对内）

### 返回的资产信息
- **区域资产统计**：areaName、total（区域资产数）
- **资产详情**：hostAssetId（资产 ID 列表）、hostIp（资产 IP）、branchId（资产组 ID）、branchName（资产组名称）、severity（严重等级 0-4）、areaAssetKey（前端连线用 key）
- **方向字典**：attackDirections（访问方向枚举值-描述映射）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口（攻击大屏专用） |
| 接口分类 | 攻击大屏 - 区域展示 |
| 前置依赖 | 需先获取资产组 ID（branchIds）和平台 ID |
| 关联接口 | `/api/xdr/v1/alerts/attack/link` 攻击区域连线、`/api/xdr/v1/alerts/attack/sources` 攻击源资产概览、`/api/xdr/v1/alerts/attack/target` 受攻击资产概览 |

## 使用场景

1. **攻击大屏区域展示**：在攻击大屏上按区域分组展示受攻击资产，每个区域含资产组 ID 列表
2. **多区域资产对比**：一次请求传入多个区域（areaInfos 最多 6 个），获取各区域的资产分布
3. **方向过滤分析**：按 direction 过滤内对外/外对内/内对内三种访问方向的攻击
4. **平台过滤**：通过 platformIds 限定查询的平台范围（最多 40 个）
5. **配合攻击连线接口**：本接口返回 areaAssetKey，配合 `/api/xdr/v1/alerts/attack/link` 接口绘制攻击连线
6. **配合攻击源/受攻击资产概览**：与 `/attack/sources`、`/attack/target` 接口组合展示攻击大屏全貌

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/attack/area |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Validated + Service 层）：
   - Controller 触发 QO 字段校验（@NotNull/@Min/@Max/@Size/@Pattern/@Valid）
   - Service 校验 `startTime > endTime` 时抛 `exception.start.time.lt.end.time`
   - 校验时间范围 ≤ 180 天，超出抛 `exception.start.time.range180.end.time`
   - 校验 `platformIds`（若非空）每个元素长度 ≤ 64，超出抛 `platform id max is 64`
2. **查询构造**：QO 通过 `convertAttackAreaShowQo()` 转换为内部 `AttackAreaShowQo`，保留 areaInfos（区域-资产组映射）、direction、startTime、endTime、platformIds
3. **遍历区域查询 ES**：对每个 `BranchIdsAreaDTO`：
   - 调用 `attackBigScreenDao.getAttackAreaShowResponse(attackAreaShowQo, branchIdsAreaDTO)` 查询 ES
   - 按 `branchIds` 过滤 + `direction` 过滤 + 时间范围 + platformIds 过滤
   - ES 聚合：`groupByScript`（按 hostBranchId + hostIp 联合 key 分组）+ `max_severity`（取最大严重等级分数）+ `hostAssetIds`（资产 ID 列表）
4. **结果转换**：
   - 解析 `groupByScript` 桶，按 `SPLIT_SIGN` 拆分出 hostBranchId 和 hostIp
   - `max_severity` 通过 `SeverityEnum.getNumByScore` 映射为 0-4 等级
   - `hostAssetIds` 子聚合取出资产 ID 列表
   - 用 `branchIdToNameMap` 缓存映射 branchId → branchName
   - 资产 ID 列表用 `JOIN_SIGN` 拼接为 `areaAssetKey`（前端连线用）
5. **封装返回**：组装 `AttackAreaAndAssetIdDto`，含 direction、attackDirections（方向枚举字典）、hostAssetIdArea（各区域资产列表）

### 数据转换逻辑

- ES 桶 key（`hostBranchId_hostIp` 格式）→ 拆分为 branchId 和 hostIp
- `max_severity`（分数 0-100）→ `SeverityEnum.getNumByScore` → 等级 0-4（0-信息/1-低危/2-中危/3-高危/4-严重）
- branchId → branchName 通过 `branchNameCache.getBranchIdToNameMap()` 映射
- 资产 ID 列表 → `areaAssetKey` 字符串（用 `JOIN_SIGN` 拼接）
- 时间单位：入参秒级 Long，Service 层 `* 1000` 转毫秒给 ES

### 默认行为
- `platformIds` 可为空（不过滤平台）
- `direction` 必传，无默认值

### 特殊规则
- `areaInfos` 最多 6 个区域
- 每个 `areaInfos` 元素的 `branchIds` 最多 2000 个
- `areaName` 长度 [1, 64]，须符合 LEGAL_CHAR_PATTERN
- `platformIds` 最多 40 个，每个长度 ≤ 64
- 时间范围最长 180 天
- `startTimestamp`/`endTimestamp` 必须 ≥ 1（@Min(1)）

### ⚠️ areaInfos 实际必填（@NotNull 校验生效）

`BranchIdsAreaDTO` 的 `areaName` / `branchIds` 均标有 `@NotNull`（`BranchIdsAreaDTO.java:26` 对应 `incident_zh_CN.properties:206`），请求体校验阶段真实生效：缺失 `areaInfos`（或 `areaInfos` 某元素缺少 `areaName` / `branchIds`）时 **HTTP 400** `{"code":"Unknown","message":"请求失败"}`，请求在进入 Service 前即被拦截，**不会走到 NPE 路径**。

| 错误请求 | 后果 |
|---------|------|
| 缺 `areaInfos` | 400 `{"code":"Unknown","message":"请求失败"}`（进 Service 前被校验拦截） |
| `areaInfos: [{}]` | 400：`区域名称不能为空;区域资产组不能为空;` |
| `areaInfos: []`（空数组） | 200（放行） |
| `direction: 0` / `4` / `99` / `-1` | 200（direction 仅 `@NotNull`，无白名单，返回与 direction=1 同构的数据或空结果） |

**正确做法**：即使只查一个区域，也必须显式传 `areaInfos`。

```json
{
  "areaInfos": [{"areaName": "总部", "branchIds": [1, 2, 54]}],
  "direction": 2,
  "startTimestamp": 1787846400,
  "endTimestamp": 1788537599
}
```

> **注意**：时间跨度超过 180 天时，`@Min(1)` / 时长校验**先于**参数校验触发，以 **500** 返回（会掩盖本应 400 的枚举/格式错误）。

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| areaInfos | array[object] | 是 | - | 区域-资产组映射列表，最多 6 个元素。结构见下方 BranchIdsAreaDTO 子结构表。**实际必填**：缺失 / 元素缺少 areaName/branchIds → 400 `{"code":"Unknown","message":"请求失败"}`（`BranchIdsAreaDTO` 的 `@NotNull` 生效）；`areaInfos: []`（空数组）放行 → 200 | [{"areaName":"区域A","branchIds":[1,2]}] |
| direction | integer | 是 | - | 访问方向：1-内对外 / 2-外对内 / 3-内对内（AttackDirectionEnum） | 2 |
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long，[1, 9999999999]） | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long，[1, 9999999999]） | 1783209600 |
| platformIds | array[string] | 否 | - | 平台 ID 列表，最多 40 个，每个长度 ≤ 64 | ["platform1","platform2"] |

#### direction 枚举（AttackDirectionEnum，参考 enum-dictionary.md）

| 取值 | 说明 |
|------|------|
| 1 | 内->外（IN_TO_OUT） |
| 2 | 外->内（OUT_TO_IN） |
| 3 | 内->内（IN_TO_IN） |

> **注意**：本接口 `direction` 仅有 `@NotNull`（无 `@Min(1)@Max(3)` 白名单）。实测传 `0` / `4` / `99` / `-1` 均返回 **200**（传 0 与传 1 返回同构数据，传枚举外值返回空结果）；仅 null / 缺省时报「访问方向不能为空」。
>
> **同族对照**：`/api/xdr/v1/alerts/attack/link` 的 `direction` 带 `@Min(1)@Max(3)` 白名单，传 0 / 99 → **400**。两接口语义相同但校验强度不同，勿套用。

#### areaInfos 子结构（BranchIdsAreaDTO）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| areaName | string | 是 | 区域名，长度 [1, 64]，须符合 LEGAL_CHAR_PATTERN | "区域A" |
| branchIds | array[integer] | 是 | 资产组 ID 列表，最多 2000 个元素 | [1,2,3] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（TC-003 实测） |
| message | string | 响应消息 |
| data | object | 响应数据（AttackAreaAndAssetIdDto） |

### data 结构说明（AttackAreaAndAssetIdDto）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| hostAssetIdArea | array[object] | 各区域资产信息列表，结构见下方 HostAssetIdAreaDetailDto 子结构表 |
| direction | integer | 访问方向（1-内对外 / 2-外对内 / 3-内对内） |
| attackDirections | array[object] | 访问方向枚举值-描述映射（AttackDirectionEnum.valueToDescMap()） |

#### hostAssetIdArea 子结构（HostAssetIdAreaDetailDto）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| areaName | string | 区域名（与请求中的 areaName 一致） |
| total | integer | 该区域资产数量（为 0 也会返回） |
| hostAssetInfo | array[object] | 该区域资产详情列表，结构见下方 HostAssetInfoDTO 子结构表 |

#### hostAssetInfo 子结构（HostAssetInfoDTO）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| hostAssetId | array[integer] | 资产 ID 列表 | - | [101, 102] |
| areaAssetKey | string | 前端连线使用的 key（资产 ID 用 JOIN_SIGN 拼接） | - | "101-102" |
| branchId | integer | 资产组 ID | - | 1 |
| hostIp | string | 资产 IP | - | "192.168.1.10" |
| branchName | string | 资产组名（从缓存映射，可能为 null） | - | "总部" |
| severity | integer | 严重等级（SeverityEnum.getNumByScore 映射，参考 enum-dictionary.md） | 0-信息/1-低危/2-中危/3-高危/4-严重 | 3 |

#### attackDirections 元素结构

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| value | integer | 访问方向值（AttackDirectionEnum.value） | 2 |
| desc | string | 访问方向描述 | "外->内" |

## 调用示例

### 示例1：查询两个区域的受攻击资产（外对内方向）

**请求示例**：
```json
{
  "areaInfos": [
    {"areaName": "总部", "branchIds": [1, 2, 3]},
    {"areaName": "分支机构", "branchIds": [10, 11]}
  ],
  "direction": 2,
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "hostAssetIdArea": [
      {
        "areaName": "总部",
        "total": 3,
        "hostAssetInfo": [
          {"hostAssetId": [101], "areaAssetKey": "101", "branchId": 1, "hostIp": "192.168.1.10", "branchName": "总部一组", "severity": 3},
          {"hostAssetId": [102, 103], "areaAssetKey": "102-103", "branchId": 2, "hostIp": "192.168.1.11", "branchName": "总部二组", "severity": 2},
          {"hostAssetId": [104], "areaAssetKey": "104", "branchId": 3, "hostIp": "192.168.1.12", "branchName": "总部三组", "severity": 1}
        ]
      },
      {
        "areaName": "分支机构",
        "total": 1,
        "hostAssetInfo": [
          {"hostAssetId": [201], "areaAssetKey": "201", "branchId": 10, "hostIp": "10.0.0.5", "branchName": "分支机构A", "severity": 4}
        ]
      }
    ],
    "direction": 2,
    "attackDirections": [
      {"value": 0, "desc": "无"},
      {"value": 1, "desc": "内->外"},
      {"value": 2, "desc": "外->内"},
      {"value": 3, "desc": "内->内"}
    ]
  }
}
```

### 示例2：带平台 ID 过滤的区域查询

**请求示例**：
```json
{
  "areaInfos": [
    {"areaName": "数据中心", "branchIds": [100, 101]}
  ],
  "direction": 1,
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "platformIds": ["platform-001", "platform-002"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "hostAssetIdArea": [
      {
        "areaName": "数据中心",
        "total": 2,
        "hostAssetInfo": [
          {"hostAssetId": [301], "areaAssetKey": "301", "branchId": 100, "hostIp": "172.16.0.1", "branchName": "数据中心A", "severity": 2},
          {"hostAssetId": [302], "areaAssetKey": "302", "branchId": 101, "hostIp": "172.16.0.2", "branchName": "数据中心B", "severity": 1}
        ]
      }
    ],
    "direction": 1,
    "attackDirections": [
      {"value": 0, "desc": "无"},
      {"value": 1, "desc": "内->外"},
      {"value": 2, "desc": "外->内"},
      {"value": 3, "desc": "内->内"}
    ]
  }
}
```

### 示例3：错误响应 - 开始时间晚于结束时间

**请求示例**（时间范围非法）：
```json
{
  "areaInfos": [{"areaName": "区域A", "branchIds": [1]}],
  "direction": 2,
  "startTimestamp": 1783209600,
  "endTimestamp": 1782604800
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "开始时间不能晚于结束时间",
  "data": null
}
```

### 示例4：错误响应 - direction 未传

**请求示例**（缺必填字段）：
```json
{
  "areaInfos": [{"areaName": "区域A", "branchIds": [1]}],
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "访问方向不能为空",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `areaInfos`：最多 6 个元素
- `areaInfos[].branchIds`：最多 2000 个元素
- `areaInfos[].areaName`：长度 [1, 64]，须符合 LEGAL_CHAR_PATTERN
- `platformIds`：最多 40 个，每个长度 ≤ 64
- `startTimestamp`/`endTimestamp`：秒级 Long，[1, 9999999999]
- 时间范围：最长 180 天

### 参数依赖关系
- `direction` 必传，决定查询的访问方向
- `areaInfos` 中每个区域必须有 areaName + branchIds
- `startTimestamp` 必须 ≤ `endTimestamp`

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `areaInfos` 区域数建议 ≤ 6（已达上限），每个区域的 branchIds 数量尽量精简
- 时间范围建议 ≤ 30 天，超过会显著增加 ES 聚合开销
- `platformIds` 非必要时不要传，缩小查询范围

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- `severity` 字段由 ES 的 max_severity 分数（0-100）经 `SeverityEnum.getNumByScore` 映射为 0-4 等级，与 enum-dictionary.md 中 SeverityEnum 的 scoreNum 一致

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.start.time.lt.end.time | startTime > endTime | 确保 startTimestamp ≤ endTimestamp |
| 500 | exception.start.time.range180.end.time | 时间范围超过 180 天 | 缩小时间范围至 180 天内 |
| 500 | platform id max is 64 | platformIds 元素长度 > 64 | 缩短 platformId |
| 400 | param.attack.screen.area.name.null | areaName 未传 | 每个 areaInfos 元素必填 areaName |
| 400 | param.attack.screen.area.name.length | areaName 长度不在 [1, 64] | 调整 areaName 长度 |
| 400 | param.attack.screen.area.branch.null | branchIds 未传 | 每个 areaInfos 元素必填 branchIds |
| 400 | param.attack.screen.area.branch.limit | branchIds 元素数 > 2000 | 减少 branchIds 数量 |
| 400 | 访问方向不能为空（DIRECTION_NOT_EMPTY） | direction 未传 | 必传 direction（1/2/3） |
| 400 | 开始时间不能为空（EMPTY_START_TIME） | startTimestamp 未传 | 必传 startTimestamp |
| 400 | 结束时间不能为空（EMPTY_END_TIME） | endTimestamp 未传 | 必传 endTimestamp |
| 400 | 时间戳小于最小值（TIME_MIN） | 时间戳 < 1 | 时间戳 ≥ 1 |

## 最佳实践

1. **区域-资产组映射规划**：在调用前规划好 areaName 与 branchIds 的映射关系，建议 areaName 用业务可读名称（如"总部"、"数据中心"）
2. **direction 选择**：分析外部攻击用 2（外对内），分析内部横向移动用 3（内对内），分析内部外联用 1（内对外）
3. **配合攻击连线接口**：本接口返回的 `areaAssetKey` 用于 `/api/xdr/v1/alerts/attack/link` 接口的连线绘制
4. **branchName 缓存**：branchName 来自缓存，若资产组未配置名称可能为 null，前端需兜底显示
5. **severity 等级解读**：0-信息/1-低危/2-中危/3-高危/4-严重，参考 enum-dictionary.md 的 SeverityEnum
6. **时间范围优化**：大屏实时展示建议查询最近 1-7 天数据，避免长范围查询影响响应速度
