# POST /api/xdr/v1/alerts/dealstatus

## 接口概述

本接口用于批量更新安全告警的处置状态，支持批量 uuId（最多 200 个）+ 处置状态 + 处置备注 + 是否自动处置标志。所有手动修改处置状态的动作均标记为"手动标记"（MANUAL_MARKING）。通过本接口，您可以操作以下内容：

### 可更新的告警处置信息
- **告警 UUID 列表**：uuIds（最多 200 个，每个须符合 UUID 字符格式）
- **处置状态**：dealStatus（1-待处置 / 2-处置中 / 3-处置完成 / 6-已遏制，参考 DealStatusEnum）
- **处置备注**：dealComment（最长 2048 字符，须符合 LEGAL_CHAR_PATTERN）
- **是否自动处置**：isAutoDo（默认 false）

### 返回的更新结果
- **更新事件总数**：total（成功 + 失败）
- **更新成功的事件数**：succeededNum

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 告警处置 - 批量更新处置状态 |
| 前置依赖 | 需先调用 `/api/xdr/v1/alerts/list` 获取告警 uuId |
| 关联接口 | `/api/xdr/v1/alerts/list` 告警列表（获取 uuId）、`/api/xdr/v1/alerts/dealstatus/list` 查询处置状态 |

## 使用场景

1. **批量更新告警处置状态**：根据告警 UUID 列表批量更新处置状态（如标记为处置完成、待处置等）
2. **手动标记告警处置**：所有手动修改处置状态的动作均标记为"手动标记"（MANUAL_MARKING）
3. **配合告警列表接口**：先调 `/alerts/list` 获取告警 uuId，再调本接口批量更新处置状态
4. **配合处置状态查询**：先调 `/alerts/dealstatus/list` 查询当前处置状态，再调本接口更新

6. **自动处置流程**：通过 isAutoDo=true 标记为自动处置，用于自动化流程

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/dealstatus |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**（Controller @Valid + QO 字段校验）：
   - `uuIds` 必传（@NotNull），最多 200 个元素（@Size(max = 200)）
   - 每个 UUID 须符合 `CommonConstants.VerifyConstants.UUID_CHAR_PARTTERN` 正则（@NotBlank + @Pattern）
   - `dealStatus` 必传（@NotNull），须是 DealStatusEnum 的 statusCode（@Enum）
   - `dealComment` 可选，最长 2048 字符（@Length(max = 2048)），须符合 LEGAL_CHAR_PATTERN（@Pattern）
2. **转换内部 QO**：Controller 将 `AlertUpdateDealStatusQo` 转换为内部 `UpdateAlertDealStatusQo`：
   - `ids` = `openAlertDealStatusQo.getUuIds()`
   - `status` = `openAlertDealStatusQo.getDealStatus()`
   - `comment` = `openAlertDealStatusQo.getDealComment()`
   - `dealAction` = `DealActionEnum.MANUAL_MARKING`（**所有手动修改处置状态的动作均标记为"手动标记"**）
3. **构建处置状态枚举**：`DealStatusEnum.build(status)` 将 status 转换为 DealStatusEnum
4. **批量更新处置状态**：调用 `alertService.setDealStatusAndAction(ids, dealStatusEnum, dealAction, null, false)` 批量更新，返回 `BatchOperateResult`（含 successIds + failIds + success + fail 计数）
5. **写入处置记录**：调用 `alertDisposalRecordService.modifyDealStatusWriteRecord(successIds, dealStatusEnum, alertDealStatusQo)` 为成功的告警写入处置记录
6. **上报告警事件状态**：调用 `iAlertStatusService.reportAlertEventStatus(successIds, comment)` 上报状态
7. **发送处置状态给任务**：调用 `alertService.sendDealStatusForTask(successIds, statusCode, isAutoDo)` 发送处置状态给任务模块
8. **封装返回**：`total = success + fail`，`succeededNum = success`，返回 `IncidentDealStatusVo(total, succeededNum)`

