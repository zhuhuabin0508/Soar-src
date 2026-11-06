# POST /api/xdr/v1/alerts/labels/list

## 接口概述

本接口用于查询XDR系统中的告警研判标签列表，支持按标签名称和标签类型过滤，返回标签ID、名称、类型、颜色等信息。通过本接口，您可以获取以下内容：

### 可查询的研判标签信息
- **标签ID**：标签唯一标识（id），用于标签的唯一标识
- **标签名称**：标签名称（name），如"安全测试"、"已确认攻击"等
- **标签类型**：标签类型（type），0=告警类型、1=SOAR标签
- **标签颜色**：标签颜色（color），如"red"、"blue"等

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 研判标签元数据查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/list` 告警列表查询（operationLabels 字段值来源于本接口返回的 name） |

## 使用场景

1. **研判标签下拉框**：在告警列表页面初始化时调用，加载所有可用的研判标签，供用户按标签过滤告警
2. **告警查询参数构造**：调用告警列表接口前，先调用本接口获取研判标签名称列表，将其作为 operationLabels 参数过滤特定标签的告警
3. **标签管理**：查询系统中已有的研判标签，确认标签是否需要新增或调整
4. **SOAR 标签查询**：通过 type=1 过滤 SOAR 标签，用于 SOAR 编排场景
5. **配合告警列表使用**：调用 `/alerts/list` 查询告警时，使用本接口返回的 name 作为 operationLabels 过滤条件的取值

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/labels/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 name 字段格式（@Pattern，不允许特殊字符，正则：STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS）
   - 校验 type 列表中每个元素必须是 LabelTypeEnum 枚举值（@Enum，0/告警类型、1/SOAR标签）
2. **获取租户ID**：通过 `TenantInfoContext.getTenantInfo().getProjectId()` 获取当前租户ID
3. **查询标签**：调用 `labelDao.queryByLabelListQo(tenantId, param)` 查询 MongoDB 中的研判标签
   - 查询条件：tenantId（租户ID）、name（标签名称，模糊匹配）、type（标签类型列表）
4. **数据转换**：通过 `BeanUtil.copyToList(operationLabels, Items.class)` 将 OperationLabels 实体列表拷贝为 Items VO 列表
5. **封装结果**：构造 OpenApiLabelVo，设置 item 和 total（item 列表长度）
6. **返回结果**：将 OpenApiLabelVo 封装到 OpenApiResponse 返回

### 数据转换逻辑

- 数据来源：MongoDB（通过 labelDao.queryByLabelListQo）
- 字段映射：通过 BeanUtil.copyToList 从 OperationLabels 拷贝到 Items
  - OperationLabels.id → Items.id（@JsonProperty("id")）
  - OperationLabels.name → Items.name
  - OperationLabels.type → Items.type
  - OperationLabels.color → Items.color
- total 字段：直接取 item 列表的大小

### 默认行为

- 不指定 name 时返回所有标签（无名称过滤）
- 不指定 type 时返回所有类型标签（无类型过滤）
- 查询结果为空时返回空 item 列表和 total=0

### 特殊规则

1. **租户隔离**：查询时强制按租户ID过滤，确保租户数据隔离
2. **name 格式校验**：不允许特殊字符（正则：STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS）
3. **type 枚举校验**：type 列表中每个元素必须是 LabelTypeEnum 枚举值（0/1）
4. **total 计算**：total 直接取 item 列表长度，非数据库 count
5. **JSON 字段名**：Items.id 通过 @JsonProperty("id") 注解指定 JSON 字段名

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| name | string | 否 | - | 标签名称，用于按名称过滤。不允许特殊字符（正则：STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS） | "安全测试" |
| type | array[integer] | 否 | - | 标签类型列表，每个元素必须是 LabelTypeEnum 枚举值。取值范围：0/告警类型, 1/SOAR标签 | [0, 1] |

#### type 枚举值说明（来源：LabelTypeEnum）

| 值 | 枚举常量名 | 说明 |
|----|-----------|------|
| -1 | ALL | 查询使用（表示所有类型） |
| 0 | INCIDENT | 告警类型 |
| 1 | SOAR | SOAR标签 |

> 注：ALL(-1) 为内部查询使用，外部调用一般使用 0 或 1。

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，见下方 data 结构说明 |

### data 结构说明（来源：OpenApiLabelVo）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| item | array[Items] | 研判标签列表，见下方 Items 结构说明 |
| total | integer | 总数（item 列表长度） |

### item 元素结构说明（来源：OpenApiLabelVo.Items）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 标签唯一ID（来源 MongoDB ObjectId） | - | "67847953eedd32506cf16b14" |
| name | string | 标签名称 | - | "安全测试" |
| type | integer | 标签类型（LabelTypeEnum） | 0/告警类型, 1/SOAR标签 | 1 |
| color | string | 标签颜色 | - | "red" |

## 调用示例

### 示例1：查询所有研判标签

**请求示例**：
```json
{}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "id": "67847953eedd32506cf16b14",
                "name": "安全测试",
                "type": 0,
                "color": "red"
            },
            {
                "id": "67847953eedd32506cf16b15",
                "name": "已确认攻击",
                "type": 0,
                "color": "orange"
            },
            {
                "id": "67847953eedd32506cf16b16",
                "name": "SOAR自动处置",
                "type": 1,
                "color": "blue"
            }
        ],
        "total": 3
    }
}
```

### 示例2：按标签名称过滤

**请求示例**：
```json
{
    "name": "安全测试"
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "id": "67847953eedd32506cf16b14",
                "name": "安全测试",
                "type": 0,
                "color": "red"
            }
        ],
        "total": 1
    }
}
```

### 示例3：按标签类型过滤（SOAR 标签）

**请求示例**：
```json
{
    "type": [1]
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [
            {
                "id": "67847953eedd32506cf16b16",
                "name": "SOAR自动处置",
                "type": 1,
                "color": "blue"
            }
        ],
        "total": 1
    }
}
```

### 示例4：按标签类型过滤（告警类型标签）

**请求示例**：
```json
{
    "type": [0]
}
```

### 示例5：组合过滤（名称 + 类型）

**请求示例**：
```json
{
    "name": "已确认",
    "type": [0, 1]
}
```

### 示例6：空结果响应

**请求示例**：
```json
{
    "name": "不存在的标签"
}
```

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "item": [],
        "total": 0
    }
}
```

