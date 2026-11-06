# GET /api/xdr/v1/alerts/devUidName

## 接口概述

本接口用于获取XDR系统中所有数据源（设备）的名称与ID映射列表。通过本接口，您可以获取以下内容：

### 可查询的数据源信息
- **数据源名称**：产品类型（productType），如 sangfor、NSFOCUS 等
- **数据源编码**：设备展示类型（displayType），用于区分设备子类型
- **数据源ID**：设备唯一标识（devUid），用于在告警查询接口中作为 devUIds 过滤条件

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 数据源元数据查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询（devUIds 字段值来源于本接口返回的 value） |

## 使用场景

1. **数据源筛选下拉框**：在前端告警列表页面初始化时调用，加载所有可用数据源，供用户按数据源过滤告警
2. **告警查询参数构造**：调用告警列表接口前，先调用本接口获取 devUid 列表，将其作为 devUIds 参数过滤特定数据源的告警
3. **数据源资产管理**：盘点接入XDR系统的所有数据源设备，确认设备厂商和子类型
4. **告警来源分析**：结合告警的 devUidDesc 字段，反查告警来源于哪个数据源设备
5. **报表生成**：按数据源维度统计告警数量时，使用本接口获取完整的数据源列表

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/alerts/devUidName |
| Content-Type | 无（GET 请求无请求体） |
| 权限要求 | superAdmin、incidentQuery 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求**：Controller 接收 GET 请求，无需任何参数
2. **加载数据源缓存**：Service 层通过 `deviceCache.getDeviceInfoCache().getDisplayToInfoMap()` 获取内存中缓存的设备信息映射表（key=displayType，value=DeviceCacheInfo）
3. **遍历构造 VO**：遍历缓存中所有 DeviceCacheInfo，对每个设备构造一个 OpenApiDevUidNameResultVo：
   - name 字段 ← DeviceCacheInfo.productType（数据源产品类型，如 "sangfor"）
   - code 字段 ← DeviceCacheInfo.displayType（设备展示类型编码）
   - value 字段 ← DeviceCacheInfo.devUid（设备唯一标识）
4. **返回结果**：将构造好的 VO 列表封装到 OpenApiResponse 中返回

### 数据转换逻辑

- 数据来源：设备信息缓存（DeviceCacheInfo），由系统启动时加载并维护，非实时查询数据库
- 字段映射：DeviceCacheInfo.productType → VO.name；DeviceCacheInfo.displayType → VO.code；DeviceCacheInfo.devUid → VO.value

### 默认行为

- 无需任何请求参数，直接返回全量数据源列表
- 缓存为空时返回空列表（不会返回 null）

### 特殊规则

- 接口无入参校验逻辑
- 数据源信息来自系统内存缓存，不查询数据库，调用性能高
- 返回列表的顺序由 DisplayToInfoMap 的遍历顺序决定（HashMap 无固定顺序）

## 请求参数

### 请求头

无特殊请求头要求（标准 HTTP GET 请求）。

### 请求参数

无（GET 请求，无路径参数，无查询参数，无请求体）。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | array[OpenApiDevUidNameResultVo] | 数据源信息列表 |

### data 元素结构说明（来源：OpenApiDevUidNameResultVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| name | string | 数据源产品类型（设备厂商名称，来源 AnalysisProductTypeEnum 的国际化值） | sangfor、NSFOCUS、Topsec、Venus、Hillstone、QiAnXin、Chaitin、Cisco、Huawei、H3C、Microsoft 等 | "sangfor" |
| code | string | 设备展示类型编码（区分同一厂商下的不同设备子类型） | 设备配置数据，运行时确定 | "sangfor_edr" |
| value | integer | 数据源设备唯一标识（devUid），可作为告警查询接口 devUIds 字段的过滤值 | 正整数 | 2001 |

## 调用示例

### 示例1：获取所有数据源列表

**请求示例**：
```
GET /api/xdr/v1/alerts/devUidName
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": [
        {
            "name": "sangfor",
            "code": "sangfor_edr",
            "value": 2001
        },
        {
            "name": "sangfor",
            "code": "sangfor_sta",
            "value": 2002
        },
        {
            "name": "NSFOCUS",
            "code": "nsfocus_ips",
            "value": 3001
        },
        {
            "name": "Topsec",
            "code": "topsec_fw",
            "value": 4001
        }
    ]
}
```

### 示例2：空数据源场景（缓存为空时的响应）

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": []
}
```

### 示例3：错误响应示例

**权限不足响应示例**：
```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

- 本接口为无参数 GET 请求，无入参限制

### 参数依赖关系

- 无入参依赖

### 权限要求

- 需要 `superAdmin`、`incidentQuery` 或 `alertQuery` 三者之一权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin','incidentQuery','alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.alerts.getGptLogIds.log"）

### 性能建议

- 接口数据来自内存缓存，调用性能高，可频繁调用
- 数据源信息更新频率低，可在前端做适度缓存（如 5 分钟），避免重复请求

### 数据一致性说明

- 数据源信息来源于系统启动时加载的设备缓存（DeviceCacheInfo），非实时查询数据库，因此新增数据源后需等待缓存刷新才能在本接口返回
- name 字段为 productType，与告警列表接口 `productType` 过滤参数的取值范围一致
- value 字段为 devUid，与告警列表接口 `devUIds` 过滤参数的取值范围一致
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字（本接口不涉及时间戳）

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin、incidentQuery 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端执行异常（如设备缓存未初始化） | 联系技术支持，检查系统启动状态 |

## 最佳实践

1. **首次使用建议**
   - 直接调用本接口获取全量数据源列表
   - 验证权限配置是否正确

2. **配合告警查询使用**
   - 调用本接口获取数据源列表后，将 value 字段作为告警查询接口 `devUIds` 参数的过滤值
   - 将 name 字段作为告警查询接口 `productType` 参数的过滤值（按厂商过滤）

3. **前端缓存策略**
   - 数据源信息更新频率低，建议前端缓存 5~10 分钟
   - 避免每次告警查询前都调用本接口

4. **数据源识别**
   - name（productType）相同但 code（displayType）不同的设备属于同一厂商的不同子类型
   - 例如 sangfor 厂商下可能有 EDR、STA、AF 等多种设备子类型

5. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功，其他为失败
   - 403 错误需联系管理员添加权限，不可重试
   - 500 错误建议短暂间隔后重试，可能是系统启动未完成导致缓存未初始化
