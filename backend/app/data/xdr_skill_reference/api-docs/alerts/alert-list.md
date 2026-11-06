# POST /api/xdr/v1/alerts/list

## 接口概述

本接口用于分页查询XDR系统中的安全告警列表，支持按资产组、源IP、告警状态、严重等级、时间范围、攻击方向、威胁定性、研判标签等多维度过滤，支持精确查询（uuIds）和模糊搜索（fuzzyParam），返回告警明细及分页信息。通过本接口，您可以获取以下内容：

### 可查询的告警基本信息
- **告警标识**：告警UUID（uuId）、告警名称（name）、告警规则ID（alertRuleId）
- **时间信息**：最早发生时间（firstTime）、最近发生时间（lastTime）、更新时间（updateTime）、处置时长（dealTimeDesc）
- **严重程度**：告警等级（severity 分数 0-100）、确定性等级（confidence）、告警阶段（stage）

### 可查询的威胁信息
- **威胁分类**：告警一级分类（threatClassDesc）、二级分类（threatTypeDesc）、三级分类（threatSubTypeDesc）
- **威胁定性**：威胁定性标签（threatDefine，参考 enum-dictionary.md）
- **ATT&CK框架**：攻击战术和技术标识（attckTechnique，格式：TAxxxx.Txxxx）

### 可查询的攻击信息
- **攻击结果**：攻击结果状态（attackState，AttackResultEnum）
- **访问方向**：访问方向（direction，AttackDirectionEnum）：0/无、1/内对外、2/外对内、3/内对内
- **风险标签**：风险标签（riskTag）
- **漏洞信息**：CVE编号（exploitCveId）

### 可查询的网络信息
- **源端信息**：源IP（srcIp）、源端口（srcPort）、X-Forwarded-For头（xForwardedFor）
- **目的端信息**：目的IP（dstIp）、目的端口（dstPort）
- **URL和域名**：URL列表（url）、域名列表（domain）
- **IP详细信息**：源IP详情（srcIpInfos）、目的IP详情（dstIpInfos），含资产组、业务组、国家、省份、资产分类

### 可查询的资产信息
- **主机信息**：主机IP（hostIp）、主机资产ID（hostAssetId）、所属资产组（branchName/hostBranchId）、业务组（hostGroupIds/hostGroups）
- **资产类型**：主机资产父类型（hostClassify1Id）、具体类型（hostClassifyId）

### 可查询的文件信息
- **文件标识**：文件MD5列表（fileMd5）、进程名列表（pName）
- **HTTP响应**：响应状态码（respStatus）

### 可查询的处置信息
- **处置状态**：告警处置状态（alertDealStatus，DealStatusEnum）：1/待处置、2/处置中、3/处置完成、6/已遏制
- **处置动作**：处置动作描述（alertDealAction）
- **加白状态**：加白状态（whiteStatus，WhiteStatusEnum）

### 可查询的研判信息
- **GPT研判**：GPT研判结论编码（gptResult）、研判结论描述（gptResultDescription）
- **研判标签**：运营标签（operationLabels）

### 可查询的来源信息
- **数据源**：数据源设备描述（devUidDesc）、来源设备名称（devSourceName）
- **检测引擎**：检测引擎名称（engineName）
- **上报设备**：产品类型（productType，入参过滤）

### 可查询的溯源信息
- **日志回溯**：日志回溯ID（traceBackId），用于追溯原始日志

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属Controller | OpenApiAlertController |
| 所属业务域 | 告警管理 - 开放性接口 |
| 接口分类 | 告警查询 |
| 前置依赖 | 无（可直接调用，需具备相应权限） |
| 关联接口 | `/alerts/dealstatus` 批量更新处置状态（需先获取uuId）、`/alerts/aggregation` 告警聚合查询、`/alerts/labels/list` 告警研判标签查询、`/alerts/gptresult/type` GPT研判结论查询、`/alerts/devUidName` 数据源名称查询（devUIds 过滤值来源） |

## 使用场景

1. **安全告警监控**：实时获取系统中的安全告警，用于安全运营中心(SOC)展示，如大屏告警列表刷新
2. **告警数据分析**：批量获取告警数据，结合严重程度、威胁定性、攻击方向等维度进行安全分析和报表生成
3. **告警状态同步**：获取告警处置状态（alertDealStatus），用于与其他系统（如工单系统、SIEM）同步告警处理进度
4. **威胁狩猎**：根据特定条件（如源IP、攻击技术、风险标签）查询相关告警，辅助安全运营人员进行威胁狩猎
5. **事件调查**：获取告警的详细网络信息（srcIp/dstIp/url/domain）、资产信息（hostIp/hostAssetId）、文件信息（fileMd5/pName），用于安全事件深入调查
6. **批量处置前置**：查询告警获取uuId列表，配合 `/alerts/dealstatus` 接口进行批量标记处置状态
7. **精确查询**：已知告警UUID时使用 uuIds 进入精确查询模式，时间范围自动设为全量

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | /api/xdr/v1/alerts/list |
| Content-Type | application/json |
| 权限要求 | superAdmin 或 alertQuery |

## 业务逻辑

### 核心处理流程

1. **接收请求参数并校验**：
   - 校验 uuIds/uuiD 列表大小 ≤ 200（@Size(max=200)），每个元素符合 UUID 格式
   - 校验 page ≥ 1（默认 1）
   - 校验 pageSize 取值范围 5~200（默认 5）
   - 校验 timeField 必须为 AlertTimeFieldTypeEnum 枚举值（默认 lastTime）
   - 校验 sortField 必须为 AlertSortFieldTypeEnum 枚举值（默认 lastTime）
   - 校验 sortOrder 必须为 SortOrder 枚举值 asc/desc（ES SortOrder.toString() 小写，默认 asc）
   - 校验 productType 元素数量 1~200，每个元素为 AnalysisProductTypeEnum 枚举值
   - 校验 alertDealStatus、severities、accessDirections 为对应枚举值
