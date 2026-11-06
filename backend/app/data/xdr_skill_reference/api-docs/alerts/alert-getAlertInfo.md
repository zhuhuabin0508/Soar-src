# POST /api/xdr/v1/alerts/getAlertInfo

- 业务对象：告警
- 接口类型：详情查询（批量）
- 关联文档：`alert-getXenAlertId.md`（实体→告警ID，本接口的前置）、`alert-getEntityInfo.md`（单个实体情报查询）、`alert-getXenEntity.md`（告警→关联实体）

## 接口概述

根据告警 uuId 列表批量查询告警详情以及威胁实体（XEN 实体调查溯源）。内部并发查询 ES 告警表和 MongoDB 处置响应表，合并返回告警明细与威胁实体（responseDisposition）。**适用于拿到告警 ID 列表后获取完整告警详情（载荷、进程、文件、HTTP 报文等）及关联威胁实体的场景**。

## 使用场景

- 由 `/alerts/getXenAlertId` 拿到告警 uuId 列表后，批量获取告警详情
- 批量查询告警的威胁实体（MD5/文件名/DNS 名集合），用于威胁实体聚合分析
- 查询告警的溯源细节：进程命令行、执行命令、HTTP 请求/响应报文、数据包内容

## 请求路径

- **对外调用路径**：`/api/xdr/v1/alerts/getAlertInfo`
- Spring 内部路径：`/ngsoc/INCIDENT/api/v1/openapi/xen/getAlertInfo`（不写入对外文档）
- HTTP 方法：POST
- 权限：`superAdmin`、`alertQuery` 或 `incidentQuery`

## 请求参数（QueryEntityByAlertIdsQo）

| 参数名 | 类型 | 必填 | 默认值 | 取值范围 | 说明 |
|--------|------|------|--------|----------|------|
| uuIds | Array<String> | 是（业务必填） | — | 最多 100 个元素（`@Size(max=100)`），每个元素 `@NotBlank` 且符合 UUID 格式正则（UUID_CHAR_PARTTERN） | 告警 UUID 列表 |
| startTime | Long | 否 | — | 秒级时间戳（10 位 Long） | 查询开始时间 |
| endTime | Long | 否 | — | 秒级时间戳（10 位 Long） | 查询结束时间 |

> ⚠️ **`uuIds` 是 `List<String>`，必须传 JSON 数组，严禁降级为单个字符串**：QO 类的 `uuIds` 字段定义为 `List<@NotBlank @Pattern(...) String>`。Jackson 反序列化字符串到 ArrayList 会抛 `MismatchedInputException`（`StringCollectionDeserializer.handleNonArray`），常见错误：传 `{"uuIds": "xxx"}`（裸字符串）→ 反序列化失败报错。**必须传 `{"uuIds": ["xxx"]}`（数组字面量）**，哪怕只有一个元素也要用数组（已知踩坑）。另注意字段名拼写：`uuIds`（首字母 u 小写，Ids 的 I 大写）。

> ⚠️ **每个 uuId 元素必须符合 UUID 格式**：元素有 `@Pattern(regexp = UUID_CHAR_PARTTERN)` + `@NotBlank` 校验，传非 UUID 格式的告警 ID（如 "alert-001" 这类测试值在真实环境会失败）返回 400 校验错误。

## 返回参数（OpenApiXenAlertInfoVo）

data 为数组，每个元素为一条告警详情。按信息类别分组：

### 告警标识与基础信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| uuId | String | 告警唯一 ID | — | "3f8a2c10-xxxx" |
| name | String | 告警名称 | — | "永恒之蓝" |
| severity | Integer | 危害等级（IncidentSeverityEnum，参考 enum-dictionary.md） | — | 3 |
| moduleType | Integer | 攻击模块类型（威胁一级分类 ID） | — | 94 |
| attackTypeId | Integer | 攻击类型 ID（威胁二级分类） | — | 1 |
| attackSubTypeId | Integer | 攻击子类型 ID（威胁三级分类） | — | 1 |
| attackResult | Integer | 攻击结果（AttackResultEnum，参考 enum-dictionary.md） | 0/尝试, 1/成功, 2/失败, 3/失陷 | 1 |
| gptResult | Integer | GPT 研判结论（PrototypeGptResultEnum，参考 enum-dictionary.md） | 0/待研判, 110/攻击成功, 115/主机失陷活动, 120/病毒木马活动, 130/攻击未成功, 140/弱访问, 150/可疑攻击, 160/误报, 170/数据不足, 180/自定义类型 | 110 |
| combineType | Integer | 数据端网组合类型（CombineTypeEnum，参考 enum-dictionary.md） | — | 1 |
| whiteStatus | String | 加白状态（WhiteStatusEnum，参考 enum-dictionary.md） | 中文环境："未加白"/"已加白"/"部分加白"；国际版："0"/"1"/"2" | "未加白" |
| firstTime | Long | 首次发生时间 | 时间戳（秒级，10 位 Long） | 1751328000 |
| lastTime | Long | 最后一次发生时间 | 时间戳（秒级，10 位 Long） | 1751932800 |
| tiType | Integer | 情报类型 | — | 1 |
| tiIntelligence | String | 匹配到情报的具体内容 | — | — |

