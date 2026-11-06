# POST /api/xdr/v1/alerts/dealstatus/list

## 接口概述

本接口用于根据告警 UUID 列表批量查询告警处置状态，最多支持 200 个 UUID，每个 UUID 须符合 UUID 字符格式。通过本接口，您可以获取以下内容：

### 可查询的告警处置状态信息
- **告警 UUID**：uuId（与请求中的 UUID 对应）
- **处置状态**：dealStatus（1-待处置 / 2-处置中 / 3-处置完成 / 6-已遏制，参考 DealStatusEnum）

### 批量查询限制
- 最多 200 个 UUID
- 每个 UUID 须符合 UUID 字符格式（UUID_CHAR_PARTTERN）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 告警查询 - 处置状态批量查询 |
| 前置依赖 | 需先调用 `/api/xdr/v1/alerts/list` 获取告警 uuId |
| 关联接口 | `/api/xdr/v1/alerts/list` 告警列表（获取 uuId）、`/api/xdr/v1/alerts/dealstatus` 批量更新处置状态 |

## 使用场景

1. **批量查询告警处置状态**：根据告警 UUID 列表批量查询处置状态，用于前端展示告警处置进度
2. **告警状态同步**：获取告警处置状态，用于与其他系统（如工单系统、SIEM）同步告警处理进度
3. **配合告警列表接口**：先调 `/alerts/list` 获取告警 uuId，再调本接口批量查询处置状态
4. **配合批量更新处置状态**：先调本接口查询当前处置状态，再调 `/alerts/dealstatus` 批量更新


## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/dealstatus/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Validated + @NotNull + @Size + @StrCollectionValidate）：
   - `uuIds` 必传（@NotNull）
   - `uuIds` 最多 200 个元素（@Size(max = 200)）
   - 每个 UUID 须符合 `CommonConstants.VerifyConstants.UUID_CHAR_PARTTERN` 正则（@StrCollectionValidate）
2. **查询 ES**：调用 `alertDao.getDealStatusByIds(ids)` 按 UUID 列表查询告警处置状态，返回 `List<Alert>`（含 uuId + dealStatus）
3. **结果转换**：
   - 查询结果为空时返回空列表（`List.of()`），打警告日志
   - 遍历 `alerts`，每个 alert 转换为 `OpenApiDealStatusVo(alert.getUuId(), alert.getDealStatus())`
4. **封装返回**：组装 `IncidentEntityResult<OpenApiDealStatusVo>`，含 item 列表
5. **异常处理**：DAO 异常时抛 `exception.method.execute`

### 数据转换逻辑

- `Alert` → `OpenApiDealStatusVo`：取 `uuId` 和 `dealStatus` 两个字段
- 查询结果为空时返回空列表（不返回 null）

### 默认行为
- 查询结果为空时返回空列表（item 为空数组）
- 查询不到的 UUID 不会出现在结果中

### 特殊规则
- `uuIds` 必传，最多 200 个元素
- 每个 UUID 须符合 UUID_CHAR_PARTTERN 正则
- 查询不到的 UUID 不会出现在结果中（结果数 ≤ 请求数）
- DAO 异常时抛 `exception.method.execute`

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

请求体为 `array[string]`，直接是 UUID 列表（非对象包裹）。

| 参数名 | 类型 | 必填 | 取值范围/说明 | 示例值 |
|--------|------|------|---------------|--------|
| (请求体) | array[string] | 是 | 告警 UUID 列表，最多 200 个元素，每个 UUID 须符合 UUID_CHAR_PARTTERN 正则 | ["alert-123456","alert-789012"] |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（IncidentEntityResult<OpenApiDealStatusVo>） |

### data 结构说明（IncidentEntityResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[object] | 安全事件实体列表，结构见下方 OpenApiDealStatusVo 子结构表 |

### item 元素结构说明（OpenApiDealStatusVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| uuId | string | 告警事件 ID | - | "alert-123456" |
| dealStatus | integer | 处置状态（DealStatusEnum，参考 enum-dictionary.md） | 1-待处置/2-处置中/3-处置完成/6-已遏制 | 1 |

