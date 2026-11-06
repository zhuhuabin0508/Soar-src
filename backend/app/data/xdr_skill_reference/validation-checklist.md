# 验证自检清单

生成调用方案后，必须逐项完成以下两层验证。全部通过后才能输出方案。

## 第一层：格式完整性验证

| # | 检查项 | 检查方法 | 不通过时处理 |
|---|--------|----------|-------------|
| 1 | 每个请求参数都有具体值 | 逐字段检查 JSON 中是否有未填充的占位符（如 `""`、`null` 在必填字段上） | 根据需求文档和业务逻辑补充具体值，无法确定的标注为"需用户输入" |
| 2 | 必填参数无遗漏 | 对照接口文档的请求参数表，检查所有"必填=是"的字段是否出现在方案中 | 补充缺失的必填参数 |
| 3 | 返回值包含接口的全部字段 | 对照接口文档的返回参数表，检查方案是否列出了所有返回字段（不是只列需求关心的字段） | 补充缺失的返回字段 |
| 4 | 返回值示例是完整 JSON | 检查示例 JSON 是否包含所有字段（含嵌套结构），不是片段 | 补充缺失字段到示例 JSON |
| 5 | 多接口编排中步骤间数据传递明确到字段 | 检查每个步骤的"步骤间传递字段"说明，确认每个传递路径都标注了源字段和目标参数 | 补充缺失的字段级传递说明 |
| 6 | 方案中没有依赖不在 api-docs/ 中的接口 | 检查方案中引用的每个接口路径，确认 `references/api-docs/` 中有对应文档 | 移除不存在的接口引用，或标注该接口文档缺失 |
| 7 | 枚举值与接口文档一致 | 对照接口文档的枚举说明，检查方案中使用的枚举值是否都在合法范围内 | 修正为合法枚举值 |
| 8 | 条件分支逻辑无遗漏 | 检查多接口编排中的条件分支，确认每种可能情况都有对应处理 | 补充缺失的分支处理 |
| 9 | 聚合函数名（aggFuncs.func）使用接口文档列出的合法值 | 对照接口 md 中"aggFuncs.func 取值表"检查方案中的 func 值（告警聚合：count/cardinality/avg/max/min/sum），**严禁用 ES 原生函数名**（如 value_count）；接口 md 未列出 func 取值时，**不主动查源码**，应通过会话让业务方/管理员确认后再生成 | 修正为接口 md 列出的合法 func 值 |
| 10 | 枚举字段传值与语言环境匹配 | 检查 whiteStatus 等依赖语言环境的枚举字段，中文环境传国际化值（如"未加白"），国际版传数字值（如"0"） | 根据用户语言环境修正传值 |
| 11 | 返回值枚举字段有枚举对照 | 检查方案返回值结构中每个枚举类型字段，确认有"枚举值说明"列或内联对照（如"0/未加白, 1/已加白, 2/部分加白（参考enum-dictionary.md）"） | 读取 enum-dictionary.md 为枚举字段补充对照 |
| 12 | 请求参数枚举字段传值与枚举字典一致 | 检查方案中枚举字段的传值是否与 enum-dictionary.md 中的定义一致 | 修正为字典中的正确值 |
| 13 | 时间戳示例值是否对应正确的相对日期 | 检查方案中所有时间戳示例值（入参 startTimestamp/endTimestamp、返回值 firstTime/lastTime 等）是否按"当前时间 - N 天"算出对应秒级时间戳（10 位 Long），不能凭空编数字。算不出时应标注"以实际调用时为准，秒级时间戳" | 重新计算示例值，或标注"以实际调用时为准，秒级时间戳" |
| 14 | **请求方式与 KB 文档"接口信息"段一致** | 对照 `references/api-docs/` 中对应接口文档的"接口信息"表格，确认方案中的 HTTP 方法（GET/POST/PUT/DELETE）与文档一致。GET 接口不应生成请求体；POST 接口不应遗漏 Content-Type。典型反例：`/alerts/attcktechniques` 是 GET 无 body 字典接口，不应生成 POST + aggFuncs 风格的聚合请求 | 改正请求方式与请求体；若是字典接口（GET 无 body），移除所有聚合/过滤参数 |
| 15 | **聚合接口 sort 字段是结果 Map 中真实存在的 key** | 检查聚合接口方案中 `sort: "<field>:asc/desc"` 的 `<field>` 是否为 `aggBy` 字段名或 `aggFuncs.name` 之一（这两类是结果 Map 的真实 key）。后端排序逻辑只对 `sortKey == aggBy字段名` 的项生效（控制 ES terms 桶内部排序），结果排序按 `map.get(sortKey)` 取值，sortKey 必须是 Map 中已存在的 key 才能取到值。若 sort key 既不是 aggBy 字段名也不是 aggFuncs.name，排序静默失效 | 改用 `aggBy字段名:asc`（按分组值排）或 `aggFuncs.name:desc`（按聚合计数排），并保证该字段在结果 Map 中存在 |
| 16 | **`alarmClassifications` 元素为数字三元组格式** | 检查方案中 `filterParam.alarmClassifications` 数组的每个元素是否都是数字 ID 逗号分隔格式：`"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`。**严禁中文名**（如 "web攻击"、"扫描"）——后端会逐段 `Integer.parseInt`，中文名抛 NumberFormatException，被 Service 层包装为 500 "请求失败"（原始异常只在服务端日志可见，调用方无法从响应判断根因）。中文名需先通过对应枚举（参考 enum-dictionary-pending.md 第 10 节）映射为 ID 再传 | 把所有中文名元素替换为数字三元组字符串（如 `"94,1,1"`）；无法映射的标注"需先调对应字典接口拿 ID" |
| 17 | **attack/link 入参的 hostAssetIds 必须来自 attack/area 返回值** | 检查多接口编排方案中 `/alerts/attack/link` 步骤的 `areaInfos[].hostAssetIds` 是否明确标注"来自 `/alerts/attack/area` 返回值的 `data.hostAssetIdArea[].hostAssetInfo[].hostAssetId` 字段"。不能直接传 branchIds（`/attack/area` 用的是 branchIds，`/attack/link` 用的是 hostAssetIds，子结构字段名不同）。顶层 `areaName` 必须在 `areaInfos` 中存在 | 补充 area→link 的字段级映射关系；若用户未通过 attack/area 拿 hostAssetId，先在方案前加 attack/area 步骤，或停下告知用户 hostAssetId 数据来源缺失 |
| 18 | **数组类型字段严禁降级为单个字符串** | 检查方案中每个类型为 `Array<T>`/`List<T>` 的请求参数字段，确认传值都是 JSON 数组字面量（哪怕只有一个元素也必须写 `["xxx"]`），不能传裸字符串。重点检查：`QueryEntityByAlertIdsQo.uuIds`（`List<String>`）——传 `{"uuIds": "xxx"}`（裸字符串）时 Jackson 反序列化抛 `MismatchedInputException`，被服务端吞掉后透出 500 "请求失败"。同类字段还有各接口的 ips/logTypes/actions/vendorTypes 等数组字段 | 把所有裸字符串传值改为数组字面量；生成方案时对照接口文档参数表逐字段确认类型 |
| 19 | **analysislog 系列 aggFuncs.param 必须是接口文档推荐字段，严禁 `*`** | 检查 `/analysislog/networksecurity/aggregation` 与 `/analysislog/trends` 方案中 `aggFuncs[].param` 是否为接口 md 中"推荐字段表"列出的字段名（如 networksecurity 聚合见对应 md 的 aggBy 推荐字段表，trends 见 `analysislog-trends.md` "⚠️ aggBy 字段高频踩坑"段落中的推荐字段表），**严禁传 `"*"`**。后端对不在白名单的字段抛 `IllegalArgumentException("unsafe field: *")`，被 Service 层包装为 500 "请求失败"（原始异常只在服务端日志可见）。trends 接口的 `aggFuncs.func` 在 SQL 构造时被忽略（硬编码 COUNT），只认 param 字段 | 把 `"*"` 改为接口 md 推荐字段（如 networksecurity 聚合用 `srcIp`，trends 用 `recordTimestamp`） |
| 20 | **getEntityInfo 入参只有 traceValue 一个字段** | 检查 `/alerts/getEntityInfo` 方案的请求体是否只含 `traceValue` 字段，**严禁臆造 `entityType`/`entityValue` 等字段**。QO 类只定义 `traceValue`；实体类型由后端按值格式自动识别（IPv4 判 IP、域名正则判域名、MD5 正则判 MD5），不需要前端传类型。传未知字段会被 Jackson 忽略，`traceValue` 为空时后端直接返回 null（`data: null`，无任何业务数据也不报错）。注意本接口与 `/alerts/getXenAlertId`（type + ips/assetIds/dnsNames/md5s 多字段结构）结构完全不同，不可互相臆造字段 | 移除臆造字段，改为 `{"traceValue": "<实体值>"}`；实体值为空时在方案中标注"将返回 data: null" |