2. **时间范围补全**：Controller 层通过 `OpenApiTimeRangeUtil.resolveTimestampAllTime` 处理 startTimestamp/endTimestamp 空值
   - 当 uuIds 非空（精确查询模式）：startTimestamp 默认设为 0（全量），endTimestamp 默认取今天结束时间
   - 当 uuIds 为空（范围查询模式）：默认取最近 7 天
3. **查询 ES**：调用 `alertDao.getAlertList(openApiAlertQo)` 查询告警列表
   - 查询失败时抛出 IncidentException
4. **数据转换**：将 Alert 实体列表转换为 OpenApiAlertVo 列表
   - 空列表时返回 List.of()（不返回 null）
   - 对每个 Alert：
     - 通过 BeanUtils.copyProperties 拷贝属性到 OpenApiAlertVo
     - gptResult 为 null 时默认设为 0（待研判）
     - gptResultDescription 通过 PrototypeGptResultEnum.getLabelByPrototypeGptResult 获取
     - 调用 enrich 方法富化字段（攻击结果TMG标准化、ATT&CK、业务组名、IP详情等）
5. **封装分页结果**：构造 OpenApiPageResult，设置 page、pageSize、total、item
6. **返回结果**：将 OpenApiPageResult 封装到 OpenApiResponse 返回

### 数据转换逻辑

- 数据来源：ES 告警表（通过 alertDao.getAlertList）
- 字段映射：通过 BeanUtils.copyProperties 从 Alert 拷贝到 OpenApiAlertVo
- 富化逻辑（enrich 方法）：
  - 攻击结果 TMG 标准化：attackResult=1 映射为 attackState=2，attackResult=2 映射为 attackState=1
  - alertDealStatus ← Alert.dealStatus
  - alertDealAction ← Alert.dealAction
  - attckTechnique ← Alert.mitreid
  - hostGroups：通过 groupNameCache.getAssetGroupIdToNameMap 将 hostGroupIds 映射为业务组名列表
  - srcIpInfos/dstIpInfos：通过 IP 详情查询富化资产组、业务组、国家、省份、资产分类
  - threatClassDesc/threatTypeDesc/threatSubTypeDesc：通过威胁分类枚举富化
- 时间字段：firstTime/lastTime/updateTime 为秒级 Long（DAO 从 ES 拿毫秒后 /1000 转秒回填）

### 默认行为

- page 默认 1，pageSize 默认 5
- timeField 默认 lastTime
- sortField 默认 lastTime，sortOrder 默认 asc
- 不指定时间范围时，非精确查询模式默认取最近 7 天
- 精确查询模式（uuIds 非空）下 startTimestamp 默认设为 0（全量）
- gptResult 为 null 时默认设为 0（待研判）
- severities、accessDirections、hostBranchId、hostAssetIds、srcIps、dstIps、whiteStatus、devUids、hostGroupIds、operationLabels、alarmClassifications、dealAction、engineNames、hostIps、excludeDevUids、hostClassify1Ids、threatDefines 默认为空列表

### 特殊规则

1. **精确查询模式**：当 uuIds 非空时进入精确查询模式，时间范围自动设为全量（startTimestamp=0）
2. **timeField 与 sortField 配合**：sortField 建议与 timeField 保持一致以获得更好的查询性能
3. **filterParam 与 excludeParam 区别**：
   - filterParam：包含条件，匹配满足指定字段的告警
   - excludeParam：排除条件，排除满足指定字段的告警，额外支持 srcIps 字段
4. **fuzzyParam 模糊搜索**：支持 alertName 字段的 and/or 条件组合模糊搜索
5. **JSON 字段名**：devUIds（@JsonProperty，U 和 I 均大写）、excludeDevUids（U 和 I 均大写）
6. **sortOrder 大小写**：校验用 ES `org.elasticsearch.search.sort.SortOrder` 的 `toString()`，其返回小写 asc/desc。注意：不是 Spring 的 SortOrder，且不为大写

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| uuIds | array[string] | 否 | - | 告警UUID列表，最多200个元素，每个元素符合UUID格式。注意：字段名为 uuIds（首字母u小写，Ids的I大写）。**必须传 JSON 数组，即使只有一个 UUID 也要 `["xxx"]` 形式——传单字符串 `"xxx"` 会触发 Jackson `MismatchedInputException` 反序列化失败，返回 400 `Parameter error: JSON parse error: Cannot construct instance of java.util.ArrayList`**。使用uuIds时进入精确查询模式，时间范围自动设为全量 | ["abc123", "def456"] |
| uuId | array[string] | 否 | - | **[已废弃]** 告警uuId，建议使用uuIds。最多200个元素，每个元素需符合UUID格式。**同样必须传 JSON 数组**，单元素也要 `["xxx"]` | ["abc123"] |
| timeField | string | 否 | lastTime | 时间字段，指定时间范围查询依据的时间字段。可选值见下方枚举说明 | "lastTime" |
| startTimestamp | long | 否 | - | 查询开始时间戳（秒级，10 位 Long）。uuIds为空且未指定时默认取最近7天；uuIds非空时默认设为0（全量） | 1782864000 |
| endTimestamp | long | 否 | - | 查询结束时间戳（秒级，10 位 Long）。未指定时默认取今天结束时间 | 1783473600 |
| page | integer | 否 | 1 | 页码，最小值1 | 1 |
| pageSize | integer | 否 | 5 | 每页大小，取值范围5~200 | 20 |

**timeField 枚举值说明**（来源：AlertTimeFieldTypeEnum，参考 enum-dictionary.md）：

| 枚举值 | 说明 |
|--------|------|
| firstTime | 最早发生时间 |
| lastTime | 最近发生时间（默认） |
| updateTime | 更新时间 |
| dealTime | 处置时间 |
| occurTime | 发生时间 |
| uploadTime | 上传时间 |
| _insertTime | 入库时间（ES 内部字段名，带下划线前缀） |

#### 字段名严格对照（高风险易错）

本接口 `OpenApiAlertQo` 的字段名单复数与同项目其他接口不完全一致，传错会被 Jackson 静默忽略（默认 `FAIL_ON_UNKNOWN_PROPERTIES=false`），**过滤不生效但不报错**，结果返回未过滤的全量数据。生成方案时必须按下表严格核对字段名：