### 主机信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| hostIp | String | 主机 IP | "10.0.0.50" |
| hostAssetId | Long | 主机资产 ID | 12 |
| hostAssetName | String | 主机资产名称 | "web-server-01" |
| hostResponsible | String | 主机责任人 | "zhangsan" |
| hostBranchName | String | 主机所属资产组名称 | "研发中心" |
| platformHostBranchId | String | 平台主机资产组 ID | "1" |
| hostCountryName | String | 主机国家名称 | "中国" |
| hostProvinceName | String | 主机省份名称 | "广东" |

### 网络信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| srcIps | Array<String> | 源 IP 列表 | ["192.168.1.1"] |
| srcIp | Array<String> | 源 IP（冗余字段） | ["192.168.1.1"] |
| srcIpInfos | Array<XenIpInfo> | 源 IP 详情列表（含 ip、assetId 等） | 见示例 |
| srcAssetIds | Array<Long> | 源资产 ID 列表 | [1001] |
| dstIps | Array<String> | 目的 IP 列表 | ["10.0.0.50"] |
| dstIp | Array<String> | 目的 IP（冗余字段） | ["10.0.0.50"] |
| dstIpInfos | Array<XenIpInfo> | 目的 IP 详情列表 | 见示例 |
| dstAssetIds | Array<Long> | 目的资产 ID 列表 | [12] |
| ips | Set<String> | 待查询情报的 IP 集合 | ["8.8.8.8"] |
| xForwardedFor | Array<String> | X-Forwarded-For 头列表 | ["10.0.0.1"] |
| protocol | String | 协议 | "TCP" |
| direction | Integer | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md） | 0/无, 1/内对外, 2/外对内, 3/内对内 |

### HTTP 载荷与报文信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| httpUri | String | 请求 URI | "/api/login" |
| reqMethod | String | 请求方法 | "POST" |
| requestHead | String | 请求头 | — |
| responseHead | String | 响应头 | — |
| requestBody | String | 请求体 | — |
| responseBody | String | 响应体 | — |
| respStatus | Integer | 返回状态码 | 200 |
| packetData | String | 数据包内容 | — |

### 进程与文件信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| endPointCmds | Array<String> | 执行命令 | ["whoami"] |
| processPathDetails | Array<String> | 告警进程命令行 | ["C:\\Windows\\system32\\cmd.exe"] |
| fileName | String | 文件名称 | "malware.exe" |
| filePath | String | 文件路径 | "C:\\temp\\malware.exe" |
| virusName | Array<String> | 病毒名称 | ["Trojan.GenericKD"] |
| virusType | String | 病毒类型 | "木马" |

### 设备与溯源信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| devUid | Array<Integer> | 设备 ID 列表 | [2001] |
| deviceId | Array<Integer> | 设备 ID 列表（JSON 序列化名为 `devUId`，@JsonProperty 注解） | [2001] |
| devSourceName | Array<String> | 来源设备名称列表 | ["SIP-01"] |
| engineNames | Array<String> | 检测引擎名称列表 | ["IPS引擎"] |
| devices | Array<AlertDeviceInfo> | 设备详情列表 | 见示例 |
| ruleIds | Array<String> | 告警涉及的 ruleID 数组 | ["10001"] |
| traceBackId | Array<String> | 溯源 ID 列表 | — |
| logIds | Array<String> | 日志 ID 列表 | ["log-001"] |

### 威胁实体信息（responseDisposition 嵌套结构）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| responseDisposition | Object | 威胁实体嵌套结构 | 见下方结构 | 见示例 |

#### ResponseDisposition 结构（返回 VO 的内嵌 ResponseDisposition）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| md5s | Array<String> | 威胁实体关联的文件 MD5 集合 | ["e90afc86..."] |
| fileNames | Array<String> | 威胁实体关联的文件名集合 | ["malware.exe"] |
| dnsNames | Array<String> | 威胁实体关联的 DNS 名集合 | ["malicious.example.com"] |

> 注：无关联威胁实体时返回空 ResponseDisposition（三个数组均为空列表，不返回 null）。

## 业务逻辑

1. **参数校验**：`uuIds` 最多 100 个元素，每个元素 `@NotBlank` + UUID 格式正则校验；startTime/endTime 为可选秒级时间戳
2. **并发查询**：Service 层保存 SAAS 线程上下文后，通过线程池并发提交两个任务：
   - 任务 1：调 `alertDao.getXenInfoByAlertIds` 从 ES 获取告警实体信息
   - 任务 2：调 `responseDispositionDao.getResponseDispositionsByAlertIds` 从 MongoDB 获取威胁处置实体
3. **合并结果**：等待两个任务完成；若 MongoDB 结果为空直接返回 ES 结果；否则按 uuId 匹配，将威胁实体设置到对应告警的 `responseDisposition` 字段
4. **异常降级**：任一环节异常时记录警告日志，返回空列表（不返回 null、不抛错误响应）