### 数据转换逻辑

- `AlertUpdateDealStatusQo` → `UpdateAlertDealStatusQo`：字段映射（uuIds→ids、dealStatus→status、dealComment→comment）+ dealAction 固定为 MANUAL_MARKING
- `BatchOperateResult` → `IncidentDealStatusVo`：total = success + fail，succeededNum = success
- 所有手动修改处置状态的动作均标记为 MANUAL_MARKING

### 默认行为
- `dealComment` 可为空（不写备注）
- `isAutoDo` 默认 false（手动处置）

### 特殊规则
- `uuIds` 必传，最多 200 个元素，每个 UUID 须符合 UUID_CHAR_PARTTERN
- `dealStatus` 必传，须是 DealStatusEnum 的 statusCode（1/2/3/6）
- 所有手动修改处置状态的动作均标记为 MANUAL_MARKING（不允许传入其他 dealAction）
- `dealComment` 最长 2048 字符，须符合 LEGAL_CHAR_PATTERN
- 部分失败时返回 total（含失败数）和 succeededNum（仅成功数），不抛异常
- 处置记录、事件状态上报、任务发送仅针对成功的告警

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| uuIds | array[string] | 是 | - | 安全告警 ID 列表，最多 200 个元素，每个 UUID 须符合 UUID_CHAR_PARTTERN 正则 | ["alert-123456","alert-789012"] |
| dealStatus | integer | 是 | - | 处置状态（DealStatusEnum，参考 enum-dictionary.md）：1-待处置/2-处置中/3-处置完成/6-已遏制 | 3 |
| dealComment | string | 否 | - | 处置备注，最长 2048 字符，须符合 LEGAL_CHAR_PATTERN | "已确认处置完成" |
| isAutoDo | boolean | 否 | false | 是否为自动处置 | false |

#### dealStatus 枚举（DealStatusEnum，参考 enum-dictionary.md）

| 取值 | 枚举常量名 | 国际化值（中文） |
|-------|-----------|----------------|
| 1 | PENDING | 待处置 |
| 2 | DISPOSING | 处置中 |
| 3 | DISPOSED | 处置完成 |
| 6 | SUPPRESSED | 已遏制 |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据（IncidentDealStatusVo） |

### data 结构说明（IncidentDealStatusVo）

| 参数名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| total | integer | 更新事件总数（成功 + 失败） | - | 3 |
| succeededNum | integer | 更新成功的事件数 | - | 2 |

## 调用示例

### 示例1：批量标记告警为处置完成

**请求示例**：
```json
{
  "uuIds": ["alert-123456", "alert-789012", "alert-345678"],
  "dealStatus": 3,
  "dealComment": "已确认处置完成",
  "isAutoDo": false
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 3,
    "succeededNum": 3
  }
}
```

### 示例2：批量标记告警为待处置（部分失败）

**请求示例**：
```json
{
  "uuIds": ["alert-123456", "alert-789012", "nonexistent-uuid"],
  "dealStatus": 1,
  "isAutoDo": false
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 3,
    "succeededNum": 2
  }
}
```

### 示例3：自动处置流程标记

**请求示例**：
```json
{
  "uuIds": ["alert-123456"],
  "dealStatus": 2,
  "dealComment": "自动化处置流程标记",
  "isAutoDo": true
}
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": {
    "total": 1,
    "succeededNum": 1
  }
}
```

### 示例4：错误响应 - uuIds 为空

**请求示例**（uuIds 为空数组）：
```json
{
  "uuIds": [],
  "dealStatus": 3
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "uuIds不能为空",
  "data": null
}
```

### 示例5：错误响应 - dealStatus 非法

**请求示例**（dealStatus 不在枚举）：
```json
{
  "uuIds": ["alert-123456"],
  "dealStatus": 9
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "dealStatus is illegal",
  "data": null
}
```

### 示例6：错误响应 - UUID 格式非法

