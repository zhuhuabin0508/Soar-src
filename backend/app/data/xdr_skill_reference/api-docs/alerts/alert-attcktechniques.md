# GET /api/xdr/v1/alerts/attcktechniques

## 接口概述

本接口用于查询系统中所有 ATT&CK 框架的战术（Stage）-技术（Technique）-子技术（SubTechnique）三层结构信息，含国际化翻译后的名称。通过本接口，您可以获取以下内容：

### 可查询的 ATT&CK 信息
- **战术（Stage）**：TA0001~TA00xx 等 ATT&CK 战术阶段
- **技术（Technique）**：每个战术下的攻击技术（如 T1125、T1602 等）
- **子技术（SubTechnique）**：每个技术下的子技术（如 T1602.001、T1602.002 等）

### 返回的层级结构
- **id**：唯一编号（如 TA0009、T1125、T1602.001）
- **name**：国际化翻译后的名称（中文/英文）
- **children**：子层级列表（战术→技术→子技术）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警开放性接口 |
| 接口分类 | 字典查询 - ATT&CK 信息 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/api/xdr/v1/alerts/list` 告警列表（返回值含 attckTechniques 字段）、`/api/xdr/v1/alerts/aggregation` 告警聚合（aggBy 可用 attckTechniques） |

## 使用场景

1. **ATT&CK 字典加载**：前端在加载告警列表/聚合结果前，先调本接口获取 ATT&CK 字典，用于将 attckTechniques 字段值翻译为可读名称
2. **告警 ATT&CK 标签展示**：配合 `/alerts/list` 接口返回的 attckTechniques 字段，将技术 ID（如 T1125）映射为可读名称（如"数据从中转服务器"）
3. **告警聚合维度翻译**：配合 `/alerts/aggregation` 接口按 attckTechniques 聚合时，将聚合桶 key 翻译为可读名称
4. **ATT&CK 战术-技术树展示**：在前端展示完整的 ATT&CK 战术-技术-子技术三层树结构
5. **威胁分析报告**：生成威胁分析报告时，引用 ATT&CK 框架描述攻击技术
6. **缓存优化**：本接口使用 `@Cacheable(value = "attckTechniquesCache")` 缓存，重复调用直接从缓存读取，性能高

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | GET |
| 请求路径 | /api/xdr/v1/alerts/attcktechniques |
| Content-Type | 无（GET 请求） |
| 权限要求 | superAdmin、incidentQuery 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **参数校验**：无入参（GET 请求无请求体）
2. **权限校验**：`@PreAuthorize("hasAnyAuthority('superAdmin','incidentQuery','alertQuery')")`
3. **缓存查询**：方法标注 `@Cacheable(value = "attckTechniquesCache")`，首次调用执行方法，后续从缓存读取
4. **数据加载**：调用 `openApiAlertService.getAllAttckInfos()`，从 `AttckEnum` 枚举加载所有 ATT&CK 信息：
   - 遍历 `AttckEnum.values()`，每个枚举转换为 `Attck` 对象（含 id、attckStage、attckTechnique、attckSubTechnique）
5. **构建层级结构**：调用 `AttckTechniquesVo.buildListIncludeAttckStage(attcks)` 构建"战术-技术-子技术"三层结构：
   - 第一层（战术）：按 attckStage 分组，每个 stage 调 `buildStage(stageId)` 创建节点，name 通过 `AttckI18nUtil.i18nAttckStageOrDefault` 国际化
   - 第二层（技术）：每个 stage 下按 attckTechnique 分组，调用 `buildTech(techId)` 创建节点，name 通过 `AttckI18nUtil.i18nAttckTechOrDefault` 国际化
   - 第三层（子技术）：每个 tech 下收集 attckSubTechnique 列表，调用 `buildSubTech(subTechId)` 创建节点，name 通过 `AttckI18nUtil.i18nAttckSubTechOrDefault` 国际化
6. **返回**：返回 `List<AttckTechniquesVo>`，每个元素含 id、name、children

### 数据转换逻辑

- `AttckEnum` 枚举 → `Attck` 实体（id、attckStage、attckTechnique、attckSubTechnique）
- `Attck` 列表 → 三层 Map 结构（stage → tech → subTech 列表）
- 三层 Map → `AttckTechniquesVo` 三层树（每个节点 id 为 ATT&CK 编号，name 为国际化翻译后的名称）
- `@JsonInclude(JsonInclude.Include.NON_NULL)` 确保 null 字段不序列化
- `@JsonInclude(JsonInclude.Include.NON_EMPTY)` 确保 children 为空集合时不序列化

### 默认行为
- 国际化名称找不到时，`i18nAttckStageOrDefault` / `i18nAttckTechOrDefault` / `i18nAttckSubTechOrDefault` 返回 id 作为默认值
- children 为空时不序列化（`@JsonInclude(JsonInclude.Include.NON_EMPTY)`）

### 特殊规则
- 本接口使用 `@Cacheable(value = "attckTechniquesCache")` 缓存，重复调用从缓存读取
- 国际化根据当前 Locale 自动选择中文/英文
- 战术-技术-子技术按 `LinkedHashMap` 保持插入顺序

## 请求参数

### 请求头

无（GET 请求）

### 请求参数

无（GET 请求无请求体和查询参数）

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | array[object] | 响应数据（List<AttckTechniquesVo>） |

### data 元素结构说明（AttckTechniquesVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 唯一编号（战术/技术/子技术的 ATT&CK 编号） | - | "TA0009" |
| name | string | 翻译后名称（国际化后） | - | "数据收集" |
| children | array[object] | 子层级列表（战术→技术，技术→子技术），为空时不序列化 | - | [{"id":"T1125","name":"数据从中转服务器"}] |

#### children 子结构（递归 AttckTechniquesVo）

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 唯一编号 | - | "T1602" |
| name | string | 翻译后名称 | - | "数据从中转服务器" |
| children | array[object] | 子层级列表（技术→子技术），为空时不序列化 | - | [{"id":"T1602.001","name":"嗅探网络流量"}] |

## 调用示例

### 示例1：查询所有 ATT&CK 信息

**请求示例**：
```
GET /api/xdr/v1/alerts/attcktechniques
```

**响应示例**：
```json
{
  "code": "Success",
  "message": "success",
  "data": [
    {
      "id": "TA0009",
      "name": "数据收集",
      "children": [
        {
          "id": "T1125",
          "name": "数据从中转服务器"
        },
        {
          "id": "T1602",
          "name": "数据从中转服务器",
          "children": [
            {"id": "T1602.001", "name": "嗅探网络流量"},
            {"id": "T1602.002", "name": "从配置文件获取数据"}
          ]
        },
        {
          "id": "T1056",
          "name": "输入捕获",
          "children": [
            {"id": "T1056.001", "name": "键盘记录"},
            {"id": "T1056.002", "name": "GUI输入捕获"},
            {"id": "T1056.003", "name": "Web门户捕获"},
            {"id": "T1056.004", "name": "凭据API捕获"}
          ]
        }
      ]
    },
    {
      "id": "TA0008",
      "name": "横向移动",
      "children": [
        {"id": "T1091", "name": "通过可移动介质进行横向移动"},
        {"id": "T1072", "name": "软件部署工具"},
        {"id": "T1080", "name": "Taint共享内容"},
        {"id": "T1570", "name": "通过备用认证进行横向移动"}
      ]
    }
  ]
}
```

### 示例2：错误响应 - 无权限

**请求示例**（无权限调用）：
```
GET /api/xdr/v1/alerts/attcktechniques
```

**错误响应示例**：
```json
{
  "code": "Unknown",
  "message": "Access is denied",
  "data": null
}
```

## 注意事项与限制

### 参数限制
- 无入参（GET 请求）

### 参数依赖关系
- 无

### 权限要求
- 调用需具备 `superAdmin`、`incidentQuery` 或 `alertQuery` 权限之一

### 性能建议
- 本接口使用 `@Cacheable(value = "attckTechniquesCache")` 缓存，首次调用后从缓存读取，性能高
- 建议前端在系统启动时调一次本接口，缓存 ATT&CK 字典到前端本地
- ATT&CK 信息变化较少，缓存可长期使用，无需频繁刷新

### 数据一致性说明
- 本接口无时间戳字段
- ATT&CK 信息来自 `AttckEnum` 枚举（硬编码），不依赖外部数据源
- 国际化名称根据当前 Locale 自动选择中文/英文，找不到时返回 id 作为默认值

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 403 | Access is denied | 无权限 | 调用需具备 `superAdmin`、`incidentQuery` 或 `alertQuery` 权限之一 |

## 最佳实践

1. **前端缓存字典**：建议前端在系统启动时调本接口获取 ATT&CK 字典，缓存到本地，避免每次告警展示都调用
2. **配合告警列表展示**：调 `/alerts/list` 获取告警后，用本接口的字典将 attckTechniques 字段值翻译为可读名称
3. **配合告警聚合展示**：调 `/alerts/aggregation` 按 attckTechniques 聚合时，用本接口的字典将聚合桶 key 翻译为可读名称
4. **三层树展示**：本接口返回三层结构（战术→技术→子技术），可直接用于前端树形展示
5. **国际化处理**：name 字段已国际化，前端无需额外翻译
6. **缓存利用**：后端使用 `@Cacheable` 缓存，重复调用性能高，可放心频繁调用（但建议前端也做缓存）
