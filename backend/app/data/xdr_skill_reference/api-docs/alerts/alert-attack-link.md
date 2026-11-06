# POST /api/xdr/v1/alerts/attack/link

## 接口概述

本接口用于查询攻击大屏的区域连线信息，基于主区域的资产 ID 列表与访问方向，从 ES 聚合出区域间的攻击连线（edges）和外网区域 IP 列表（externalArea）。通过本接口，您可以获取以下内容：

### 可查询的连线维度
- **区域资产映射**：areaInfos（区域名 + 资产 ID 列表，最多 6 个区域）
- **主区域**：areaName（连线主区域名称，必须在 areaInfos 中存在）
- **访问方向**：direction（1-内对外 / 2-外对内 / 3-内对内）
- **时间范围 + 平台过滤**：startTimestamp/endTimestamp、platformIds

### 返回的连线信息
- **edges**：连线列表，每条含 source（起点）+ target（终点）
- **externalArea**：外网区域 IP 列表（含 ip、countryName、docCount），仅内对外/外对内方向返回
- **direction + areaName**：回显请求参数

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口（攻击大屏专用） |
| 接口分类 | 攻击大屏 - 区域连线 |
| 前置依赖 | 需先调用 `/api/xdr/v1/alerts/attack/area` 获取各区域的资产 ID（hostAssetId）和 areaAssetKey |
| 关联接口 | `/api/xdr/v1/alerts/attack/area` 攻击区域展示（提供 areaAssetKey）、`/api/xdr/v1/alerts/attack/sources` 攻击源资产概览、`/api/xdr/v1/alerts/attack/target` 受攻击资产概览 |

## 使用场景

1. **攻击大屏连线绘制**：根据主区域资产 ID 与访问方向，绘制区域间的攻击连线
2. **内对外连线分析**：direction=1 时，从内网主区域资产连出到外网目的 IP，返回外网区域 IP 列表
3. **外对内连线分析**：direction=2 时，从外网源 IP 连入到内网主区域资产，返回外网源 IP 列表
4. **内对内连线分析**：direction=3 时，内网不同区域间资产连线，无外网区域返回
5. **配合攻击区域展示接口**：先调 `/attack/area` 获取各区域资产 ID 和 areaAssetKey，再调本接口绘制连线
6. **平台过滤分析**：通过 platformIds 限定查询的平台范围

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/attack/link |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Validated + Service 层）：
   - Controller 触发 QO 字段校验（@NotNull/@Min/@Max/@Size/@Pattern）
   - Service 校验 `startTime > endTime` 时抛 `exception.attack.screen.time.negative`
   - 校验时间范围 ≤ 180 天，超出抛 `exception.attack.screen.time.exceed`
2. **主区域定位**：从 `areaInfos` 中按 `areaName` 找到主区域的 `HostAssetIdAreaDto`，取出 `hostAssetIds`（资产 ID 列表）
3. **主区域资产 ID 校验**：若 `hostAssetIds` 为空或全为空列表，抛 `HOST_ASSET_ID_NOT_EMPTY`（主区域必须有资产 ID 否则无法连线）
4. **查询 ES**：调用 `attackBigScreenDao.getAttackLinkUpResponse(attackBigScreenLineQo, direction, assetIds)`，按主区域资产 ID + direction + 时间范围 + platformIds 聚合查询
5. **areaAssetKey 组装**：从所有 `areaInfos` 的 `hostAssetIds` 收集所有资产 ID，通过 `getAreaAssetKeys` 映射为 areaAssetKey → 资产 ID 字符串
6. **ES 聚合解析**：
   - `group_by_assetId` 按资产 ID 分组，每个桶内 `nested_dst_src` 嵌套聚合 `dst_asset_id_agg` 按目的/源 IP 分桶
   - 按 direction 分支处理：
     - `IN_TO_IN`（内对内）：调用 `inToInExtracted`，从主区域资产连到其他内网区域资产
     - `IN_TO_OUT`（内对外）：调用 `inToOutExtractedStore`，从主区域资产连到外网目的 IP，存入 externalArea
     - `OUT_TO_IN`（外对内）：调用 `outToInExtracted`，从外网源 IP 连到主区域资产，存入 externalArea
7. **外网区域去重**：
   - 内对外方向：按目的 IP 过滤重复，剔除不相关区域，最终保留前 20 个外网区域 IP
   - 外对内方向：按源 IP 过滤重复
