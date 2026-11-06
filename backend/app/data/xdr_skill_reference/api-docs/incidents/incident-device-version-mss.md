# GET /api/xdr/v1/incidents/device_version_mss

## 接口概述

本接口用于查询当前 XDR 设备的 MSS 版本号与服务类型（SaaS XDR / Local XDR），支撑 MSS 客户端版本协商与服务类型识别场景。通过本接口，您可以获取/操作以下内容：

### 可查询的设备 MSS 信息
- **版本号**：当前 XDR 设备的 MSS 版本（version，来源 `ngsoc.deviceMssVersion` 配置，默认 10000）
- **服务类型**：当前 XDR 部署形态（serverType，saas_xdr 或 local_xdr，依据 License 判定）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiIncidentController |
| 所属业务域 | 开放性接口（安全事件） |
| 接口分类 | 设备 MSS 版本查询 |
| 前置依赖 | 无（可直接调用，需 superAdmin 权限） |
| 关联接口 | `/incidents/reject` MSS 驳回忽略事件 |

## 使用场景

1. **MSS 客户端版本协商**：MSS 客户端启动时查询服务端 MSS 版本，判断是否需要升级
2. **服务类型识别**：判断当前 XDR 是 SaaS 部署还是 Local 部署，决定调用哪类 MSS 接口
3. **运维巡检**：巡检脚本查询设备 MSS 版本，确认版本一致性
4. **MSS 协同前置**：调用其他 MSS 接口前先确认版本与服务类型

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/incidents/device_version_mss |
| Content-Type | application/json |
| 权限要求 | superAdmin |

## 业务逻辑

### 核心处理流程

1. Controller 接收 GET 请求（无入参）
2. 构造 `Map<String, Object>`，填入：
   - `version` ← `deviceMssVersion` 字段（来源 `@Value("${ngsoc.deviceMssVersion:10000}")`，默认 10000）
   - `serverType` ← 根据 `licenseInfoService.ifLicenseInfoIsSaas()` 判断：返回 true 时为 `IncidentCommonConstants.SAAS_XDR`，否则为 `IncidentCommonConstants.LOCAL_XDR`
3. 通过 `OpenApiResponse.newInstance(data)` 返回标准 OpenApiResponse
4. Controller 返回 `OpenApiResponse`

### 数据转换逻辑
- `deviceMssVersion`：从 Spring `@Value` 注入，默认 10000
- `serverType`：通过 License 服务判断 SaaS/Local，映射为 `SAAS_XDR`/`LOCAL_XDR` 常量字符串

### 默认行为
- `version` 默认 10000（`ngsoc.deviceMssVersion` 配置未设置时）
- `serverType` 根据 License 自动判断

### 特殊规则
- 仅 `superAdmin` 权限可调用（注意：本接口无 incidentQuery 权限，比其他接口严格）
- 接口无入参，无请求体
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.mss.deviceVersionMss.log"）

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 否 | GET 请求无需请求体 |

### 请求参数
无（GET 请求，无路径参数与查询参数）

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据 |

### data 结构说明

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| version | integer | 当前 XDR 设备的 MSS 版本号 | 默认 10000 | 10000 |
| serverType | string | 服务类型（部署形态） | SAAS_XDR / LOCAL_XDR | "local_xdr" |

### 示例响应

```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "version": 10000,
        "serverType": "local_xdr"
    }
}
```

## 调用示例

### 示例1：查询设备 MSS 版本

**请求示例**：
```
GET /api/xdr/v1/incidents/device_version_mss
```

### 示例2：权限不足

**错误响应示例**：
```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制
- 无入参

### 权限要求
- 仅 `superAdmin` 权限可调用（无 incidentQuery）
- 接口会记录操作日志（target="operate.openapi.log"，action="operate.openapi.mss.deviceVersionMss.log"）

### 使用注意事项
- **version 默认 10000**：若 `ngsoc.deviceMssVersion` 配置未设置，version 返回默认值 10000
- **serverType 判定**：serverType 通过 License 服务判断 SaaS/Local，需 License 服务可用
- **@ApiOperation 复用**：Controller 上 `@ApiOperation(value = "统一MSS事件消息接收接口")` 与统一 MSS 消息接收接口相同，是源码中的复制粘贴，实际语义为"查询设备 MSS 版本"

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）；本接口无时间戳字段
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access Denied | 权限不足（非 superAdmin） | 联系管理员添加 superAdmin 权限 |
| 500 | internal error | 服务端异常（如 License 服务不可用） | 联系技术支持 |

## 最佳实践

1. **MSS 协同前置调用**：调用 MSS 驳回接口（reject）前先调本接口确认版本与服务类型
2. **版本一致性检查**：MSS 客户端比对 version 与本地版本，判断是否需要升级
3. **服务类型分发**：serverType=SAAS_XDR 时走 SaaS 流程，LOCAL_XDR 时走 Local 流程
4. **超时设置**：本接口响应较小，超时设置 5s 即可