**请求示例**（含非法字符的 UUID）：
```json
{
  "uuIds": ["alert-123456", "invalid@uuid"],
  "dealStatus": 3
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "UUID格式不合法",
  "data": null
}
```

### 示例7：错误响应 - dealComment 含非法字符

**请求示例**（dealComment 不符合 LEGAL_CHAR_PATTERN）：
```json
{
  "uuIds": ["alert-123456"],
  "dealStatus": 3,
  "dealComment": "包含非法字符<script>"
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "备注包含非法字符",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- `uuIds`：必传，最多 200 个元素，每个 UUID 须符合 UUID_CHAR_PARTTERN
- `dealStatus`：必传，须是 DealStatusEnum 的 statusCode（1/2/3/6）
- `dealComment`：最长 2048 字符，须符合 LEGAL_CHAR_PATTERN
- `isAutoDo`：默认 false

### 参数依赖关系
- `uuIds` 必传，每个元素须符合 UUID 字符格式
- `dealStatus` 必传，须是 DealStatusEnum 有效值
- `dealComment` 含非法字符时校验失败

### 权限要求
- 调用需具备 `superAdmin` 或 `alertQuery` 权限

### 性能建议
- `uuIds` 数量建议 ≤ 100，过多会增加批量更新开销
- 本接口为批量操作，建议按需调用，不需高频调用
- 部分失败时返回 total（含失败数）和 succeededNum（仅成功数），调用方需关注 succeededNum < total 的情况

### 数据一致性说明
- 本接口无时间戳字段
- 所有手动修改处置状态的动作均标记为 MANUAL_MARKING（DealActionEnum.MANUAL_MARKING）
- 处置记录、事件状态上报、任务发送仅针对成功的告警（successIds）
- `total` = success + fail，`succeededNum` = success，调用方需通过 `total - succeededNum` 计算失败数
- `dealStatus` 为 DealStatusEnum 的 statusCode（1/2/3/6），参考 enum-dictionary.md

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | uuIds不能为空 | uuIds 未传或为空 | 必传 uuIds（非空数组） |
| 400 | 数量超过200 | uuIds 元素数 > 200 | 减少 uuIds 数量至 ≤ 200 |
| 400 | UUID格式不合法 | uuIds 含不符合 UUID_CHAR_PARTTERN 的元素 | 每个 UUID 须符合 UUID 字符格式 |
| 400 | dealStatus不能为空 | dealStatus 未传 | 必传 dealStatus（1/2/3/6） |
| 400 | dealStatus is illegal | dealStatus 不在 DealStatusEnum | 使用 1/2/3/6 |
| 400 | 备注包含非法字符 | dealComment 不符合 LEGAL_CHAR_PATTERN | 移除非法字符 |
| 400 | dealComment过长 | dealComment 长度 > 2048 | 缩短 dealComment |

## 最佳实践

1. **uuIds 来源**：先调 `/api/xdr/v1/alerts/list` 获取告警 uuId，再调本接口批量更新处置状态
2. **批量操作优化**：建议单次操作 ≤ 100 个 UUID，避免过多导致批量更新变慢
3. **部分失败处理**：调用方需关注 `succeededNum < total` 的情况，对失败的 UUID 重试或记录日志
4. **dealStatus 选择**：1-待处置 / 2-处置中 / 3-处置完成 / 6-已遏制，参考 enum-dictionary.md 的 DealStatusEnum
5. **dealComment 建议**：写入有意义的处置备注（如"已确认处置完成"、"误报已忽略"），便于后续审计
6. **dealAction 固定为 MANUAL_MARKING**：所有手动修改处置状态的动作均标记为"手动标记"，不支持其他 dealAction
7. **配合处置状态查询**：先调 `/alerts/dealstatus/list` 查询当前处置状态，再调本接口更新
8. **isAutoDo 标志**：手动操作设为 false，自动化流程设为 true，便于区分处置来源
