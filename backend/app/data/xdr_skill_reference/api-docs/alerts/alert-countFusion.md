# POST /api/xdr/v1/alerts/countFusion

## 接口概述

本接口用于统计融合后的安全告警数量，按时间范围 + 时间字段过滤，返回融合后告警数、多源关联告警数、原始日志数量三项指标。通过本接口，您可以获取以下内容：

### 可查询的统计指标
- **融合后告警数**：fusionAlertCount（融合后的告警总数）
- **多源关联告警数**：multiSourceAssociateAlertCount（多源关联产生的告警数）
- **原始日志数量**：originLogCount（原始日志总数）

### 可过滤的维度
- **时间范围**：startTimestamp/endTimestamp（秒级 Long）
- **时间字段**：timeField（决定时间范围过滤的字段）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 告警统计 - 融合告警数 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/alerts/list` 告警列表、`/api/xdr/v1/alerts/aggregation` 告警聚合 |

## 使用场景

1. **融合告警数监控**：统计融合后的告警总数，用于大屏展示或报表
2. **多源关联告警占比分析**：对比 multiSourceAssociateAlertCount 与 fusionAlertCount，分析多源关联告警占比
3. **原始日志数量统计**：统计原始日志数量，用于数据量监控
4. **融合效果评估**：对比融合后告警数与原始日志数量，评估告警融合的降噪效果
5. **配合告警列表/聚合接口**：先调本接口获取整体统计，再调 `/alerts/list` 或 `/alerts/aggregation` 查明细或分组统计

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/countFusion |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Valid + Service 层）：
   - Controller 通过 `OpenApiTimeRangeUtil.resolveTimestamp` 处理时间范围，未传时按默认规则补全
   - QO 字段校验（@NotNull/@Enum）
2. **构建内部 QO**：
   - 创建 `FusionAlertQo` 内部对象
   - 创建 `Time beginTime`，type 设为 `TimeTypeEnum.ABSOLUTE.getValue()`，value 设为 `startTimestamp`
   - 创建 `Time endTime`，type 设为 `TimeTypeEnum.ABSOLUTE.getValue()`，value 设为 `endTimestamp`
   - 设置 `fusionAlertQo.setBegin(beginTime)` 和 `fusionAlertQo.setEnd(endTime)`
   - 设置 `fusionAlertQo.setTimeField(timeField)`
3. **调用统计**：调用 `alertService.countFusionAlerts(fusionAlertQo)` 查询融合告警统计，返回 `FusionAlertVo`（含 fusionAlertCount、multiSourceAssociateAlertCount、originLogCount）
4. **结果转换**：`BeanUtils.copyProperties(fusionAlertVo, openApiAlertCountFusionVo)` 拷贝字段
5. **异常处理**：DAO 异常时抛 `exception.method.execute`
6. **返回**：封装为 `OpenApiResponse<OpenApiAlertCountFusionVo>`

### 数据转换逻辑

- `FusionAlertVo` → `OpenApiAlertCountFusionVo`：BeanUtils.copyProperties 拷贝 fusionAlertCount、multiSourceAssociateAlertCount、originLogCount
- `OpenApiAlertCountFusionVo` 字段默认值为 0L（避免 null）
- 时间单位：入参秒级 Long，传给 `alertService.countFusionAlerts` 时按 TimeTypeEnum.ABSOLUTE 处理

### 默认行为
- `startTimestamp` / `endTimestamp` 未传时由 Controller `OpenApiTimeRangeUtil.resolveTimestamp` 处理（取最近 7 天）
- `OpenApiAlertCountFusionVo` 各字段默认值为 0L

### 特殊规则
- `startTimestamp`/`endTimestamp` 必传
- `timeField` 必传，必须在 AlertTimeFieldTypeEnum 枚举内
- DAO 异常时抛 `exception.method.execute`，不返回部分结果

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| startTimestamp | long | 是 | - | 起始时间戳（秒级，10 位 Long）。未传时由 Controller 取最近 7 天 | 1782604800 |
| endTimestamp | long | 是 | - | 结束时间戳（秒级，10 位 Long）。未传时由 Controller 取当前时间 | 1783209600 |
| timeField | string | 是 | - | 过滤的时间字段，取值见 AlertTimeFieldTypeEnum 枚举表 | "lastTime" |

#### timeField 枚举（AlertTimeFieldTypeEnum，参考 enum-dictionary.md）

| 取值 | 说明 |
|------|------|
| firstTime | 首次发现时间 |
| lastTime | 最近发生时间 |
| updateTime | 更新时间 |
| dealTime | 处置时间 |
| occurTime | 发生时间 |
| uploadTime | 上传时间 |
| _insertTime | 入库时间 |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（OpenApiAlertCountFusionVo） |

### data 结构说明（OpenApiAlertCountFusionVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| fusionAlertCount | long | 融合后告警数（默认 0L） | - | 1234 |
| multiSourceAssociateAlertCount | long | 多源关联告警数（默认 0L） | - | 567 |
| originLogCount | long | 原始日志数量（默认 0L） | - | 89012 |

## 调用示例

### 示例1：查询最近 7 天的融合告警统计

**请求示例**：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "fusionAlertCount": 1234,
    "multiSourceAssociateAlertCount": 567,
    "originLogCount": 89012
  }
}
```