#### dealStatus 枚举（DealStatusEnum，参考 enum-dictionary.md）

| 取值 | 枚举常量名 | 国际化值（中文） |
|-------|-----------|----------------|
| 1 | PENDING | 待处置 |
| 2 | DISPOSING | 处置中 |
| 3 | DISPOSED | 处置完成 |
| 6 | SUPPRESSED | 已遏制 |

## 调用示例

### 示例1：批量查询告警处置状态

**请求示例**：
```json
["alert-123456", "alert-789012", "alert-345678"]
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"uuId": "alert-123456", "dealStatus": 1},
      {"uuId": "alert-789012", "dealStatus": 3},
      {"uuId": "alert-345678", "dealStatus": 2}
    ]
  }
}
```

### 示例2：查询结果为部分匹配（部分 UUID 不存在）

**请求示例**：
```json
["alert-123456", "nonexistent-uuid", "alert-789012"]
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": [
      {"uuId": "alert-123456", "dealStatus": 1},
      {"uuId": "alert-789012", "dealStatus": 3}
    ]
  }
}
```

### 示例3：查询结果为空（所有 UUID 都不存在）

**请求示例**：
```json
["nonexistent-uuid1", "nonexistent-uuid2"]
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "item": []
  }
}
```

### 示例4：错误响应 - uuIds 为空

**请求示例**（请求体为空数组）：
```json
[]
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "uuIds不能为空",
  "data": null
}
```

### 示例5：错误响应 - UUID 数量超 200

**请求示例**（UUID 数量 > 200）：
```json
["uuid1", "uuid2", "...", "uuid201"]
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "数量超过200",
  "data": null
}
```

### 示例6：错误响应 - UUID 格式非法

**请求示例**（含非法字符的 UUID）：
```json
["alert-123456", "invalid@uuid"]
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "UUID格式不合法",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `uuIds`：必传，最多 200 个元素
- 每个 UUID 须符合 UUID_CHAR_PARTTERN 正则

### 参数依赖关系
- `uuIds` 必传，每个元素须符合 UUID 字符格式

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `uuIds` 数量建议 ≤ 100，过多会增加 ES 查询开销
- 本接口为批量查询，建议按需调用，不需高频调用

### 数据一致性说明
- 本接口无时间戳字段
- 查询不到的 UUID 不会出现在结果中（结果数 ≤ 请求数）
- `dealStatus` 为 DealStatusEnum 的 statusCode（1/2/3/6），参考 enum-dictionary.md
- DAO 异常时抛 `exception.method.execute`，不返回部分结果

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 500 | exception.method.execute | DAO 执行异常 | 检查 UUID 格式和数量 |
| 400 | uuIds不能为空 | uuIds 未传或为空 | 必传 uuIds（非空数组） |
| 400 | 数量超过200 | uuIds 元素数 > 200 | 减少 uuIds 数量至 ≤ 200 |
| 400 | UUID格式不合法 | uuIds 含不符合 UUID_CHAR_PARTTERN 的元素 | 每个 UUID 须符合 UUID 字符格式 |

## 最佳实践

1. **uuIds 来源**：先调 `/api/xdr/v1/alerts/list` 获取告警 uuId，再调本接口批量查询处置状态
2. **批量查询优化**：建议单次查询 ≤ 100 个 UUID，避免过多导致 ES 查询变慢
3. **结果处理**：查询不到的 UUID 不会出现在结果中，调用方需自行处理缺失的 UUID
4. **配合批量更新处置状态**：先调本接口查询当前处置状态，再调 `/alerts/dealstatus` 批量更新
5. **dealStatus 解读**：1-待处置 / 2-处置中 / 3-处置完成 / 6-已遏制，参考 enum-dictionary.md 的 DealStatusEnum
6. **请求体格式**：请求体直接是 UUID 列表（array[string]），非对象包裹
