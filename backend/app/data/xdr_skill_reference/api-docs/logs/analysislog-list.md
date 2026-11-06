# POST /api/xdr/v1/analysislog/list

## 接口概述

本接口用于分页查询流量审计日志（TCP 日志）明细列表，返回符合条件的日志详细字段。通过本接口，您可以获取以下内容：

### 可查询的日志信息
- **日志标识**：日志 UUID（uuId）
- **网络信息**：源 IP（srcIp）、源端口（srcPort）、目的 IP（dstIp）、目的端口（dstPort）、目的资产类型（dstType）
- **时间信息**：记录时间（recordTimestamp，秒级时间戳）

### 可过滤的查询维度
- **时间范围**：startTimestamp / endTimestamp（秒级）
- **设备维度**：上报设备（productType）
- **日志类型**：logType（必填，目前仅支持 tcp）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Controller | OpenApiAnalysisController |
| 所属业务域 | 流量审计日志开放性接口（analysislog） |
| 接口分类 | 流量审计日志列表查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/analysislog/count` 设备数量与日志量统计、`/api/xdr/v1/analysislog/trends` 日志趋势统计 |

## 使用场景

1. **TCP 日志明细查询**：根据时间范围分页查询 TCP 日志明细，用于安全运营中心展示
2. **设备日志监控**：按 productType 过滤查询特定设备的 TCP 日志，监控设备上报情况
3. **网络流量调查**：按时间范围查询 TCP 日志的源/目的 IP/端口信息，用于网络流量调查
4. **趋势辅助**：配合 trends 接口使用，先通过 list 接口查看明细，再分析趋势
5. **配合 count 接口分页**：先调用 count 接口获取总数，再调用本接口分页查询明细

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/analysislog/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 incidentQuery 或 alertQuery（三者任一） |

## 业务逻辑

### 核心处理流程

1. **Controller 层时间补全**：调用 `OpenApiTimeRangeUtil.resolveTimestamp(startTimestamp, endTimestamp)` 规范化时间戳：
   - startTimestamp 为空 → 默认取最近 7 天（`LocalDateTime.now().minusDays(7)`，转秒级）
   - endTimestamp 为空 → 默认取今天结束时间（`LocalDate.now().atTime(LocalTime.MAX)`，转秒级）
   - 回写到 QO 的 startTimestamp / endTimestamp 字段
2. **Service 层日志记录**：`log.info("query audit logs, query criteria: {}", qo)` 记录查询条件
3. **构造分页结果对象**：创建 `OpenApiPageResult<AnalysisLogVo>`，设置 page 和 pageSize
4. **计算分页偏移量**：`openApiAnalysisQo.setPage((page - 1) * pageSize)`（将 page 转为 offset）
5. **地域过滤上下文**：通过 `RegionFilterUtil.getUserRegionId()` 获取当前用户可见的地域 ID 列表，`RegionFilterUtil.allRegionValid()` 判断是否具备全地域权限
6. **查询总数**：调用 `tcpLogMapper.getTotal(qo, regionIds, isAllRegion)` 获取符合条件的日志总数
7. **空结果处理**：若 total < 1，直接返回空分页结果
8. **查询明细**：调用 `tcpLogMapper.queryList(qo, regionIds, isAllRegion)` 执行分页查询
9. **DTO → VO 转换**：遍历 `List<TcpLog>`，通过 `BeanUtils.copyProperties(tcp, vo)` 拷贝同名字段到 `AnalysisLogVo`，加入返回列表
10. **构造返回**：返回 `OpenApiResponse<OpenApiPageResult<AnalysisLogVo>>`，含 page、pageSize、total、item 列表

### 数据转换逻辑

- **TcpLog → AnalysisLogVo**：通过 `BeanUtils.copyProperties(tcp, vo)` 拷贝同名字段
- 拷贝的字段：srcIp、srcPort、dstIp、dstPort、dstType、uuId、recordTimestamp
- recordTimestamp 为秒级 Long，无单位转换

### 默认行为

- 不指定时间范围时默认查最近 7 天
- endTimestamp 未指定时默认取今天结束时间（23:59:59）
- page 默认值 1，pageSize 默认值 5
- 不指定任何过滤条件时返回时间范围内全部 TCP 日志的分页明细
- total < 1 时直接返回空 item 列表

### 特殊规则

- **logType 必填**：必须传 logType 字段，目前仅支持 `tcp`（来源 AnalysisLogTypeEnum）
- **productType 校验**：每个元素需为 AnalysisProductTypeEnum 合法值（如 sangfor / STA 等），元素数量 1~200
- **地域权限过滤**：根据当前用户的地域权限自动过滤可见数据，无全地域权限的用户只能查询其有权限的地域数据
- **分页参数**：page 最小 1，pageSize 取值范围 5~200
- **page → offset 转换**：Service 层将 page 转为 offset（(page - 1) * pageSize）传给 Mapper

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| page | integer | 否 | 1 | 页码，最小 1 | 1 |
| pageSize | integer | 否 | 5 | 每页大小，5~200 | 20 |
| startTimestamp | long | 否 | 最近 7 天 | 查询开始时间戳，秒级（10 位 Long） | 1782576000 |
| endTimestamp | long | 否 | 今天结束 | 查询结束时间戳，秒级（10 位 Long） | 1783180800 |
| productType | array[string] | 否 | - | 上报设备列表，1~200 个元素，每个元素需为 AnalysisProductTypeEnum 合法值（如 sangfor / STA / NSFOCUS 等） | ["STA"] |
| logType | string | 是 | - | 日志类型（AnalysisLogTypeEnum）。目前仅支持 tcp | "tcp" |

**logType 枚举值说明**（来源：AnalysisLogTypeEnum）：

| 枚举值 | 说明 |
|--------|------|
| tcp | TCP 日志（目前仅支持此值） |

**productType 常见枚举值说明**（来源：AnalysisProductTypeEnum）：

| 常见值 | 厂商 |
|--------|------|
| sangfor | 深信服 |
| linux | Linux 系统 |
| NSFOCUS | 绿盟 |
| Topsec | 天融信 |
| Venus | 启明星辰 |
| Hillstone | 山石网科 |
| QiAnXin | 奇安信 |
| Chaitin | 长亭科技 |
| Cisco | 思科 |
| Huawei | 华为 |
| H3C | 新华三 |
| Microsoft | 微软 |
| 其他 | 其他厂商（完整列表参考 AnalysisProductTypeEnum） |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | OpenApiPageResult<AnalysisLogVo> | 响应数据，见下方结构说明 |

### OpenApiPageResult 结构说明

| 参数名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| total | long | 满足条件的总记录数 | 12580 |
| page | integer | 当前页码 | 1 |
| pageSize | integer | 每页大小 | 20 |
| item | array[AnalysisLogVo] | TCP 日志记录列表，见下方 item 元素结构说明 | 见下方 |

### item 元素结构说明（来源：AnalysisLogVo）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| srcIp | string | 源 IP | "192.168.1.100" |
| srcPort | integer | 源端口 | 54321 |
| dstIp | string | 目的 IP | "10.0.0.50" |
| dstPort | integer | 目的端口 | 80 |
| dstType | integer | 目的资产类型 | 1 |
| uuId | string | 日志唯一 ID | "log-abc123" |
| recordTimestamp | long | 记录时间（秒级时间戳） | 1783180800 |

## 调用示例

### 示例 1：基础查询 - 查询最近 7 天 TCP 日志

**请求示例**：
```json
{
    "logType": "tcp",
    "page": 1,
    "pageSize": 20
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 12580,
        "page": 1,
        "pageSize": 20,
        "item": [
            {
                "srcIp": "192.168.1.100",
                "srcPort": 54321,
                "dstIp": "10.0.0.50",
                "dstPort": 80,
                "dstType": 1,
                "uuId": "log-abc123",
                "recordTimestamp": 1783180800
            }
        ]
    }
}
```

### 示例 2：精确时间范围查询

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "logType": "tcp",
    "page": 1,
    "pageSize": 50
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 8421,
        "page": 1,
        "pageSize": 50,
        "item": [
            {
                "srcIp": "192.168.1.100",
                "srcPort": 54321,
                "dstIp": "10.0.0.50",
                "dstPort": 80,
                "dstType": 1,
                "uuId": "log-def456",
                "recordTimestamp": 1783180000
            }
        ]
    }
}
```

