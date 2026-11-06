# POST /api/xdr/v1/alerts/getEntityInfo

- 业务对象：实体调查（XEN）
- 接口类型：详情查询
- 关联文档：`alert-getXenAlertId.md`（反向：实体→告警ID）、`alert-getAlertInfo.md`（告警ID→告警详情+威胁实体）

## 接口概述

单个实体信息查询接口，传入一个调查实体值（IP/域名/MD5），后端按值格式自动识别实体类型并返回对应的资产信息、IP 情报、域名情报或文件情报。**适用于在告警详情页点击某个 IP/域名/MD5 后查询该实体完整上下文，用于威胁狩猎和溯源**。

## 使用场景

- 已知 IP 地址，查询是内网资产还是外网 IP，并获取对应资产信息或威胁情报
- 已知域名，查询域名的威胁情报上下文（威胁标签、DNS 解析、信誉分）
- 已知文件 MD5，查询文件情报（病毒名、首次/末次出现时间、威胁等级）
- 配合告警接口：从告警详情提取 srcIp/dstIp/domain/fileMd5 后调用本接口获取实体情报

## 请求路径

- **对外调用路径**：`/api/xdr/v1/alerts/getEntityInfo`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/xen/getEntityInfo`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin`、`alertQuery` 或 `incidentQuery`

## 请求参数（OpenXenEntityQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| traceValue | String | 是（业务必填） | — | IPv4 地址 / 域名 / MD5（32 位十六进制） | 调查实体值。QO 类无 `@NotNull` 注解，但 Service 层校验非空，空值时直接返回 null |

> ⚠️ **入参字段就这一个 `traceValue`，没有 `entityType` / `entityValue` 字段**：QO 类只定义了 `traceValue` 一个字段。实体类型由 Service 层按值格式自动识别（IP/域名/MD5），**不需要也不接受前端传 `entityType` 或 `entityValue`**。常见错误：参考 `/alerts/getXenAlertId` 的 `type + ips/assetIds/dnsNames/md5s` 结构臆造 `entityType + entityValue` 字段——本接口结构完全不同，**严禁臆造字段**（已知踩坑：传 `{"entityType": 1, "entityValue": "x.x.x.x"}` 后端忽略未知字段，`traceValue` 为空，Service 层直接返回 null，调用方收到 `data: null` 无任何业务数据）。

## 返回参数（OpenApiXenEntityVo）

| 字段名 | 类型 | 说明 | 取值范围 |
|--------|------|------|----------|
| type | Integer | 实体类型 | 0/资产, 1/IP, 2/域名, 3/MD5；无法识别时为 null |
| assetInfo | Object | 资产信息（type=0 时返回，来源 Asset 实体） | 见 assetInfo 结构 |
| ipContextBasic | Array<IpContextBasic> | IP 情报上下文列表（type=1 时返回） | 情报中心定义 |
| domainContextBasic | Array<DomainContextBasic> | 域名情报上下文列表（type=2 时返回） | 情报中心定义 |
| fileContext | Array<FileContext> | 文件情报上下文列表（type=3 时返回） | 情报中心定义 |

### type 枚举值说明

| 值 | 类型 | 说明 | 返回字段 |
|----|------|------|----------|
| 0 | 资产 | 内网资产，资产服务返回的 assetId 非零 | assetInfo |
| 1 | IP | 外网 IP，资产不存在或 assetId=0 && branchId=0 | ipContextBasic |
| 2 | 域名 | 域名格式（匹配 DOMAIN_REGEX） | domainContextBasic |
| 3 | MD5 | MD5 格式（匹配 MD5_REGEX） | fileContext |

### assetInfo 结构（type=0 时返回，来源 Asset 实体）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | Long | 资产 ID |
| branchId | Integer | 资产组 ID |
| branchName | String | 资产组名称 |
| hostName | String | 主机名 |
| responsible | String | 责任人 |
| interfaces | Array | 资产网络接口列表（含 ip、mac） |

> 注：Asset 字段较多，完整结构参考 `com.sangfor.ngsoc.incident.model.client.asset.Asset` 类。

### ipContextBasic / domainContextBasic / fileContext 通用字段（情报中心 SDK 定义）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| threatIntel | Object | 威胁情报详情（威胁标签、来源、置信度） |
| geoLocation | Object | 地理位置（国家、省份、城市、经纬度） |
| asnInfo | Object | ASN 信息（仅 IP 类型） |
| dnsRecords | Array | DNS 解析记录（仅域名类型） |
| reputationScore | Integer | 信誉分数 |
| firstSeen | Long | 首次发现时间（秒级时间戳，10 位 Long） |
| lastSeen | Long | 最近发现时间（秒级时间戳，10 位 Long） |