### 示例7：错误响应示例 - name 包含特殊字符

**请求示例**（无效参数）：
```json
{
    "name": "安全测试<script>"
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "exception.label.name.char.illegal",
    "data": null
}
```

### 示例8：错误响应示例 - type 值不在枚举范围

**请求示例**（无效参数）：
```json
{
    "type": [99]
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "exception.label.type.enum.err",
    "data": null
}
```

### 示例9：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **name 格式限制**
   - 不允许特殊字符（正则：STRING_REGEX_NOT_ALLOW_SPECIAL_CHARACTERS）
   - 包含特殊字符会校验失败

2. **type 枚举限制**
   - 每个元素必须是 LabelTypeEnum 枚举值（0/1）
   - 其他值会校验失败

### 参数依赖关系

- name 与 type 为可选参数，可单独使用或组合使用
- 不指定任何参数时返回所有标签

### 权限要求

- 需要 `superAdmin` 或 `alertQuery` 权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery')")` 控制）
- 权限不足将返回 403 错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.alerts.aggregation.log"）

### 性能建议

- 标签数据量通常较小，调用性能高
- 标签更新频率低，可在前端做适度缓存（如 10~30 分钟），避免重复请求

### 数据一致性说明

1. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 本接口无时间戳字段

2. **租户隔离**
   - 查询时强制按租户ID过滤
   - 不同租户的标签数据相互隔离

3. **数据来源**
   - 数据来源于 MongoDB（通过 labelDao.queryByLabelListQo）
   - 标签由前端管理界面或 SOAR 编排写入

4. **total 字段说明**
   - total 直接取 item 列表长度，非数据库 count
   - 等于实际返回的标签数量

5. **JSON 字段名**
   - Items.id 通过 @JsonProperty("id") 注解指定 JSON 字段名为 id
   - 其他字段（name、type、color）无 @JsonProperty 注解，JSON 字段名与 Java 字段名一致

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | exception.label.name.char.illegal | name 包含特殊字符 | 移除特殊字符，使用合法字符 |
| 400 | exception.label.type.enum.err | type 值不在 LabelTypeEnum 枚举范围 | 使用 0（告警类型）或 1（SOAR标签） |
| 403 | Access Denied | 权限不足 | 联系管理员添加 superAdmin 或 alertQuery 权限 |
| 500 | exception.method.execute | 服务端执行异常（如 MongoDB 连接失败） | 联系技术支持，检查 MongoDB 状态 |

## 最佳实践

1. **首次使用建议**
   - 直接调用本接口获取全量研判标签列表
   - 验证权限配置是否正确

2. **配合告警查询使用**
   - 调用本接口获取研判标签列表后，将 name 字段作为告警查询接口 `operationLabels` 参数的过滤值
   - 用于按研判标签过滤告警列表

3. **前端缓存策略**
   - 标签更新频率低，建议前端缓存 10~30 分钟
   - 避免每次告警查询前都调用本接口

4. **标签类型区分**
   - type=0（告警类型）：人工运营标记的标签
   - type=1（SOAR标签）：SOAR 编排自动添加的标签
   - 根据业务需求选择过滤类型

5. **错误处理**
   - 解析响应时首先检查 code 字段，"Success" 为成功
   - 400 错误根据 message 字段定位参数问题
   - 403 错误需联系管理员添加权限
   - 500 错误建议短暂间隔后重试

6. **字段使用建议**
   - id 字段为标签唯一标识，用于标签的精确引用
   - name 字段为标签名称，用于告警查询接口的过滤参数
   - type 字段区分标签类型，便于分类管理
   - color 字段用于前端展示标签颜色