| 你可能想传的 | 本接口正确字段名 | 错误后果 | 备注 |
|---|---|---|---|
| `severity` | `severities`（复数） | 静默忽略，等级过滤不生效 | QO 类顶层字段为 `severities`（复数） |
| `combineType` / `combineTypes` | 顶层无此字段 | 静默忽略 | 本接口 QO 顶层没有 combineType 字段，不要从其他接口套用 |
| `hostBranchIds`（复数） | `hostBranchId`（**单数**） | 静默忽略，资产组过滤不生效 | 本接口 QO 顶层字段为 `hostBranchId`（单数）。**注意与 alert-aggregation 接口的 `hostBranchIds`（复数）不一致**，跨接口套用必错 |
| `hostAssetIds` | `hostAssetIds`（复数） | 一致 | — |
| `attackResult` | `attackResults`（复数） | 静默忽略 | 本接口 QO 顶层字段为 `attackResults`（复数） |
| `attackState` | `attackStates`（复数） | 静默忽略 | 本接口 QO 顶层字段为 `attackStates`（复数） |
| `dealStatus` | `alertDealStatus` | 静默忽略 | 本接口用 `alertDealStatus`，不是 `dealStatus` |
| `devUids` / `devUIds` | JSON 字段名 `devUIds`（U 和 I 均大写，由 `@JsonProperty("devUIds")` 指定） | 静默忽略 | 本接口 QO 顶层字段为 `devUids`（Java 字段名），但 JSON 必须写 `devUIds` |
| `ruleIds` | 顶层无此字段 | 静默忽略 | 本接口 QO 顶层没有 ruleIds，规则过滤不在 list 接口支持范围 |
| `uuId`（单数，传字符串） | `uuIds`（复数，传数组） | Jackson `MismatchedInputException` 400 | 详见上一行 uuIds 字段说明 |

**通用规则**：
1. 数组类型字段（`array[*]` / `List<*>`）**必须传 JSON 数组**，单元素也要 `["xxx"]`，严禁退化成单值字符串/数字
2. 字段名严格按本表，跨接口套用前必须重新核对（alert-list 与 alert-aggregation 的 `hostBranchId(s)` 单复数不同即为典型反例）
3. 占位符（如 `$ALERT_RULE_IDS`、`<UUID>`）不允许出现在最终方案示例值里——若值依赖前序接口产出，示例用真实格式（如 `["alert-001"]`），并在调用步骤里标注"取自前序步骤 X 的 fieldY"

#### 排序参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| sortField | string | 否 | lastTime | 排序字段。可选值（AlertSortFieldTypeEnum）：firstTime、lastTime、updateTime | "lastTime" |
| sortOrder | string | 否 | asc | 排序方式。可选值：asc（升序）、desc（降序）。注意：枚举值必须小写（ES SortOrder.toString() 返回值） | "desc" |

#### 告警状态过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| alertDealStatus | array[integer] | 否 | [] | 告警处置状态（DealStatusEnum，参考 enum-dictionary.md）：1/待处置, 2/处置中, 3/处置完成, 6/已遏制 | [1, 2] |
| read | boolean | 否 | - | 告警是否已读。true-已读，false-未读 | true |
| whiteStatus | array[string] | 否 | [] | 加白状态（WhiteStatusEnum，参考 enum-dictionary.md）：中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2" | ["未加白"] |
| dealAction | array[string] | 否 | [] | 处置动作列表 | ["block", "alert"] |