### 示例2：查询最近 30 天的融合告警统计

**请求示例**：
```json
{
  "startTimestamp": 1780617600,
  "endTimestamp": 1783209600,
  "timeField": "lastTime"
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "fusionAlertCount": 5678,
    "multiSourceAssociateAlertCount": 2345,
    "originLogCount": 456789
  }
}
```

### 示例3：错误响应 - startTimestamp 未传

**请求示例**（缺必填字段）：
```json
{
  "endTimestamp": 1783209600,
  "timeField": "lastTime"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "startTimestamp不能为空",
  "data": null
}
```

### 示例4：错误响应 - timeField 非法

**请求示例**（timeField 不在枚举）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "invalidField"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "param timeField is invalid value.",
  "data": null
}
```

### 示例5：错误响应 - DAO 异常

**请求示例**（DAO 执行异常时）：
```json
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime"
}
```

**错误响应示例**：
```json
{
  "code": "InternalError",
  "message": "方法执行异常",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `startTimestamp`/`endTimestamp`：秒级 Long
- `timeField`：必须在 AlertTimeFieldTypeEnum 枚举内

### 参数依赖关系
- `startTimestamp` 和 `endTimestamp` 必传
- `timeField` 必传，决定时间范围过滤的字段

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- 时间范围建议 ≤ 30 天，避免长范围查询影响响应速度
- 本接口为统计接口，建议按大屏/报表需求周期性调用，不需高频调用

### 数据一致性说明
- 入参与返回时间戳均为秒级（10 位 Long）
- 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字。本文档示例以 2026-07-05 为当前日期：7 天前 = 1782604800，30 天前 = 1780617600，当前 = 1783209600
- `OpenApiAlertCountFusionVo` 各字段默认值为 0L，避免 null 序列化
- 统计数为 long 类型，可能为大整数

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.method.execute | DAO 执行异常 | 检查参数格式和时间范围 |
| 400 | startTimestamp不能为空 | startTimestamp 未传 | 必传 startTimestamp |
| 400 | endTimestamp不能为空 | endTimestamp 未传 | 必传 endTimestamp |
| 400 | param timeField is invalid value. | timeField 不在 AlertTimeFieldTypeEnum | 使用枚举值（firstTime/lastTime 等） |

## 最佳实践

1. **timeField 选择**：默认 lastTime（最近发生时间），如需查首次发生用 firstTime
2. **时间范围优化**：建议查询 ≤ 30 天数据，避免长范围查询影响响应速度
3. **融合效果评估**：对比 fusionAlertCount 与 originLogCount，评估告警融合的降噪效果（如原始日志 89012 → 融合后 1234，降噪率约 98.6%）
4. **多源关联占比分析**：对比 multiSourceAssociateAlertCount 与 fusionAlertCount，分析多源关联告警占比
5. **配合告警列表/聚合接口**：先调本接口获取整体统计，再调 `/alerts/list` 或 `/alerts/aggregation` 查明细或分组统计
6. **周期性调用**：本接口为统计接口，建议按大屏/报表需求周期性调用（如每小时/每天），不需高频调用