## 数据一致性说明

- **入参时间戳为秒级（10 位 Long）**：startTime/endTime
- **返回时间戳为秒级（10 位 Long）**：firstTime/lastTime（经 `SecondTimestampDeserialize` 反序列化）
- **时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳**，算不出时标注"以实际调用时为准，秒级时间戳"，不允许凭空编数字

## 调用示例

### 示例 1：根据告警 ID 批量查询告警详情与威胁实体

```json
POST /api/xdr/v1/alerts/getAlertInfo
{
  "uuIds": ["3f8a2c10-9c1b-4a2e-8d3f-5e6a7b8c9d01"],
  "startTime": 1782499200,
  "endTime": 1783104000
}
```

> 注：示例时间戳按 2026-07-05 当前时间计算：2026-06-28 00:00:00 UTC ≈ 1782499200（秒级），2026-07-05 00:00:00 UTC ≈ 1783104000（秒级）。

返回示例：

```json
{
  "code": 200,
  "message": "success",
  "data": [
    {
      "uuId": "3f8a2c10-9c1b-4a2e-8d3f-5e6a7b8c9d01",
      "name": "永恒之蓝",
      "severity": 3,
      "moduleType": 94,
      "attackTypeId": 1,
      "attackSubTypeId": 1,
      "attackResult": 1,
      "gptResult": 110,
      "combineType": 1,
      "whiteStatus": "未加白",
      "firstTime": 1782499200,
      "lastTime": 1783104000,
      "hostIp": "10.0.0.50",
      "hostAssetId": 12,
      "hostAssetName": "web-server-01",
      "hostResponsible": "zhangsan",
      "hostBranchName": "研发中心",
      "hostCountryName": "中国",
      "hostProvinceName": "广东",
      "srcIps": ["192.168.1.1"],
      "srcIp": ["192.168.1.1"],
      "srcIpInfos": [{"ip": "192.168.1.1", "assetId": 1001}],
      "srcAssetIds": [1001],
      "dstIps": ["10.0.0.50"],
      "dstIp": ["10.0.0.50"],
      "dstIpInfos": [{"ip": "10.0.0.50", "assetId": 12}],
      "dstAssetIds": [12],
      "ips": ["8.8.8.8"],
      "xForwardedFor": [],
      "protocol": "TCP",
      "direction": 2,
      "httpUri": "/api/login",
      "reqMethod": "POST",
      "requestHead": "",
      "responseHead": "",
      "requestBody": "",
      "responseBody": "",
      "respStatus": 200,
      "packetData": "",
      "endPointCmds": ["whoami"],
      "processPathDetails": ["C:\\Windows\\system32\\cmd.exe"],
      "fileName": "malware.exe",
      "filePath": "C:\\temp\\malware.exe",
      "virusName": ["Trojan.GenericKD"],
      "virusType": "木马",
      "devUid": [2001],
      "devUId": [2001],
      "devSourceName": ["SIP-01"],
      "engineNames": ["IPS引擎"],
      "devices": [],
      "ruleIds": ["10001"],
      "traceBackId": [],
      "logIds": ["log-001"],
      "responseDisposition": {
        "md5s": ["e90afc86c7b1ab55e9dffa631cef0821"],
        "fileNames": ["malware.exe"],
        "dnsNames": ["malicious.example.com"]
      },
      "tiType": 1,
      "tiIntelligence": ""
    }
  ]
}
```

### 示例 2：错误请求——uuIds 传单个字符串（严禁）

```json
POST /api/xdr/v1/alerts/getAlertInfo
{
  "uuIds": "3f8a2c10-9c1b-4a2e-8d3f-5e6a7b8c9d01"
}
```

**报错**：Jackson `MismatchedInputException`（ Cannot deserialize value of type `java.util.ArrayList` from String value），反序列化失败。**正确传法必须为数组：`"uuIds": ["3f8a2c10-..."]`**。

## 使用注意事项

1. **uuIds 必须是 JSON 数组**：严禁传单个字符串；单个元素也用数组 `["xxx"]`
2. **uuIds 最多 100 个元素**：超过返回 400（"param uuId max size is 100"）；建议单次 20~50 个
3. **每个元素必须符合 UUID 格式**：非 UUID 格式返回 400 校验错误
4. **异常时返回空列表**：服务端任一查询异常时整体返回 `data: []`，不返回错误码，调用方需处理空列表场景
5. **时间戳均为秒级**：入参 startTime/endTime、返回 firstTime/lastTime 都是 10 位 Long
6. **deviceId 与 devUid 是同一数据的两个字段**：JSON 输出中 deviceId 序列化为 `devUId`（@JsonProperty），注意区分

## 关联接口

- `alert-getXenAlertId.md`：前置接口——由实体（资产ID/IP/XFF/DNS/MD5/外网IP）反向查关联告警 uuId 列表
- `alert-getEntityInfo.md`：由单个实体值（IP/域名/MD5）查实体情报上下文
- `alert-getXenEntity.md`：由告警 uuId 列表查告警关联实体（含 srcIpInfos/dstIpInfos、direction 等字段）