#### 告警属性过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| severities | array[integer] | 否 | [] | 告警等级（SeverityEnum 的 scoreNum，参考 enum-dictionary.md）：-1/未知, 0/信息, 1/低危, 2/中危, 3/高危, 4/严重 | [3, 4] |
| threatDefines | array[integer] | 否 | [] | 告警定性（PrototypeGptResultEnum，参考 enum-dictionary.md）：0/待研判, 110/攻击成功, 115/主机失陷活动, 120/病毒木马活动, 130/攻击未成功, 140/弱访问, 150/可疑攻击, 160/误报, 170/数据不足, 180/自定义类型等 | [110, 150] |
| attackStates | array[integer] | 否 | - | 攻击结果状态 | [0] |
| attackResults | array[integer] | 否 | - | 攻击结果 | [1] |
| accessDirections | array[integer] | 否 | [] | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md）：0/无, 1/内对外, 2/外对内, 3/内对内 | [1, 2] |
| gptResult | array[string] | 否 | - | GPT研判结论列表 | ["攻击成功"] |
| operationLabels | array[string] | 否 | [] | 研判标签列表（来源于 `/alerts/labels/list` 接口返回的 name） | ["已确认攻击"] |
| alarmClassifications | array[string] | 否 | [] | 告警分类 ID 字符串数组。元素格式 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`（数字 ID，逗号分隔，最多 3 级）。**严禁传中文名**——后端会逐段 `Integer.parseInt`，传 `"web攻击"` 会抛 NumberFormatException 导致 500。详见 enum-dictionary-pending.md 第 10 节 | `["1", "2,3"]` |

#### 来源设备过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| productType | array[string] | 否 | - | 上报设备类型（AnalysisProductTypeEnum 的 getProductType，值为国际化后的厂商名称）。最少1个，最多200个 | ["sangfor", "NSFOCUS"] |
| devUIds | array[integer] | 否 | [] | 数据源ID列表。注意：JSON字段名为 devUIds（U和I均大写），由 @JsonProperty("devUIds") 指定。值来源于 `/alerts/devUidName` 接口的 value | [2001] |
| devSourceNames | array[string] | 否 | - | 设备来源名称列表 | ["sta", "edr"] |
| engineNames | array[string] | 否 | [] | 检测引擎名称列表 | ["suricata", "IPS引擎"] |
| manages | array[string] | 否 | - | 上报设备ID列表（包含条件） | ["device_abc"] |
| excludeManages | array[string] | 否 | - | 排除上报设备ID列表 | ["device_xyz"] |
| excludeDevUids | array[integer] | 否 | [] | 排除数据源ID列表。注意：JSON字段名为 excludeDevUids（U和I均大写） | [2002] |

#### 资产过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| hostBranchId | array[integer] | 否 | [] | 资产组ID列表 | [101, 102] |
| platformHostBranchIds | array[string] | 否 | - | 平台资产组ID列表 | ["branch_001"] |
| hostAssetIds | array[integer] | 否 | [] | 资产ID列表（内部资产） | [1001, 1002] |
| platformHostAssetIds | array[string] | 否 | - | 主机资产ID（平台类型） | ["host_123"] |
| hostGroupIds | array[integer] | 否 | [] | 业务组ID列表 | [301] |
| hostClassify1Ids | array[integer] | 否 | [] | 主机资产父类型ID列表（Classify1idEnum，参考 enum-dictionary.md） | [10] |
| hostIps | array[string] | 否 | [] | 主机IP列表 | ["192.168.1.100"] |

#### 网络信息过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| srcIps | array[string] | 否 | [] | 源IP列表，支持IPv4/IPv6 | ["192.168.1.1"] |
| dstIps | array[string] | 否 | [] | 目的IP列表，支持IPv4/IPv6 | ["10.0.0.1"] |

#### 平台相关参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| platformIds | array[string] | 否 | - | 平台ID列表 | ["platform_1"] |

#### 高级过滤参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| filterParam | object | 否 | - | 其他过滤字段（包含条件），见下方 filterParam 结构说明 | {"srcHostCountryName": ["中国"]} |
| excludeParam | object | 否 | - | 排除字段（排除条件），见下方 excludeParam 结构说明 | {"srcHostCountryName": ["中国"], "srcIps": ["1.1.1.1"]} |
| fuzzyParam | object | 否 | - | 模糊查询参数，见下方 fuzzyParam 结构说明 | {"alertName": {"and": [{"value": "扫描", "matchType": "like", "likeType": "contains"}]}} |

##### filterParam 结构说明（来源：OpenApiAlertFilterQo）

| 参数名 | 类型 | 必填 | 说明 | 元素限制 | 示例值 |
|--------|------|------|------|----------|--------|
| srcHostCountryName | array[string] | 否 | 攻击源国家名称，最多10个元素，每个元素需符合合法字符格式（正则：COMMON_LEGAL_CHAR_PATTERN） | max=10 | ["中国", "美国"] |
| srcHostProvinceName | array[string] | 否 | 攻击源省份名称，最多10个元素，每个元素需符合合法字符格式 | max=10 | ["广东", "北京"] |
| dstHostCountryName | array[string] | 否 | 目的国家名称 | - | ["中国"] |
| dstHostProvinceName | array[string] | 否 | 目的城市名称 | - | ["上海"] |

##### excludeParam 结构说明（来源：OpenApiAlertExcludeQo）

用于排除特定条件的告警，结构与filterParam类似但多一个srcIps字段：

| 参数名 | 类型 | 必填 | 说明 | 元素限制 | 示例值 |
|--------|------|------|------|----------|--------|
| srcHostCountryName | array[string] | 否 | 排除攻击源国家名称，最多10个元素，每个元素需符合合法字符格式 | max=10 | ["中国"] |
| srcHostProvinceName | array[string] | 否 | 排除攻击源省份名称，最多10个元素，每个元素需符合合法字符格式 | max=10 | ["广东"] |
| dstHostCountryName | array[string] | 否 | 排除目的国家名称 | - | ["中国"] |
| dstHostProvinceName | array[string] | 否 | 排除目的城市名称 | - | ["上海"] |
| srcIps | array[string] | 否 | 排除源IP列表（excludeParam独有字段，filterParam无此字段） | - | ["1.1.1.1"] |

##### fuzzyParam 结构说明（来源：OpenApiAlertQo.FuzzyParam + OpenApiFuzzyParamGroupQo）

fuzzyParam 支持对告警名称等字段进行模糊搜索，采用条件组方式支持 and/or 逻辑组合。

**fuzzyParam 顶层结构**：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| alertName | object | 否 | 告警名称模糊搜索条件组（OpenApiFuzzyParamGroupQo类型） | 见下方示例 |

**alertName 条件组结构**：

| 参数名 | 类型 | 必填 | 说明 | 示例值 |
|--------|------|------|------|--------|
| and | array[FilterCondition] | 否 | AND匹配条件列表，所有条件需同时满足 | [{"value": "扫描", "matchType": "like", "likeType": "contains"}] |
| or | array[FilterCondition] | 否 | OR匹配条件列表，任一条件满足即可 | [{"value": "攻击", "matchType": "like", "likeType": "prefix"}] |

**FilterCondition 结构说明**（来源：OpenApiFuzzyParamGroupQo.FilterCondition）：

| 参数名 | 类型 | 必填 | 说明 | 取值范围/示例 |
|--------|------|------|------|---------------|
| value | string | 是 | 匹配值 | "扫描"、"永恒之蓝" |
| matchType | string | 是 | 匹配类型（MatchTypeEnum） | "="（等于）、"!="（不等于）、"like"（模糊匹配）、"not like"（模糊不匹配） |
| likeType | string | 条件性 | 匹配方式（LikeTypeEnum，当matchType为like/not like时必填） | "contains"（包含）、"prefix"（前缀匹配）、"suffix"（后缀匹配） |

## 返回参数

### 响应结构

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码，成功时为 "Success"（字符串，**非整数 200**） |
| message | string | 响应消息 |
| data | object | 响应数据，见下方 data 结构说明 |

### data 结构说明（来源：OpenApiPageResult）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| total | long | 满足条件的总记录数 |
| page | integer | 当前页码 |
| pageSize | integer | 每页大小 |
| item | array[OpenApiAlertVo] | 告警记录列表，见下方 item 元素结构说明 |

### item 元素结构说明（来源：OpenApiAlertVo）

#### 基本信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| uuId | string | 告警唯一ID | "alert-123456" |
| name | string | 告警名称 | "永恒之蓝" |
| alertRuleId | string | 生成此告警的规则ID | "2123223445000213" |
| logCount | integer | 命中的日志次数，告警聚合处理后的数量 | 10 |
| description | string | 告警描述 | "检测到永恒之蓝攻击行为，目标端口445" |

#### 时间信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| firstTime | long | 最早发生时间（秒级时间戳，10 位 Long） | 1782864000 |
| lastTime | long | 最近发生时间（秒级时间戳，10 位 Long） | 1783473600 |
| updateTime | long | 更新时间（秒级时间戳，10 位 Long） | 1751500000 |
| dealTimeDesc | long | 处置时长（秒） | 3600 |

#### 严重程度信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| severity | integer | 严重性分数 | 0-100，值越高越严重 | 50 |
| confidence | integer | 确定性等级（置信度） | 0-100 | 50 |
| stage | integer | 告警所处的攻击阶段 | 0-100，80表示接近攻击完成 | 80 |

#### 威胁分类信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| threatDefine | array[integer] | 威胁定性列表（PrototypeGptResultEnum，参考 enum-dictionary.md） | [110] |
| threatClassDesc | string | 告警一级分类 | "脆弱性风险" |
| threatTypeDesc | string | 告警二级分类 | "漏洞风险" |
| threatSubTypeDesc | string | 告警三级分类 | "sql注入漏洞" |

#### 攻击信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| attackState | integer | 攻击结果（AttackResultEnum，参考 enum-dictionary.md，TMG标准化后） | 0/尝试, 1/成功, 2/失败, 3/失陷 | 0 |
| direction | integer | 访问方向（AttackDirectionEnum，参考 enum-dictionary.md） | 0/无, 1/内对外, 2/外对内, 3/内对内 | 2 |
| riskTag | array[string] | 风险标签列表 | - | ["HTTP隧道"] |
| exploitCveId | string | 漏洞CVE编号 | - | "CVE-2017-0144" |
| attckTechnique | array[string] | ATT&CK战术技术列表 | 格式：TAxxxx.Txxxx | ["TA0043.T1569.001"] |

#### 网络信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| srcIp | array[string] | 源IP列表 | ["1.1.1.1"] |
| srcPort | array[integer] | 源端口列表 | [80] |
| dstIp | array[string] | 目的IP列表 | ["10.0.0.1"] |
| dstPort | array[integer] | 目的端口列表 | [8080] |
| xForwardedFor | array[string] | X-Forwarded-For头 | ["196.168.1.2"] |
| url | array[string] | URL列表 | ["http://www.example.com/path"] |
| domain | array[string] | 域名列表 | ["www.example.com"] |

#### IP详细信息（嵌套结构）

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| srcIpInfos | array[IpInfo] | 源IP详细信息列表 | 见下方 IpInfo 结构 |
| dstIpInfos | array[IpInfo] | 目的IP详细信息列表 | 见下方 IpInfo 结构 |

**IpInfo 结构说明**（来源：OpenApiAlertVo.IpInfo）：

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| ip | string | IP地址 | "192.168.1.100" |
| branchId | integer | 资产组ID | 123 |
| branchName | string | 资产组名称 | "公安部" |
| groupIds | array[integer] | 业务组ID列表 | [1, 2] |
| groupNames | array[string] | 业务组名称列表 | ["移动警务", "视频专网"] |
| countryName | string | 国家名称 | "中国" |
| provinceName | string | 省份名称 | "广东" |
| classify1Id | integer | 资产大类ID（Classify1idEnum，参考 enum-dictionary.md） | 1 |
| classifyId | integer | 资产小类ID | 101 |

#### 主机资产信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| hostIp | string | 主机IP | "186.12.1.5" |
| hostAssetId | long | 主机资产ID | 12 |
| branchName | string | 所属资产组名 | "上海办事处" |
| hostBranchId | integer | 主机资产组ID | 1 |
| hostGroupIds | array[long] | 业务组ID列表 | [1] |
| hostGroups | array[string] | 所属业务组描述列表 | ["研发中心"] |
| hostClassifyId | integer | 主机资产具体类型ID | 101 |
| hostClassify1Id | integer | 主机资产父类型ID（Classify1idEnum，参考 enum-dictionary.md） | 10 |

#### 文件信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| fileMd5 | array[string] | 文件MD5列表 | ["e90afc86c7b1ab55e9dffa631cef0821"] |
| pName | array[string] | 进程名列表 | ["malware.exe"] |

#### HTTP响应信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| respStatus | integer | HTTP响应状态码 | 200 |

#### 来源设备信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| devUidDesc | array[string] | 数据源设备描述列表 | ["EDR"] |
| engineName | array[string] | 检测引擎名称列表 | ["IPS引擎"] |
| devSourceName | array[string] | 来源设备名称列表 | ["sta (86a45542)"] |

#### 处置状态信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| alertDealStatus | integer | 告警处置状态（DealStatusEnum，参考 enum-dictionary.md） | 1/待处置, 2/处置中, 3/处置完成, 6/已遏制 | 1 |
| alertDealAction | string | 告警处置动作描述 | - | "手动标记" |
| whiteStatus | string | 加白状态（WhiteStatusEnum，参考 enum-dictionary.md） | 中文"未加白"/"已加白"/"部分加白"，国际版"0"/"1"/"2" | "未加白" |

#### 研判信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| gptResult | integer | GPT研判结论编码（PrototypeGptResultEnum，参考 enum-dictionary.md）。默认值0（待研判） | 110 |
| gptResultDescription | string | GPT研判结论描述（国际化后的中文描述） | "攻击成功" |

> 注：服务端在返回 gptResult 时，若原始值为 null 则默认设为 0（待研判）。gptResultDescription 通过 PrototypeGptResultEnum.getLabelByPrototypeGptResult() 获取。

#### 溯源信息

| 字段名 | 类型 | 说明 | 示例值 |
|--------|------|------|--------|
| traceBackId | array[string] | 日志回溯ID列表，用于追溯原始日志 | ["log-xxx-001"] |

## 调用示例

### 示例1：查询最近 7 天的高危告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "severities": [3, 4],
    "sortField": "lastTime",
    "sortOrder": "desc",
    "page": 1,
    "pageSize": 20
}
```