8. **连线去重**：按 `source + SPLIT_SIGN + target` 去重，保留已存在的 edge
9. **封装返回**：组装 `AttackLinkUpDto`，含 edges、externalArea、direction、areaName

### 数据转换逻辑

- ES 桶 key（`assetId|...` 格式）→ 拆分取第一个为资产 ID → 映射为 areaAssetKey
- 资产 ID 列表 → areaAssetKey（用 JOIN_SIGN 拼接的字符串）
- direction 决定连线方向与 externalArea 填充逻辑
- 时间单位：入参秒级 Long，Service 层 `* 1000` 转毫秒给 ES

### 默认行为
- `areaInfos` 必须有 1-6 个元素（@Size(min=1, max=6)）
- `areaName` 必须在 `areaInfos` 中存在，否则主区域资产为空抛异常
- `platformIds` 可为空（不过滤平台）

### 特殊规则
- 主区域 `areaName` 必须在 `areaInfos` 中存在，且对应 `hostAssetIds` 不能为空
- `direction` 取值限定 [1, 3]，不接受 0（无）
- 内对外方向最终保留前 20 个外网区域 IP
- 连线按 source-target 去重
- `areaInfos` 最多 6 个，每个 `hostAssetIds` 最多 19 个子列表
- `platformIds` 最多 40 个，每个长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN
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
| areaInfos | array[object] | 是 | - | 各区域资产 ID 列表，1-6 个元素。结构见下方 HostAssetIdAreaDto 子结构表 | [{"areaName":"总部","hostAssetIds":[[101],[102]]}] |
| areaName | string | 否 | - | 连线的主区域名称，必须在 areaInfos 中存在，长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN | "总部" |
| direction | integer | 是 | - | 访问方向：1-内对外 / 2-外对内 / 3-内对内（AttackDirectionEnum），[1, 3] | 2 |
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long，[0, 9999999999]） | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long，[0, 9999999999]） | 1783209600 |
| platformIds | array[string] | 否 | - | 平台 ID 列表，最多 40 个，每个长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN | ["platform1"] |

#### direction 枚举（AttackDirectionEnum，参考 enum-dictionary.md）

| 取值 | 说明 |
|------|------|
| 1 | 内->外（IN_TO_OUT） |
| 2 | 外->内（OUT_TO_IN） |
| 3 | 内->内（IN_TO_IN） |

> 注意：本接口 direction 不接受 0（无）。

#### areaInfos 子结构（HostAssetIdAreaDto）

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| areaName | string | 否 | 区域名，长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN | "总部" |
| hostAssetIds | array[array[integer]] | 否 | 资产 ID 列表的列表，最多 19 个子列表 | [[101],[102,103]] |

#### ⚠️ 与 attack/area 字段名差异（高频踩坑）

`/attack/area` 与 `/attack/link` 两个接口的 `areaInfos` 子结构**字段名不同**，不能复用请求体：

| 接口 | areaInfos 子结构类 | 子字段 | 数据来源 |
|------|--------------------|--------|---------|
| `/alerts/attack/area` | `BranchIdsAreaDTO` | `branchIds`（资产组 ID 列表） | 用户提供（业务已知） |
| `/alerts/attack/link` | `HostAssetIdAreaDto` | `hostAssetIds`（资产 ID 列表的列表） | **必须从 `/attack/area` 返回值的 `hostAssetInfo[].hostAssetId` 字段提取** |

**错误场景**：把 `/attack/area` 的请求体（含 `branchIds`）直接复用到 `/attack/link`，`HostAssetIdAreaDto` 反序列化时 `branchIds` 字段被忽略，`hostAssetIds` 保持 null/空 → Service 层校验：

```java
if (CollectionUtils.isEmpty(assetIds) || assetIds.stream().allMatch(List::isEmpty)) {
    throw new IncidentException(I18nUtils.i18n("incident.attack.screen.hostAssetId.not.empty"));
}
```

错误现象：`{"code":"InternalError","message":"主区域资产ID不能为空"}`

#### ⚠️ 顶层 areaName 实际必填（服务端依赖）

