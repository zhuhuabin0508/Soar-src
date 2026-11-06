# 业务专有名词字典

> 本文档记录 Sangfor XDR OpenAPI 系统中**容易望文生义被误解**的业务专有名词真实含义。
> 当需求中出现下列名词时，**必须先查本字典**，不能直接按字面去匹配接口字段名。
> 若需求中出现本字典未列出的专有名词（特别是加引号或带特定含义的业务名词），应**主动向用户澄清其真实含义**，不可按字面推测。

---

## 1. 管理IP范围

| 属性 | 内容 |
|------|------|
| **真实含义** | 系统中一条**具体的内置资产组**的 `name` 字段值（通常 `id=1`），代表"系统自动管理的 IP 范围"这一具体资产组实例 |
| **易误解为** | `isPrivate=true` 的资产组类型 / 一类按 IP 范围管理的资产组分类 |
| **错误后果** | 把 `isPrivate=true` 当成"查询管理IP范围资产组"，实际所有内置资产组的 `is_private` 都是 `False`，会得到空列表，最终结果错误地返回 0 |
| **字段语义边界** | `is_private` 字段标记的是"私有/自定义资产组" vs "系统内置资产组"，**与"管理IP范围"无关** |
| **正确查询方式** | 用 `POST /api/xdr/v1/branches/list` 接口，传 `search="管理IP范围"` 按名称模糊查询，再在客户端按 `branchName === "管理IP范围"` 精确过滤取 `branchId` |
| **正确用法示例** | 见 `docs/openapi-analysis/` 下"查询资产组为管理IP范围下面近7天事件总数剔除已加白"类方案的步骤 1 |

### 证据来源

- 测试数据：`D:\pythonProject\xdr-asset\testcases\data\apps\asset_web\view\branch\data.py` 中 `branch_list_res2` 等多条 mock 数据，`id=1, name='管理IP范围'`，且同名资产组的 `is_private` 字段均为 `False`
- 接口源码：`branches-list.md` 中 `isPrivate` 字段说明已纠正为"私有资产组"语义，不再等同于"管理 IP 范围"

### 正确调用链路（示例）

```
需求：查询"管理IP范围"资产组下近7天事件总数（剔除已加白）

步骤1：POST /api/xdr/v1/branches/list
       body: {"search": "管理IP范围"}
       → 取 data[*].branchId（branchName === "管理IP范围" 的那条）

步骤2：POST /api/xdr/v1/incidents/aggregation
       body: {
         "startTimestamp": <近7天起>,
         "endTimestamp": <当前>,
         "timeField": "startTime",
         "aggBy": ["hostBranchId"],
         "aggFuncs": [{"name":"count","func":"count","param":"*"}],
         "filterParam": {
           "hostBranchIds": [<步骤1拿到的 branchId>],
           "whiteStatus": ["未加白"]
         },
         "limit": 200
       }
       → 取 data.item[0].count
```

---

## 2. 告警分类（alarmClassifications）

| 属性 | 值 |
|------|-----|
| 业务名词 | 告警分类 / alarmClassifications |
| 真实含义 | 告警分类三级树（一级 moduleType、二级 attackTypeId、三级 attackSubTypeId）的数字 ID，逗号拼接成单个字符串元素 |
| 易误解为 | 容易被当成告警类型的中文名（如 `"web攻击"`、`"漏洞利用"`），尤其因为字段类型是 `Array<String>` |
| 错误后果 | 传中文名后，后端会逐段 `Integer.parseInt` 失败，抛 `NumberFormatException`，接口返回 500，且堆栈暴露内部实现 |
| 字段语义边界 | 类型虽是 `Array<String>`，但元素必须是 `"M"` / `"M,A"` / `"M,A,S"` 形式的数字 ID 串，不是任意字符串 |
| 正确查询方式 | 1) 调用告警分类元数据接口拿到 moduleType/attackTypeId/attackSubTypeId 三级树；2) 按需要的分类层级拼接字符串：仅按一级 → `"1"`，一级+二级 → `"1,2"`，一级+二级+三级 → `"1,2,3"`；3) 数组多元素表示组内 AND（同一过滤的多组 OR） |
| 证据来源 | 后端 DAO 屢 `structureAlarmClassificationQuery` 方法：逐段 `split(",")` + `Integer.parseInt`，再按段索引映射到 moduleType/attackTypeId/attackSubTypeId 字段 |

---

## 3. 其他待补充名词（占位）

> 后续遇到容易误解的业务名词，按上面格式补充到本字典。常见可能需要补充的方向：
> - 资产分类相关：`classify1Id` / `classifyId` / `branchType` / `tag_type` 的实际语义
> - 事件/告警状态相关：`dealStatus` 各枚举值的业务语义（已遏制、已防护、已忽略等）
> - 平台/级联相关：`platformId` / `platformFilter` / `is_self_platform` 的语义
> - 业务组：`hostBusinessIds` vs `hostBranchIds` 的区别

---

## 维护规则

1. **新增词条格式**：包含"真实含义 / 易误解为 / 错误后果 / 字段语义边界 / 正确查询方式 / 证据来源"六个字段，便于 AI 与人工双向核对
2. **证据来源必填**：每条必须给出源码路径或测试数据路径，不能凭推测
3. **遇到不确定名词先查字典**：本字典未列出的名词若在需求中出现且语义不明，必须澄清后再生成方案，不可按字面匹配字段