> 注：示例时间戳按 2026-07-05 当前时间 - 7 天计算：2026-06-28 00:00:00 UTC ≈ 1782864000（秒级），2026-07-05 00:00:00 UTC ≈ 1783473600（秒级）。

**响应示例**：
```json
{
    "code": "Success",
    "message": "success",
    "data": {
        "total": 150,
        "page": 1,
        "pageSize": 20,
        "item": [
            {
                "uuId": "alert-123456",
                "name": "永恒之蓝",
                "firstTime": 1782864000,
                "lastTime": 1783473600,
                "updateTime": 1751500000,
                "severity": 85,
                "threatDefine": [110],
                "stage": 80,
                "alertRuleId": "2123223445000213",
                "logCount": 10,
                "confidence": 50,
                "riskTag": ["HTTP隧道"],
                "attackState": 0,
                "direction": 2,
                "threatClassDesc": "脆弱性风险",
                "threatTypeDesc": "漏洞风险",
                "threatSubTypeDesc": "sql注入漏洞",
                "devUidDesc": ["EDR"],
                "engineName": ["IPS引擎"],
                "attckTechnique": ["TA0043.T1569.001"],
                "srcIp": ["192.168.1.100"],
                "srcPort": [80],
                "dstIp": ["10.0.0.50"],
                "dstPort": [445],
                "xForwardedFor": [],
                "hostIp": "10.0.0.50",
                "hostAssetId": 12,
                "branchName": "上海办事处",
                "hostBranchId": 1,
                "hostGroupIds": [1],
                "hostGroups": ["研发中心"],
                "hostClassifyId": 101,
                "hostClassify1Id": 10,
                "url": [],
                "domain": [],
                "fileMd5": [],
                "pName": [],
                "respStatus": null,
                "exploitCveId": "CVE-2017-0144",
                "alertDealStatus": 1,
                "alertDealAction": null,
                "whiteStatus": "未加白",
                "devSourceName": ["sta (86a45542)"],
                "srcIpInfos": [
                    {
                        "ip": "192.168.1.100",
                        "branchId": 123,
                        "branchName": "外部网络",
                        "groupIds": [],
                        "groupNames": [],
                        "countryName": "中国",
                        "provinceName": "北京",
                        "classify1Id": null,
                        "classifyId": null
                    }
                ],
                "dstIpInfos": [
                    {
                        "ip": "10.0.0.50",
                        "branchId": 1,
                        "branchName": "上海办事处",
                        "groupIds": [1],
                        "groupNames": ["研发中心"],
                        "countryName": "中国",
                        "provinceName": "上海",
                        "classify1Id": 1,
                        "classifyId": 101
                    }
                ],
                "description": "检测到永恒之蓝攻击行为，目标端口445",
                "gptResult": 110,
                "gptResultDescription": "攻击成功",
                "traceBackId": ["log-xxx-001"],
                "dealTimeDesc": null
            }
        ]
    }
}
```