QO 中顶层 `areaName` 字段虽标"否"（无 `@NotNull`），但 Service 层 `getAttackLinkUp` 通过 `getAreaName().equals(mainAreaName)` 在 `areaInfos` 中定位主区域。如果未传 `areaName`，找不到匹配项 → 主区域 `hostAssetIds` 为空 → 抛 `HOST_ASSET_ID_NOT_EMPTY`。

**正确做法**：
1. 先调 `/attack/area`，从返回值 `data.hostAssetIdArea[].hostAssetInfo[].hostAssetId` 收集资产 ID
2. 按 `areaName` 分组，构造 `areaInfos: [{areaName: <主区域名>, hostAssetIds: [[<assetId1>], [<assetId2>]]}]`
3. 顶层 `areaName` 必须与 `areaInfos` 中某项的 `areaName` 完全一致
4. `direction` 取 1/2/3，不要传 0

```json
{
  "areaName": "总部",
  "direction": 1,
  "startTimestamp": 1787846400,
  "endTimestamp": 1788537599,
  "areaInfos": [
    {"areaName": "总部", "hostAssetIds": [[101], [102], [103]]}
  ]
}
```

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（AttackLinkUpDto），查询无结果时可能为 null |

### data 结构说明（AttackLinkUpDto）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| edges | array[object] | 连线列表，结构见下方 EdgesDto 子结构表 |
| externalArea | array[object] | 外网区域 IP 列表（仅内对外/外对内方向有数据），结构见下方 ExternalAreaDto 子结构表 |
| direction | integer | 访问方向（1-内对外 / 2-外对内 / 3-内对内） |
| areaName | string | 主区域名称（回显请求参数） |

#### edges 子结构（EdgesDto）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| source | string | 起点标识（内对内：区域+资产ID；内对外/外对内：区域名+资产IP） | - | "总部-101" |
| target | string | 终点标识（内对内：区域+资产ID；内对外/外对内：区域名+资产IP） | - | "分支机构-201" |

#### externalArea 子结构（ExternalAreaDto）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| ip | string | 外网 IP | - | "8.8.8.8" |
| countryName | string | 国家名 | - | "United States" |
| docCount | long | 告警数 | - | 234 |

## 调用示例

### 示例1：内对内方向连线查询

**请求示例**：
```json
{
  "areaInfos": [
    {"areaName": "总部", "hostAssetIds": [[101], [102]]},
    {"areaName": "分支机构", "hostAssetIds": [[201], [202]]}
  ],
  "areaName": "总部",
  "direction": 3,
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
    "edges": [
      {"source": "总部-101", "target": "分支机构-201"},
      {"source": "总部-102", "target": "分支机构-202"}
    ],
    "externalArea": [],
    "direction": 3,
    "areaName": "总部"
  }
}
```

### 示例2：内对外方向连线查询（含外网区域）

**请求示例**：
```json
{
  "areaInfos": [
    {"areaName": "总部", "hostAssetIds": [[101], [102]]}
  ],
  "areaName": "总部",
  "direction": 1,
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "platformIds": ["platform-001"]
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "edges": [
      {"source": "总部-101", "target": "8.8.8.8"},
      {"source": "总部-102", "target": "1.1.1.1"}
    ],
    "externalArea": [
      {"ip": "8.8.8.8", "countryName": "United States", "docCount": 234},
      {"ip": "1.1.1.1", "countryName": "Australia", "docCount": 156}
    ],
    "direction": 1,
    "areaName": "总部"
  }
}
```

### 示例3：外对内方向连线查询

**请求示例**：
```json
{
  "areaInfos": [
    {"areaName": "数据中心", "hostAssetIds": [[301], [302]]}
  ],
  "areaName": "数据中心",
  "direction": 2,
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "edges": [
      {"source": "5.5.5.5", "target": "数据中心-301"},
      {"source": "6.6.6.6", "target": "数据中心-302"}
    ],
    "externalArea": [
      {"ip": "5.5.5.5", "countryName": "Russia", "docCount": 412},
      {"ip": "6.6.6.6", "countryName": "China", "docCount": 298}
    ],
    "direction": 2,
    "areaName": "数据中心"
  }
}
```

### 示例4：错误响应 - 主区域资产 ID 为空

**请求示例**（主区域 hostAssetIds 为空）：
```json
{
  "areaInfos": [
    {"areaName": "总部", "hostAssetIds": []},
    {"areaName": "分支机构", "hostAssetIds": [[201]]}
  ],
  "areaName": "总部",
  "direction": 3,
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "主区域资产ID不能为空",
  "data": null
}
```