### 示例 3：按设备过滤查询

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "productType": ["STA", "sangfor"],
    "logType": "tcp",
    "page": 1,
    "pageSize": 20
}
```

### 示例 4：分页查询 - 第 2 页

**请求示例**：
```json
{
    "startTimestamp": 1782576000,
    "endTimestamp": 1783180800,
    "logType": "tcp",
    "page": 2,
    "pageSize": 20
}
```

### 示例 5：空结果响应

**请求示例**：
```json
{
    "startTimestamp": 1783180800,
    "endTimestamp": 1783180800,
    "logType": "tcp",
    "page": 1,
    "pageSize": 20
}
```

**响应示例**（无数据时）：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 0,
        "page": 1,
        "pageSize": 20,
        "item": null
    }
}
```

### 示例 6：错误响应示例 - 缺少 logType

**请求示例**：
```json
{
    "page": 1,
    "pageSize": 20
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param logType is invalid value.",
    "data": null
}
```

### 示例 7：错误响应示例 - 无效 logType

**请求示例**：
```json
{
    "logType": "invalid_type",
    "page": 1,
    "pageSize": 20
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param logType is invalid value.",
    "data": null
}
```

### 示例 8：错误响应示例 - 无效分页参数

**请求示例**：
```json
{
    "logType": "tcp",
    "page": 0,
    "pageSize": 1
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param page min size is 1; param pageSize min is 5",
    "data": null
}
```