### 示例2：精确查询 - 根据告警UUID查询

**请求示例**：
```json
{
    "uuIds": ["alert-123456", "alert-789012"]
}
```

**说明**：当使用 uuIds 进行精确查询时，可以不指定时间范围。服务端通过 `OpenApiTimeRangeUtil.resolveTimestampAllTime` 方法处理：当 uuIds 非空时，startTimestamp 默认设为 0（全量时间范围），endTimestamp 默认取今天结束时间。

### 示例3：组合条件查询 - 查询特定资产组的高危待处置告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "severities": [3, 4],
    "hostBranchId": [101, 102],
    "alertDealStatus": [1],
    "sortField": "lastTime",
    "sortOrder": "desc",
    "page": 1,
    "pageSize": 50
}
```

### 示例4：按攻击源查询 - 查询特定源IP的告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "srcIps": ["192.168.1.100"],
    "page": 1,
    "pageSize": 20
}
```

### 示例5：模糊搜索告警名称 - 搜索包含"扫描"关键字的告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "fuzzyParam": {
        "alertName": {
            "and": [
                {
                    "value": "扫描",
                    "matchType": "like",
                    "likeType": "contains"
                }
            ]
        }
    },
    "page": 1,
    "pageSize": 20
}
```

### 示例6：按来源设备查询 - 查询深信服EDR和STA设备的告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "productType": ["sangfor"],
    "devSourceNames": ["sta", "edr"],
    "page": 1,
    "pageSize": 20
}
```

### 示例7：按攻击源国家过滤查询

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "filterParam": {
        "srcHostCountryName": ["中国", "美国"]
    },
    "page": 1,
    "pageSize": 20
}
```

### 示例8：排除特定条件查询 - 排除某源IP和某国家的告警

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "excludeParam": {
        "srcHostCountryName": ["中国"],
        "srcIps": ["1.1.1.1"]
    },
    "page": 1,
    "pageSize": 20
}
```

**说明**：excludeParam 独有的 srcIps 字段用于排除特定源IP的告警，这是 filterParam 不具备的能力。

### 示例9：多条件组合查询 - 高危+外对内+攻击成功+待处置+特定时间字段

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "timeField": "occurTime",
    "severities": [3, 4],
    "accessDirections": [2],
    "attackStates": [0],
    "alertDealStatus": [1],
    "sortField": "lastTime",
    "sortOrder": "desc",
    "page": 1,
    "pageSize": 20
}
```

**说明**：此示例使用 timeField=occurTime 指定按发生时间进行范围查询，同时组合了高危、外对内、攻击成功、待处置等多个过滤维度。

### 示例10：按研判结论和研判标签查询

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "gptResult": ["攻击成功"],
    "operationLabels": ["已确认攻击"],
    "alertDealStatus": [3],
    "sortField": "lastTime",
    "sortOrder": "desc",
    "page": 1,
    "pageSize": 20
}
```

### 示例11：按数据源ID查询