## 第二层：需求满足性验证

从方案往回看，确认每一条用户需求都有对应的接口能力覆盖。

| # | 检查项 | 检查方法 | 不通过时处理 |
|---|--------|----------|-------------|
| 1 | 需求要素逐项覆盖 | 把第1步解析出的核心动词、业务对象、过滤条件、输出期望、关联动作，逐项对照方案，确认每一项都有对应的接口操作或返回字段实现 | 在方案中标注"此需求项当前无接口支持"，以醒目方式提示 |
| 2 | 数据流闭环 | 对多接口编排，从最终输出往回追溯每一步的数据来源，确认不存在"数据孤岛"（某步骤需要的数据既不是用户输入也不是前序步骤提供的） | 标注数据流断裂点，说明无法获取该数据的原因 |
| 3 | 边界条件覆盖 | 检查用户提到的过滤条件（如"最近7天"、"高危"），确认方案中的参数值确实能表达这些条件 | 修正参数值或标注该条件无法通过现有参数精确表达 |
| 4 | **attack/area 与 attack/link 的依赖链闭环** | 当方案涉及 `/alerts/attack/link` 时，确认前序步骤已调用 `/alerts/attack/area`，且 area 返回值的 `hostAssetId` 字段被显式提取并传入 link 的 `hostAssetIds`。若用户需求只描述"画连线"而未提"先查区域"，方案应主动补全 area→link 的两步编排（不能跳过 area 直连 link，否则 hostAssetIds 无数据来源） | 在方案前补 attack/area 步骤；若用户拒绝补全则标注"此需求项当前无单接口支持，必须两步编排" |