> 注：以上为常见字段，实际字段以情报中心 SDK 返回为准。

## 业务逻辑

1. **traceValue 非空校验**：Service 层取 `traceValue`，若 `StringUtils.isBlank` 为真，记录日志并**直接返回 null**（不抛异常，不返回错误码）
2. **实体类型识别（按优先级 IPv4 → 域名 → MD5，三种互斥）**：
   - **IPv4**：`Validator.isIpv4(traceValue)` 为真时进入 IP 分支
     - 调 `getAssetInfo(traceValue)` 取资产
     - 资产存在且 `assetId == 0 && branchId == 0`：识别为外网 IP（type=1），调 `IntelligenceUtil.findIpContextBasicWithoutCache` 查询 IP 情报
     - 资产存在且非零 ID：识别为内网资产（type=0），设置 `assetInfo` 字段
     - 资产不存在：识别为外网 IP（type=1），查询 IP 情报
   - **域名**：`Pattern.matches(DOMAIN_REGEX, traceValue)` 为真时 type=2，查询域名情报
   - **MD5**：`Pattern.matches(MD5_REGEX, traceValue)` 为真时 type=3，traceValue 转小写后查询文件情报
3. **返回**：将构造好的 `OpenApiXenEntityVo` 封装到 `OpenApiResponse` 返回

## 数据一致性说明

- **本接口无入参时间戳**
- 返回的 `firstSeen`/`lastSeen`（情报中心字段）为秒级时间戳（10 位 Long）
- **MD5 大小写不敏感**：Service 层会自动将 traceValue 转小写后查询情报中心
- **情报查询均为无缓存模式**：每次调用都请求情报中心最新数据

## 调用示例

### 示例 1：查询内网 IP 对应的资产信息

```json
POST /api/xdr/v1/alerts/getEntityInfo
{
  "traceValue": "192.168.1.100"
}
```

返回示例：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "type": 0,
    "assetInfo": {
      "id": 1001,
      "branchId": 1,
      "branchName": "研发中心",
      "hostName": "web-server-01",
      "responsible": "zhangsan",
      "interfaces": [
        {"ip": "192.168.1.100", "mac": "00:11:22:33:44:55"}
      ]
    }
  }
}
```

### 示例 2：查询外网 IP 的威胁情报

```json
POST /api/xdr/v1/alerts/getEntityInfo
{
  "traceValue": "8.8.8.8"
}
```

返回示例：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "type": 1,
    "ipContextBasic": [
      {
        "threatIntel": {"threatTags": ["C2", "Botnet"], "confidence": 90},
        "geoLocation": {"country": "美国", "province": "加利福尼亚"},
        "asnInfo": {"asn": "AS15169", "org": "Google LLC"},
        "reputationScore": 10
      }
    ]
  }
}
```

### 示例 3：查询域名的威胁情报

```json
POST /api/xdr/v1/alerts/getEntityInfo
{
  "traceValue": "malicious.example.com"
}
```

### 示例 4：查询 MD5 文件情报（大小写不敏感）

```json
POST /api/xdr/v1/alerts/getEntityInfo
{
  "traceValue": "E90AFC86C7B1AB55E9DFFA631CEF0821"
}
```

Service 层会自动转小写后查询情报中心。

### 示例 5：traceValue 为空时返回 null

```json
POST /api/xdr/v1/alerts/getEntityInfo
{
  "traceValue": ""
}
```

返回示例：

```json
{
  "code": 200,
  "message": "success",
  "data": null
}
```

## 使用注意事项

1. **入参字段只有 `traceValue`**：严禁臆造 `entityType` / `entityValue` 等字段——本接口与 `/alerts/getXenAlertId`（type + 多个实体列表字段）结构完全不同
2. **traceValue 必填（业务层）**：QO 无 `@NotNull` 注解，但 Service 层空值时直接返回 null，调用方收不到任何业务数据
3. **实体类型自动识别**：前端不需要传 type，后端按 IPv4 → 域名 → MD5 顺序匹配（三种互斥）
4. **MD5 大小写均可**：Service 自动转小写
5. **不支持批量**：本接口为单实体查询，大量实体需逐个调用（建议前端异步并发）
6. **无入参时间戳**：本接口不涉及入参时间范围，仅返回的情报中心字段含时间戳

## 关联接口

- `alert-getXenAlertId.md`：反向查询，由实体（资产ID/IP/XFF/DNS/MD5/外网IP）查关联告警 uuId 列表
- `alert-getAlertInfo.md`：由告警 uuId 列表查告警详情 + 威胁实体（responseDisposition 嵌套结构）
- `alert-getXenEntity.md`：由告警 uuId 列表查告警关联的实体信息（正向）