**请求示例**：
```json
{
    "startTimestamp": 1782864000,
    "endTimestamp": 1783473600,
    "devUIds": [2001, 2002],
    "page": 1,
    "pageSize": 20
}
```

**说明**：devUIds 值来源于 `/alerts/devUidName` 接口返回的 value 字段。注意 JSON 字段名为 devUIds（U和I均大写）。

### 示例12：错误响应示例 - 无效参数

**请求示例**（无效参数）：
```json
{
    "page": 0,
    "pageSize": 500
}
```

**错误响应示例**：
```json
{
    "code": "InvalidParameter",
    "message": "param page min size is 1; param pageSize max is 200",
    "data": null
}
```

### 示例13：权限不足响应

```json
{
    "code": "Unknown",
    "message": "Access Denied",
    "data": null
}
```

## 注意事项与限制

### 参数限制

1. **UUID限制**
   - `uuIds` 和 `uuId` 字段最多支持200个元素
   - 每个UUID元素必须符合UUID格式规范（正则校验：UUID_CHAR_PARTTERN）
   - 建议使用 `uuIds`（Ids的I大写），`uuId` 为旧版字段，已废弃

2. **分页限制**
   - `page` 最小值为1
   - `pageSize` 取值范围为5~200

3. **数组参数限制**
   - `productType` 最多支持200个元素（最少1个）
   - `filterParam` 中的 `srcHostCountryName` 和 `srcHostProvinceName` 最多支持10个元素，每个元素需符合合法字符格式（正则：COMMON_LEGAL_CHAR_PATTERN）
   - `excludeParam` 中的 `srcHostCountryName` 和 `srcHostProvinceName` 最多支持10个元素，每个元素需符合合法字符格式

4. **时间范围**
   - 当不使用 `uuIds` 精确查询时，建议指定 `startTimestamp` 和 `endTimestamp` 时间范围
   - 时间戳为秒级别（10 位 Long）
   - 若不指定时间范围：非精确查询模式下默认取最近7天；精确查询模式下 startTimestamp 默认为0（全量）
   - endTimestamp 未指定时默认取今天结束时间（23:59:59）

### 参数依赖关系

1. **精确查询模式**
   - 当指定 `uuIds` 时，进入精确查询模式（accurateQuery=true）
   - 精确查询模式下，若 startTimestamp 为空则自动设为0（全量时间范围）
   - 不指定 `uuIds` 时，需要配合时间范围参数使用（默认最近7天）

2. **时间字段选择**
   - `timeField` 用于指定时间范围查询依据的字段，默认为 `lastTime`
   - `sortField` 建议与 `timeField` 保持一致以获得更好的查询性能

3. **filterParam 与 excludeParam 的区别**
   - `filterParam`：包含条件，匹配满足指定字段的告警
   - `excludeParam`：排除条件，排除满足指定字段的告警
   - `excludeParam` 额外支持 `srcIps` 字段用于排除特定源IP（filterParam无此字段）

4. **fuzzyParam 使用注意**
   - `matchType` 为 "=" 或 "!=" 时，不需要指定 `likeType`
   - `matchType` 为 "like" 或 "not like" 时，必须指定 `likeType`
   - `and` 和 `or` 可以同时使用，and条件组与or条件组之间为AND关系
   - 当前 fuzzyParam 仅支持 `alertName` 字段的模糊搜索

### 权限要求

- 需要 `superAdmin` 或 `alertQuery` 权限（通过 `@PreAuthorize("hasAnyAuthority('superAdmin', 'alertQuery')")` 控制）
- 权限不足将返回403错误
- 接口会记录操作日志（通过 @OperateLog 注解，target="operate.openapi.log"，action="operate.openapi.get.alerts.log"）

### 性能建议

1. **合理设置时间范围**
   - 时间范围过大可能导致查询超时
   - 建议单次查询时间范围不超过7天

2. **合理设置分页大小**
   - `pageSize` 不建议设置为最大值200，通常20-50为宜
   - 大量数据返回可能导致响应延迟

3. **使用精确查询**
   - 已知告警UUID时，优先使用 `uuIds` 精确查询
   - 精确查询性能优于范围查询

4. **避免过多过滤条件**
   - 过滤条件越多，查询复杂度越高
   - 合理组合过滤条件，避免冗余

5. **排序与时间字段一致性**
   - sortField 建议与 timeField 保持一致，避免ES额外的排序开销

### 数据一致性说明

1. **告警聚合**
   - 同一告警可能包含多条原始日志
   - `logCount` 表示聚合的日志数量

2. **时间戳单位**
   - 入参与返回时间戳均为秒级（10 位 Long）
   - 时间戳示例值必须按"当前时间 - N 天"算出对应秒级时间戳，算不出时标注"以实际调用时为准"，不允许凭空编数字
   - 入参 startTimestamp/endTimestamp 为秒级时间戳；返回 firstTime/lastTime/updateTime 也为秒级时间戳（DAO 从 ES 拿毫秒后 /1000 转秒回填）

3. **IP信息**
   - `srcIp` 和 `dstIp` 为简化的IP列表
   - `srcIpInfos` 和 `dstIpInfos` 包含更详细的IP信息（资产组、地理位置、资产分类等）

4. **字段命名特殊说明**
   - 请求参数中 `devUIds`：在JSON中序列化为 `devUIds`（注意U和I均大写，由 @JsonProperty("devUIds") 注解控制）
   - 请求参数中 `excludeDevUids`：在JSON中序列化为 `excludeDevUids`
   - 请求参数 `timeField` 的入库时间值必须传 `_insertTime`（带下划线前缀，ES 内部字段名）；传 `insertTime` 会被 `@Enum` 校验拦截报 `timeField is illegal`
   - 请求参数 `uuIds`：首字母u小写，Ids的I大写（区别于已废弃的uuId）

5. **排序值大小写**
   - `sortOrder` 的枚举值为小写：`asc`、`desc`
   - 校验用 ES 的 `org.elasticsearch.search.sort.SortOrder`，其 `toString()` 返回小写（`SortOrder.ASC.toString()` 返回 "asc"，`SortOrder.DESC.toString()` 返回 "desc"），不是 Spring 的 SortOrder