### 示例 9：错误响应示例 - productType 元素数量超限

**请求示例**：
```json
{
    "logType": "tcp",
    "productType": []
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param productType size min is 1, max is 200",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **必填参数**
   - logType：必须传，目前仅支持 `tcp`（来源 AnalysisLogTypeEnum）

2. **分页限制**
   - page 最小 1
   - pageSize 取值范围 5~200

3. **productType 限制**
   - 元素数量 1~200
   - 每个元素需为 AnalysisProductTypeEnum 合法值

4. **时间范围**
   - startTimestamp / endTimestamp 为秒级（10 位 Long）
   - 不指定时默认查最近 7 天

### 参数依赖关系

1. **logType 决定查询表**
   - logType=tcp 时查询 ClickHouse 的 tcp_log 表
   - 目前仅支持 tcp，其他日志类型暂未开放对应接口

2. **productType 与日志类型关系**
   - productType 为上报设备厂商列表，与 logType 配合使用
   - 不同厂商可能上报不同类型的日志

### 权限要求

- 需要 `superAdmin` 或 `incidentQuery` 或 `alertQuery` 三者任一权限
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.analysisLog.log"）

### 性能建议

1. **合理设置时间范围**
   - 时间范围过大可能导致查询超时
   - 建议单次查询时间范围不超过 7 天

2. **合理设置分页大小**
   - pageSize 不建议设置为最大值 200，通常 20-50 为宜
   - 大量数据返回可能导致响应延迟

3. **配合 count 接口使用**
   - 先调用 `/api/xdr/v1/analysislog/count` 获取总数
   - 再调用本接口分页查询明细
   - 避免反复请求验证数据量

4. **避免过多过滤条件**
   - 过滤条件越多，查询复杂度越高
   - 合理组合过滤条件，避免冗余

### 数据一致性说明

- 入参与返回时间戳均为秒级（10 位 Long）。
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档基于当前日期 2026-07-05 计算：
  - 2026-07-05 00:00:00 UTC = 1783180800（秒级）
  - 2026-06-28 00:00:00 UTC = 1782576000（秒级，7 天前）
  - 调用时请使用 `Math.floor(Date.now() / 1000)` 计算当前秒级时间戳。
- Service 层使用 `OpenApiTimeRangeUtil.resolveTimestamp` 将空值时间补全为秒级，无毫秒/秒级转换。
- 数据存储于 ClickHouse，时间字段为秒级 Long。
- DTO → VO 通过 `BeanUtils.copyProperties` 拷贝同名字段。
- Service 层将 page（页码）转换为 offset（(page - 1) * pageSize）传给 Mapper，返回结果中 page 仍为页码。

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param page min size is 1 | page 参数小于 1 | 设置 page >= 1 |
| 400 | param pageSize min is 5 | pageSize 参数小于 5 | 设置 pageSize >= 5 |
| 400 | param pageSize max is 200 | pageSize 参数大于 200 | 设置 pageSize <= 200 |
| 400 | param logType is invalid value. | logType 为空或非 AnalysisLogTypeEnum 合法值 | 使用 tcp（目前仅支持此值） |
| 400 | param productType is invalid value. | productType 元素非 AnalysisProductTypeEnum 合法值 | 使用合法厂商名称 |
| 400 | param productType size min is 1, max is 200 | productType 元素数量不在 1~200 之间 | 调整元素数量在 1~200 之间 |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin / incidentQuery / alertQuery 权限 |
| 500 | exception.method.execute | 服务端查询执行异常 | 联系技术支持，检查 ClickHouse 集群状态 |

## 最佳实践

1. **首次使用建议**
   - 先使用小范围时间（如最近 1 小时）和小分页（pageSize=5）测试接口
   - 确认返回数据格式和字段含义后再扩大查询范围
   - 验证权限配置是否正确

2. **配合 count 接口使用**
   - 先调用 `/api/xdr/v1/analysislog/count` 获取符合条件的日志总数
   - 根据总数决定本接口的分页策略
   - 避免反复请求验证数据量

3. **时间范围设置**
   - 日常监控场景建议使用最近 24 小时或 7 天的时间范围
   - 历史回溯场景可按天分批查询
   - 不指定时间范围时默认为最近 7 天

4. **logType 选择**
   - 本接口仅支持 tcp 日志查询
   - 趋势统计请使用 `/api/xdr/v1/analysislog/trends` 接口

5. **productType 过滤**
   - 已知设备厂商时可使用 productType 缩小查询范围
   - 不指定时返回所有厂商的日志

6. **错误处理与重试**
   - 解析响应时首先检查 code 字段，"Success" 为成功，其他为失败
   - 500 错误可能为 ClickHouse 集群异常，建议短暂间隔后重试
   - 403 错误需联系管理员添加权限，不可重试