### 示例5：错误响应 - direction 未传

**请求示例**（缺必填字段）：
```json
{
  "areaInfos": [{"areaName": "总部", "hostAssetIds": [[101]]}],
  "areaName": "总部",
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
- `areaInfos`：1-6 个元素
- `areaInfos[].hostAssetIds`：最多 19 个子列表
- `areaName`：长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN
- `direction`：[1, 3] 整数
- `platformIds`：最多 40 个，每个长度 ≤ 64，须符合 LEGAL_CHAR_PATTERN
- `startTimestamp`/`endTimestamp`：秒级 Long，[0, 9999999999]
- 时间范围：最长 180 天

### 参数依赖关系
- `areaName` 必须在 `areaInfos` 中存在，且对应 `hostAssetIds` 不能为空
- `direction` 决定连线方向与 externalArea 填充逻辑
- 内对外方向最终保留前 20 个外网区域 IP

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `areaInfos` 区域数建议 ≤ 6（已达上限）
- 主区域 `hostAssetIds` 资产数建议精简，过多会增加 ES 聚合开销
- 时间范围建议 ≤ 30 天，避免长范围查询影响响应速度

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- `edges` 已按 source-target 去重，不会返回重复连线
- `externalArea` 仅内对外/外对内方向返回数据，内对内方向为空数组

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.attack.screen.time.negative | startTime > endTime | 确保 startTimestamp ≤ endTimestamp |
| 500 | exception.attack.screen.time.exceed | 时间范围超过 180 天 | 缩小时间范围至 180 天内 |
| 500 | 主区域资产ID不能为空（HOST_ASSET_ID_NOT_EMPTY） | 主区域 hostAssetIds 为空或全为空列表 | 主区域必须配置资产 ID |
| 400 | param.attack.screen.link.area.size.limit | areaInfos 元素数不在 [1, 6] | 调整 areaInfos 数量 |
| 400 | param.attack.screen.link.area.name.length | areaName 长度 > 64 | 缩短 areaName |
| 400 | param.attack.screen.link.direction.null | direction 未传 | 必传 direction（1/2/3） |
| 400 | param.attack.screen.link.direction.limit | direction 不在 [1, 3] | 使用 1/2/3 |
| 400 | param.attack.screen.link.startTime.min | startTimestamp < 0 | startTimestamp ≥ 0 |
| 400 | param.attack.screen.link.startTime.max | startTimestamp > 9999999999 | startTimestamp ≤ 9999999999 |
| 400 | param.attack.screen.link.endTime.min | endTimestamp < 0 | endTimestamp ≥ 0 |
| 400 | param.attack.screen.link.endTime.max | endTimestamp > 9999999999 | endTimestamp ≤ 9999999999 |
| 400 | 开始时间不能为空（EMPTY_START_TIME） | startTimestamp 未传 | 必传 startTimestamp |
| 400 | 结束时间不能为空（EMPTY_END_TIME） | endTimestamp 未传 | 必传 endTimestamp |
| 400 | param.attack.screen.link.platform.limit | platformIds 元素数 > 40 | 减少 platformIds 数量 |
| 400 | param.attack.screen.link.platform.value.length | platformId 长度 > 64 | 缩短 platformId |
| 400 | param.attack.screen.area.asset.limit | hostAssetIds 子列表数 > 19 | 减少 hostAssetIds 子列表 |

## 最佳实践

1. **配合攻击区域展示接口**：先调 `/api/xdr/v1/alerts/attack/area` 获取各区域的资产 ID 和 areaAssetKey，再调本接口绘制连线
2. **direction 选择**：分析外部攻击连入用 2（外对内），分析内部外联用 1（内对外），分析内部横向移动用 3（内对内）
3. **主区域配置**：`areaName` 必须是 `areaInfos` 中已配置资产 ID 的区域，否则抛异常
4. **外网区域处理**：内对外/外对内方向的 `externalArea` 已自动去重并保留前 20 个外网 IP，前端可直接展示
5. **连线去重**：`edges` 已按 source-target 去重，前端无需再次去重
6. **时间范围优化**：大屏实时展示建议查询最近 1-7 天数据，避免长范围查询影响响应速度