6. **gptResult默认值**
   - 服务端在转换时，若原始gptResult为null，则默认设为0（待研判）
   - gptResultDescription 通过 PrototypeGptResultEnum.getLabelByPrototypeGptResult() 获取

7. **攻击结果TMG标准化**
   - 服务端在 enrich 方法中对 attackResult 进行 TMG 标准化映射
   - attackResult=1 映射为 attackState=2，attackResult=2 映射为 attackState=1
   - 其他值直接赋值

8. **BeanUtils.copyProperties映射**
   - 返回的 OpenApiAlertVo 通过 BeanUtils.copyProperties 从 Alert 实体拷贝属性
   - 字段名与 Alert 实体字段保持一致

## 常见错误

| HTTP | 说明（服务端原始信息，非响应 code 字段） | 原因 | 解决方案 |
|--------|------|------|----------|
| 400 | param page min size is 1 | page参数小于1 | 设置page >= 1 |
| 400 | param pageSize min is 5 | pageSize参数小于5 | 设置pageSize >= 5 |
| 400 | param pageSize max is 200 | pageSize参数大于200 | 设置pageSize <= 200 |
| 400 | param uuId max size is 200 | uuId元素超过200个 | 减少uuId元素数量 |
| 400 | param uuIds max size is 200 | uuIds元素超过200个 | 减少uuIds元素数量 |
| 400 | timeField is illegal | timeField值无效 | 使用正确的枚举值：firstTime/lastTime/updateTime/dealTime/occurTime/uploadTime/_insertTime |
| 400 | param sortField is invalid value. | sortField值无效 | 使用正确的枚举值：firstTime/lastTime/updateTime |
| 400 | param sortOrder is invalid value. | sortOrder值无效 | 使用asc或desc（小写） |
| 400 | param alertDealStatus illegal | alertDealStatus值不在枚举范围内 | 使用合法值：1/2/3/6（来源DealStatusEnum） |
| 400 | param severitys illegal | severities值不在枚举范围内 | 使用合法scoreNum值：-1/0/1/2/3/4（来源SeverityEnum） |
| 400 | param accessDirections illegal | accessDirections值不在枚举范围内 | 使用合法值：0/1/2/3（来源AttackDirectionEnum） |
| 400 | param productType is invalid value. | productType值不在枚举范围内 | 使用合法的设备厂商名称（来源AnalysisProductTypeEnum） |
| 400 | param productType size min is 1, max is 200 | productType元素数量不合法 | 元素数量在1~200之间 |
| 400 | param matchType is invalid value. | fuzzyParam中的matchType值无效 | 使用：=、!=、like、not like（来源MatchTypeEnum） |
| 400 | param likeType is invalid value. | fuzzyParam中的likeType值无效 | 使用：contains、prefix、suffix（来源LikeTypeEnum） |
| 400 | srcHostCountryName fields size out of range | filterParam/excludeParam的srcHostCountryName超过10个元素 | 减少元素数量至10个以内 |
| 400 | srcHostCountryName invalid field format | filterParam/excludeParam的srcHostCountryName元素格式不合法 | 使用符合COMMON_LEGAL_CHAR_PATTERN正则的字符 |
| 400 | srcHostProvinceName fields size out of range | filterParam/excludeParam的srcHostProvinceName超过10个元素 | 减少元素数量至10个以内 |
| 403 | Access Denied | 权限不足 | 联系管理员添加superAdmin或alertQuery权限 |
| 500 | exception.method.execute | 服务端查询执行异常（如ES连接失败等IOException） | 联系技术支持，检查ES集群状态 |

## 最佳实践

1. **首次使用建议**
   - 先使用小范围时间（如最近1小时）和小分页（pageSize=5）测试接口
   - 确认返回数据格式和字段含义后再扩大查询范围
   - 验证权限配置是否正确

2. **批量查询优化**
   - 批量查询已知UUID的告警时，使用`uuIds`精确查询模式，每次不超过200个UUID
   - 大量未知UUID需分批查询时，每批次建议20-50条，避免单次返回数据量过大

3. **时间范围设置**
   - 日常监控场景建议使用最近24小时或7天的时间范围
   - 历史回溯场景可按天分批查询，避免单次查询跨度过大
   - 不指定时间范围时默认为最近7天，需注意是否符合业务需求

4. **精确查询与范围查询选择**
   - 已知告警UUID时，优先使用`uuIds`精确查询（自动设为全量时间范围）
   - 未知UUID时，结合时间范围+过滤条件缩小查询范围
   - 精确查询模式（uuIds非空）下startTimestamp默认为0，无需指定时间

5. **组合过滤条件策略**
   - 使用`filterParam`做正向包含过滤（如：指定攻击源国家）
   - 使用`excludeParam`做反向排除过滤（如：排除特定源IP）
   - 使用`fuzzyParam`做告警名称模糊搜索（如：搜索包含特定关键词的告警）
   - 三者可同时使用，但条件越多查询越慢，需权衡

6. **错误处理与重试**
   - 解析响应时首先检查 `code` 字段，"Success" 为成功，其他为失败
   - 根据 `message` 字段判断具体错误原因并针对性修正参数
   - 500错误可能为ES集群异常，建议短暂间隔后重试
   - 403错误需联系管理员添加权限，不可重试

7. **配合其他接口使用**
   - 获取告警列表后，如需批量处置：将返回的 uuId 列表传入 `/api/xdr/v1/alerts/dealstatus` 接口（POST）
   - 如需获取告警聚合统计：使用 `/api/xdr/v1/alerts/aggregation` 接口
   - 如需查询研判标签选项：使用 `/api/xdr/v1/alerts/labels/list` 接口
   - 如需获取GPT研判结论枚举：使用 `/api/xdr/v1/alerts/gptresult/type` 接口（GET）
   - 如需获取数据源ID列表（用于 devUIds 过滤）：使用 `/api/xdr/v1/alerts/devUidName` 接口（GET）
