# POST /api/xdr/v1/risk/list

## 接口概述

本接口用于分页查询脆弱性风险列表（漏洞/弱密码/基线）。通过本接口，您可以获取以下内容：

### 可查询/操作的脆弱性信息
- **风险基本信息**：风险名称、风险等级、风险类型（漏洞/弱密码）、检测方式、唯一标识（md5_name_asset/event_id）
- **资产信息**：资产 ID、资产 IP、资产名、主机名、资产类型、资产标签、资产重要性、互联网暴露、业务组
- **状态信息**：处置状态、修复优先级、工单状态、验证状态、加白状态、处置标签
- **时间信息**：发现时间、最近扫描时间、更新时间（同时返回时间戳与 UTC 字符串）
- **威胁信息**：威胁标签、攻击类型、攻击状态、CVSS 分数、CVE/CNVD/CNNVD/bugtraq_id
- **来源信息**：数据源（src_type）、适配器（adapter）、平台信息（platform_id/group_names）

## 接口定位

| 属性 | 值 |
|------|-----|
| 所属 Resource | `OpenApiRiskListV2` |
| 视图文件 | `soar/apps/vuln_web/app/open_api/v2/risk/view.py` |
| 业务函数 | `soar/apps/vuln_web/app/open_api/v1/risk/business.py` → `get_risk_list(req)`（注意：v2 视图复用 v1 的 business 与 params） |
| 请求 Schema | `soar/apps/vuln_web/app/open_api/v1/risk/params.py` → `RISK_LIST` |
| 所属业务域 | OpenAPI v2 风险管理 - **风险视角** |
| 数据源表 | `vul_risk_middle`（**风险视角中间表**，按 `md5_name_asset` 去重的漏洞-资产关联记录） |
| 接口分类 | 风险列表查询 |
| 前置依赖 | 无（可直接调用），但返回的业务组、平台信息依赖 ts_db/branch 与 platform 数据 |
| 关联接口 | `/api/xdr/v1/risk/info`（按 sfid 批量取漏洞描述与解决方案）、`/api/xdr/v1/vuls/risk/aggregation/*`（按等级/攻击类型聚合） |

> **风险视角 vs 资产视角（关键区分）**：本接口属于**风险视角**，数据源是 `vul_risk_middle` 表，与前端"漏洞风险列表"页面一致；**资产视角**接口（如 `POST /api/xdr/v1/vuls/asset/stats`、`POST /api/xdr/v1/vuls/asset/list`）数据源是 `host_vul_middle` 表，与前端"资产漏洞列表"页面一致。两个视角的数据同步存在时差、字段映射差异，统计同一需求可能得到不同结果（实测同一筛选条件下风险视角 16 条 vs 资产视角 6 条）。**需求中出现"漏洞风险列表/漏洞风险数量"时，应选风险视角接口（本接口或 `/vuls/risk/aggregation/count`），不要选资产视角接口**。

## 使用场景

1. **风险列表分页查询**：在 SOC 控制台风险页面按条件分页加载风险数据。
2. **多条件组合筛选**：按风险类型 + 等级 + 处置状态 + 时间范围 + 资产维度（业务组/资产 ID/资产标签/重要性/暴露）组合过滤。
3. **按漏洞名/关键字模糊搜索**：通过 `name`（仅漏洞名）或 `keyword`（多字段模糊）定位具体风险。
4. **威胁标签 / 攻击类型反查**：前端传入中文枚举值（如"会话劫持"），后端自动反查英文键回查 DB。
5. **按 md5_name_asset 精确定位**：通过 `md5_name_assets` 数组精确定位一组风险记录（工单联动场景）。
6. **按数据源筛选**：通过 `source_device` 数组筛选来自 EDR/SIP/CWPP 等设备的风险。
7. **跨平台 / 多业务组筛选**：通过 `platform_ids`、`branch_ids`、`group_ids` 实现多平台多业务组联合查询。

## 接口信息

| 属性 | 值 |
|------|-----|
| 请求方式 | POST |
| 请求路径 | `/api/xdr/v1/risk/list`（网关路径，对应后端 `/order/v2/openapi/risk/list`） |
| Content-Type | application/json |
| 权限要求 | `hasPolicies("superAdmin")` 或 `hasPolicies("riskManageQuery")`（任一即可） |
| 鉴权失败响应 | `ACCESS_DENY_RESPONSE`（由 `@auth_expr` 直接返回，不走 `output()` 3 状态外壳） |
| 响应外壳 | `output(open_api=True)`，即 `{"code": "<str>", "message": "...", "data": {...}}`，`code` 为字符串型 |

## 业务逻辑

### 核心处理流程

1. **权限校验**：`@auth_expr` 先于参数校验执行，无 `superAdmin` 或 `riskManageQuery` 权限直接返回 `ACCESS_DENY_RESPONSE`。
2. **参数校验**：`@frontend_validate(params.RISK_LIST)` 按 JSON Schema 校验请求体；失败抛 `V1Error.INVALID_PARAMETER`（1104）→ HTTP 400。
3. **空过滤快速返回**：`business.get_risk_list(data)` 首先检查 `md5_asset_name_platform_filter` 是否为空列表，是则直接返回 `{"list": [], "total": 0}`（避免误全表扫描）。
4. **威胁标签 / 攻击类型反向映射**：调用 `_assemble_risk_list_statistics(data, ...)`，将前端传入的中文 `attack_type`、`threat_tag` 反向映射成英文键，扩展到查询条件中（详见"特殊规则"）。
5. **总数查询**：调用 `MyVulRiskMiddle.risk_num(data)`，通过 `MyVulRiskMiddleQuery.generate_query(data)` 构造 MongoDB filter，再用 `db_command count` 取总数。`total=0` 时直接返回 `{"list": [], "total": 0}`。
6. **分页查询**：调用 `MyVulRiskMiddle.risk_list(data)`，使用同一 `generate_query` 生成的 filter，叠加默认排序与 projection，调用 `find_many(skip=offset, limit=limit, allow_disk_use=True)`。
7. **结果组装**：`_assemble_risk_list_result(results, statistics_threat_tags, statistics_attack_types)` 对每条记录：
   - 反查业务组名（`MyBranch.get_branch_by_ids`）
   - 反查 CVE/CNVD/CNNVD/bugtraq_id（`MyVulnInfo.get_infos` + `MyUserVulnInfo.get_infos`，按 `sf_id` 关联）
   - 反查资产组名（`GroupModel.get_groups_names_by_ids`）
   - 渲染平台信息（`render_platform_info`，注入平台相关字段）
   - 对每条记录做字段映射（详见"数据转换逻辑"）
8. **返回**：`output(data={"list": results, "total": total}, open_api=True)`。

### 数据转换逻辑

DAO 返回的 MongoDB 文档字段名 → 接口返回字段名映射（来自 `_assemble_risk_list_result._format_item`）：

| 源字段（MongoDB） | 目标字段 | 转换逻辑 |
|---|---|---|
| `md5_name_asset` | `event_id`、`id` | 同值复制两份，作为唯一标识 |
| `name` | `name` | `Markup(name).unescape()` 反转 HTML 实体 |
| `level` | `risk_level`（保留原值） + `level`（映射为英文） | `level` 字段被覆盖为 `RISK_LEVEL_MAP[level]`（如 `2` → `"high"`） |
| `data_type` | `type` | 直接复制 |
| `asset`（数组） | `asset`（首个 IP） + `all_ip_list`（其余 IP） | 通过 `format_ip_v2` 格式化 |
| `asset_type`（int） | `asset_type`（英文 str） | `ASSET_TYPE_MAP[asset_type]`（如 `1` → `"server"`） |
| `user`（list[dict]） | `manager`（逗号分隔 str） | 提取 `name` 去重后 `","` 拼接 |
| `business_id` | `business_name` | 通过 `business_ids_names_map` 反查；未找到时填 `NO_CLASSIFY_GROUP`（未归类组） |
| `update_time`/`found_time`/`last_time` | `*_time`（UTC str） + `*_time_stamp`（int 时间戳） | `datetime2utc_str` + `datetime2timestamp` 双写 |
| `threat_tags`（list[str]） | `threat_tag` + `threat_tags`（list 中文名） | 通过 `statistics_threat_tags` 反查中文名 |
| `scan_type`（list[int] 小类） | `scan_type`（list[int] 大类） | `ScanTypeUtils.small2big` 小类 → 大类聚合 |
| `asset_exposure` | `asset_exposure` | `asset_exposure_to_api(...)` |
| `magnitude` | `magnitude` | `asset_magnitude_to_api(...)` |
| `exposure` | `exposure` | `port_exposure_to_api(...)` |
| `fix_priority_level` | `vpt_desc` | `FIX_PRIORITY_LEVEL_DESC[fix_priority_level].field()` 取描述 |
| `fix_priority_level` | `fix_priority` | 缺省时填 `FixPriorityLevel.Number.LOW`（1） |
| `deal_status` | `fixed_status` | 字段重命名 |
| `cvss.baseScore` | `cvss_score` | 缺省时 `DEFAULT_FIX_PRIORITY_SCORE`（0） |
| `risk_level`（原 `level`） | `cvss_level` | 与 `risk_level` 同值 |
| `sf_id` + `sf_ids_map` | `cve`、`cnvd`、`cnnvd`、`bugtraq_id` | 通过 `MyVulnInfo` / `MyUserVulnInfo` 反查 |
| `order_status` | `order_status` | 缺省 `OrderStatus.PENDING`（0） |
| `group_id` + `group_dict` | `group_names` | 逗号拼接，按 `platform_id` 维度查询 |
| `option` | `option_*` | `make_option_prefix` 展平自定义字段 |
| `attack_type`（英文键） | `attack_type`（中文名） | 通过 `statistics_attack_types` 反查；找不到时保留原值 |
| `is_hot`、`is_high_availability` | 同名 | 若 `data_type == DataType.WEAK_PWD`，强制设为 `YES`（详见陷阱 #27） |
| `src_type` + `adapter` | `src_type` | `SourceUtils.determine_source` 合并计算 |
| `tags` | `tags` | 漏洞类型通过 `LOOPHOLE_TAGS_MAP` 映射为英文；弱密码类型直接填 `[name]` |

### 默认行为

- **`limit` 不传**：DAO 层使用 `LIMIT_COUNT`（来自 `vuln_web/app/common/constants.py`），即默认分页大小。
- **`offset` 不传**：DAO 层使用 `OFFSET_COUNT`（默认 0）。
- **`offset == -1`**：DAO 不添加 `skip`，等价于"从头开始"。
- **`limit == -1`**：DAO 不添加 `limit`，等价于"不限制条数"（慎用）。
- **不指定排序**：默认排序键为 `[("deal_status", 1), ("fix_priority_level", -1), ("count", -1), ("last_time", -1), ("found_time", -1), ("md5_name_asset", 1)]`，即"待处置优先 → 修复优先级高优先 → 风险数多优先 → 最近发现优先 → 首次发现优先 → md5_name_asset 升序"。
- **`fix_priority_level` 缺省**：组装结果时填 `FixPriorityLevel.Number.LOW`（1）。
- **`order_status` 缺省**：组装结果时填 `OrderStatus.PENDING`（0）。
- **`is_hot` / `is_high_availability` 缺省**：弱密码类型强制 `YES`，其它类型保留 DB 原值。
- **`cvss.baseScore` 缺省**：填 `DEFAULT_FIX_PRIORITY_SCORE`（0）。
- **`business_id` 找不到业务组**：`business_name` 填 `NO_CLASSIFY_GROUP`（未归类组）。
- **`name` 字段语言**：DAO projection 使用 `f"$name_{lang}"`，按当前语言环境动态选 `name_zh` / `name_en` 字段。

### 特殊规则

1. **威胁标签 / 攻击类型中英反查（陷阱 #15）**：前端传入 `attack_type`（string，中文如"会话劫持"）和 `threat_tag`（list[string]，中文如"APT利用"），`_assemble_risk_list_statistics` 将其与 `MyStatistics.get_attack_type()` / `MyStatistics.get_threat_tag()` 返回的字典做反向匹配，找到所有匹配的英文键后扩展为 `$or` 条件。**传入的是中文，最终查 DB 用的是英文键**。
2. **`name` 字段两种形态（陷阱 #11）**：当 `name` 为 `str` 时走 `build_name_query`（单一模糊匹配）；当 `name` 为 `dict`（含 `op`/`val`，op 取值 `=`/`like`）时走 `build_vuln_name_query`，组装为 `$or` 多条件。
3. **`fixed_status` 的 OR 查询（陷阱 #16）**：`build_fixed_status_or_query` 因 `VulRiskMiddle` 表的 `fixed_status` 字段同时存在 list 和 string 两种存储形式，统一用 `$or` + `$elemMatch` 适配；`MyVulnerabilityQuery` 子类对 `data_type == DataType.LOOPHOLE` 走简化分支。

   > **陷阱 #16.1（`fixed_status` 入参 schema 枚举 ≠ 返回值枚举）**：`FixedStatus` 枚举类定义了 `100/处置完成`，**返回值字段 `fixed_status` 也可能取 `100`**，但 `RISK_LIST` Schema 的入参 `fixed_status` 字段 `enum` 仅允许 `0–7`，**传 `100` 会触发 schema 校验失败**，返回形态不是 `output(open_api=True)` 外壳的字符串 `"0"`，而是 `{"code": 1, "message": "fixed_status内容不符合限制", "msg": "fixed_status内容不符合限制"}`（`code` 为整数 `1`，且 `message` 与 `msg` 同值）。调用方传入 `fixed_status` 时务必仅用 `0–7`。
4. **`md5_asset_name_platform_filter` 空列表快速返回**：避免误触发全表扫描，业务入口处显式拦截。
5. **`platform_ids` 多平台支持**：通过 `AssetQueryBuilder.build_platform_query` 处理，可与 `branch_ids`、`group_ids` 组合实现跨平台跨业务组联合查询。
6. **`limit`/`offset` 上限**：JSON Schema 限定 `limit` 0–100、`offset` ≥ 0；`limit=0` 在 DAO 不添加 `limit` 限制（与 `limit=-1` 等价），但 Schema 层会接受 `0`。
7. **`escape` 字段**：Schema 中 `escape: ['keyword', 'name']`，表示这两个字段在 `frontend_validate` 时做 HTML 转义处理（防 XSS）。
8. **`required` 数组的隐藏陷阱（陷阱 #2）**：`RISK_LIST` 的 `required` 写成 `'required '`（带尾随空格），实际不会触发必填校验——即 `limit` / `offset` 在 Schema 层并不强制必填，由 DAO 缺省值兜底。

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| Content-Type | string | 是 | application/json |
| Authorization | string | 是 | 鉴权 token（由网关 sangfor-aksk 处理，业务代码不直接读取） |

### 请求体参数

#### 基础参数

| 参数名 | 类型 | 必填 | 默认值 | 取值范围/说明 | 示例值 |
|--------|------|------|--------|---------------|--------|
| limit | integer | 否（Schema 标注必填但实际不校验，见陷阱 #2） | DAO 默认 `LIMIT_COUNT` | 0–100；0/-1 表示不限制 | 20 |
| offset | integer | 否（同上） | 0 | ≥ 0；-1 表示从头开始 | 0 |
| scan_type | array[integer] | 否 | 无 | 检测方式大类（BigScanType，参考 enum-dictionary-python.md）。0/全部, 1/原理扫描, 2/版本比对, 3/弱密码识别 | [1, 2] |
| data_type | array[string] | 否 | 无（含基线需用 `RISK_TYPE2`，本接口未启用） | 脆弱性类型（DataType）。"loophole"/漏洞, "weak_pwd"/弱密码 | ["loophole"] |
| fix_priority | array[integer] | 否 | 无 | 修复优先级（FixPriorityLevel.Number）。0/无, 1/低, 2/中, 3/高 | [2, 3] |
| threat_tag | array[string] | 否 | 无 | 威胁标签中文名；后端会反查英文键回查 DB（陷阱 #15）。可选值参考 `MyStatistics.get_threat_tag()` 返回 | ["病毒利用", "有攻击代码披露"] |
| source_device | array[string] | 否 | 无 | 数据源设备 short_name，单元素 maxLength=64；可选值参考 `SOURCE_DEVICE_INFO`（edr/sip/cwpp/yj/sta/manual 等） | ["edr", "sip"] |
| name | string 或 object | 否 | 无 | 漏洞名模糊匹配；str 走单字段 like，dict 形如 `{"op": "like"/"=", "val": "xxx"}`（陷阱 #11） | "Log4j" |
| keyword | string | 否 | 无 | 关键字模糊匹配（多字段 OR），pattern=COMMON_SPECIAL_CHAR，maxLength=100 | "CVE-2021" |
| attack_type | string | 否 | 无 | 攻击类型中文名；后端反查英文键（陷阱 #15）。可选值参考 `MyStatistics.get_attack_type()` 返回 | "会话劫持" |
| latest_time_range | array[integer] | 否 | 无 | 最近扫描时间范围 [begin, end]，UNIX 时间戳，长度 0–2 | [1700000000, 1700086400] |
| first_time_range | array[integer] | 否 | 无 | 首次发现时间范围，格式同上 | [1699000000, 1699900000] |
| update_time_range | array[integer] | 否 | 无 | 更新时间范围，格式同上 | [1700000000, 1700086400] |
| fixed_status | array[integer] | 否 | 无 | 处置状态（FixedStatus，参考 enum-dictionary-python.md）。**仅 0–7 有效**：0/待处置, 1/处置中, 2/已修复, 3/已接受, 4/已忽略, 5/误报, 6/改善, 7/加白。**传 `100` 会被 schema 拒绝**（实测返回 `code:1, "fixed_status内容不符合限制"`，详见"常见错误"段） | [0, 1] |
| md5_name_assets | array[string] | 否 | 无 | 精确定位的风险唯一标识列表，每项匹配 `MD5_REGEX` | ["a3f5...e1"] |
| magnitude | array[string] | 否 | 无 | 资产重要性（APIAssetMagnitude）。"normal"/普通, "core"/核心 | ["core"] |
| exposure | array[string] | 否 | 无 | 互联网暴露（APIExposureField）。"yes"/暴露, "no"/未暴露, "unknown"/未知 | ["yes"] |
| order_status | array[integer] | 否 | 无 | 工单状态（OrderStatus）。0/待发起, 1/工单处理中, 2/工单已完成 | [0, 1] |
| attack_state | array[integer] | 否 | 无 | 攻击状态（AttackState，IntEnum）。0/尝试, 1/失败, 2/成功, 3/失陷 | [2, 3] |
| platform_ids | array[string] | 否 | 无 | 平台 ID 列表，每项 minLength=1, maxLength=100；用于跨平台查询 | ["platform-001"] |

#### 枚举字段取值说明

##### scan_type（检测方式大类 BigScanType）

| 值 | 名称 |
|---|---|
| 0 | 全部（ALL） |
| 1 | 原理扫描（PRINCIPLE_SCAN） |
| 2 | 版本比对（VERSION_COMPARISON） |
| 3 | 弱密码识别（WEAK_PASSWORD） |

##### data_type（脆弱性类型 DataType）

| 值 | 名称 |
|---|---|
| "loophole" | 漏洞 |
| "weak_pwd" | 弱密码 |

> 注：基线（"baseline"）虽在 `DataType` 中定义，但 `RISK_LIST` Schema 使用的是 `RISK_TYPE`（仅含 loophole / weak_pwd），**本接口不支持按基线查询**。如需查基线请用 `/api/xdr/v1/vuls/risk/aggregation/baselineLevel` 等接口。

##### fix_priority（修复优先级 FixPriorityLevel.Number）

| 值 | 名称 |
|---|---|
| 0 | 无（WITHOUT） |
| 1 | 低（LOW） |
| 2 | 中（MIDDLE） |
| 3 | 高（HIGH） |

##### fixed_status（处置状态 FixedStatus）

| 值 | 名称 |
|---|---|
| 0 | 待处置（PENDING） |
| 1 | 处置中（HANDLING） |
| 2 | 已修复（FIXED） |
| 3 | 已接受（ACCEPTED） |
| 4 | 已忽略（IGNORED） |
| 5 | 误报（FALSE_POSITIVE） |
| 6 | 改善（IMPROVE） |
| 7 | 加白（WHITELIST） |

> **注：`100`（DISPOSAL_COMPLETED）虽然在 `FixedStatus` 枚举类中定义，但 `RISK_LIST` Schema 的 `fixed_status` 字段不接受 `100`，传 `100` 会触发 schema 校验失败**（实测返回 `code:1, "fixed_status内容不符合限制"`）。`100` 仅作为返回值字段 `fixed_status` 的可能取值出现（见返回参数段）。

##### order_status（工单状态 OrderStatus）

| 值 | 名称 |
|---|---|
| 0 | 待发起（PENDING） |
| 1 | 工单处理中（RUNNING） |
| 2 | 工单已完成（FINISH） |

##### attack_state（攻击状态 AttackState）

| 值 | 名称 |
|---|---|
| 0 | 尝试（ATTEMPT） |
| 1 | 失败（FAIL） |
| 2 | 成功（SUCCESS） |
| 3 | 失陷（FALL） |

##### magnitude（资产重要性 APIAssetMagnitude）

| 值 | 名称 |
|---|---|
| "normal" | 普通 |
| "core" | 核心 |

##### exposure（互联网暴露 APIExposureField）

| 值 | 名称 |
|---|---|
| "yes" | 暴露 |
| "no" | 未暴露 |
| "unknown" | 未知 |

## 返回参数

### 响应结构（open_api=True 外壳）

| 参数名 | 类型 | 说明 |
|--------|------|------|
| code | string | 响应码字符串。`"0"` 表示成功；其它值参考 `V1Error.V1_ERROR_MAP`（注意：`output(open_api=True)` 走的是 `str(code)` 分支，不经过 V1_ERROR_MAP 转换） |
| message | string | 响应消息，缺省 "success" |
| data | object | 响应数据，见下 |

> **响应外壳陷阱**：`OpenApiRiskListV2` 使用 `output(open_api=True)`，即 `code` 直接 `str(0) = "0"`，**不经过 `V1Error.V1_ERROR_MAP` 转换**；而 `v1_open_api=True` 才会走 V1_ERROR_MAP。详见 `python-extraction-vuln.md` 陷阱 #4。

### data 结构说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| list | array[object] | 风险列表，元素结构见下 |
| total | integer | 总数（来自 `MyVulRiskMiddle.risk_num`） |

### list 元素结构说明

#### 风险基本信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| id | string | 风险唯一标识，同 `md5_name_asset` | MD5 字符串 | "a3f5c9...e1" |
| event_id | string | 风险事件 ID，同 `md5_name_asset` | MD5 字符串 | "a3f5c9...e1" |
| md5_name_asset | string | 风险-资产联合唯一标识（DAO 原始字段） | MD5 字符串 | "a3f5c9...e1" |
| name | string | 漏洞名称（已 `Markup.unescape()` 反转 HTML 实体） | 任意字符串 | "Apache Log4j2 远程代码执行漏洞" |
| type | string | 脆弱性类型（参考 enum-dictionary-python.md，DataType）。"loophole"/漏洞, "weak_pwd"/弱密码 | "loophole" | "loophole" |
| risk_level | integer | 原始风险等级（参考 enum-dictionary-python.md，RiskLevel）。-1/信息, 0/低, 1/中, 2/高, 3/严重 | 2 | 2 |
| level | string | 英文风险等级（参考 enum-dictionary-python.md，RiskLevelEn）。"info"/"low"/"middle"/"high"/"critical" | "high" | "high" |
| cvss_score | number | CVSS 基础分，缺省 0 | 0–10 | 9.8 |
| cvss_level | integer | CVSS 等级，同 `risk_level` | -1/0/1/2/3 | 2 |
| fix_priority | integer | 修复优先级（参考 enum-dictionary-python.md，FixPriorityLevel.Number）。0/无, 1/低, 2/中, 3/高；缺省 1 | 0–3 | 3 |
| vpt_desc | string | 修复优先级描述，来自 `FIX_PRIORITY_LEVEL_DESC` | 本地化字段对象 | "高" |
| fixed_status | integer | 处置状态（参考 enum-dictionary-python.md，FixedStatus）。0–7/100 | 0 | 0 |
| scan_type | array[integer] | 检测方式大类（已用 `ScanTypeUtils.small2big` 聚合，参考 enum-dictionary-python.md，BigScanType）。0/1/2/3 | [1, 2] | [1, 2] |
| tags | array[string] | 漏洞标签英文键；弱密码时为 `[name]` | 字符串列表 | ["ATTACK_CODE_DISCLOSURE"] |
| threat_tag | array[string] | 威胁标签中文名列表，由 `ThreatTagUtils.construct_response` 渲染 | 字符串列表 | ["有攻击代码披露"] |
| threat_tags | array[string] | 威胁标签中文名列表（与 `threat_tag` 同源，可能存在差异） | 字符串列表 | ["有攻击代码披露"] |
| attack_type | string | 攻击类型中文名，由 `statistics_attack_types` 反查 | 字符串 | "会话劫持" |

#### 资产信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| asset_id | integer | 资产 ID | >0 | 12345 |
| asset | string | 资产主 IP（首个，经 `format_ip_v2` 格式化） | IP 字符串 | "10.1.1.1" |
| all_ip_list | array[string] | 其余 IP 列表（去除首个） | IP 字符串列表 | ["10.1.1.2"] |
| asset_type | string | 资产类型英文（参考 enum-dictionary-python.md，AssetTypeEn）。"all"/"server"/"terminal"/"other" | "server" | "server" |
| asset_name | string | 资产名 | 任意字符串 | "web-server-01" |
| host_name | string | 主机名 | 任意字符串 | "web-server-01" |
| asset_tags | array[string] | 资产标签 | 字符串列表 | ["internet-facing"] |
| magnitude | string | 资产重要性（参考 enum-dictionary-python.md，APIAssetMagnitude）。"normal"/"core" | "core" | "core" |
| exposure | string | 端口互联网暴露（参考 enum-dictionary-python.md，APIExposureField）。"yes"/"no"/"unknown" | "yes" | "yes" |
| asset_exposure | string | 资产互联网暴露，由 `asset_exposure_to_api` 转换 | 同上 | "yes" |
| manager | string | 资产责任人名（多个用逗号拼接，去重） | 字符串 | "alice,bob" |
| user | array[object] | 资产责任人原始列表 | 对象列表 | [{"name": "alice"}] |
| business_name | string | 所属业务组名；找不到时填 `NO_CLASSIFY_GROUP`（未归类组） | 字符串 | "研发部" |
| group_names | string | 资产组名逗号拼接（按 `platform_id` 维度查询） | 字符串 | "edge-servers,web-servers" |

#### 状态信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| order_status | integer | 工单状态（参考 enum-dictionary-python.md，OrderStatus）。0/待发起, 1/工单处理中, 2/工单已完成；缺省 0 | 0–2 | 1 |
| order_update_time | string | 工单更新时间 UTC 字符串 | ISO 时间字符串 | "2026-08-25 10:00:00" |
| order_update_time_stamp | integer | 工单更新时间 UNIX 时间戳 | ≥0 | 1724580000 |
| is_hot | integer | 是否热点（IsHotSpot）。0/否, 1/是；弱密码类型强制 1 | 0/1 | 1 |
| is_high_availability | integer | 是否高可用（IsHighAvailable）。0/否, 1/是；弱密码类型强制 1 | 0/1 | 1 |

#### 时间信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| found_time | string | 发现时间 UTC 字符串 | ISO 时间字符串 | "2026-08-01 10:00:00" |
| found_time_stamp | integer | 发现时间 UNIX 时间戳 | ≥0 | 1722506400 |
| last_time | string | 最近扫描时间 UTC 字符串 | ISO 时间字符串 | "2026-08-25 10:00:00" |
| last_time_stamp | integer | 最近扫描时间 UNIX 时间戳 | ≥0 | 1724580000 |
| update_time | string | 更新时间 UTC 字符串 | ISO 时间字符串 | "2026-08-25 10:00:00" |
| update_time_stamp | integer | 更新时间 UNIX 时间戳 | ≥0 | 1724580000 |

#### 来源与平台信息

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| src_type | array[string] | 数据源列表，由 `SourceUtils.determine_source` 合并 `src_type` 与 `adapter` 计算 | 字符串列表 | ["edr", "sip"] |
| platform_id | string | 平台 ID（由 `render_platform_info` 注入） | 字符串 | "platform-001" |
| cve | string | CVE 编号（通过 `sf_ids_map` 反查） | 字符串 | "CVE-2021-44228" |
| cnvd | string | CNVD 编号 | 字符串 | "" |
| cnnvd | string | CNNVD 编号 | 字符串 | "" |
| bugtraq_id | string | Bugtraq 编号 | 字符串 | "" |
| vul_ids | array | 漏洞 ID 列表，固定为 `[]`（占位字段） | 空数组 | [] |

#### 自定义字段

| 字段名 | 类型 | 说明 | 取值范围 | 示例值 |
|--------|------|------|----------|--------|
| option_* | any | 由 `make_option_prefix(item["option"])` 展平的自定义字段，字段名加 `option_` 前缀 | 任意 | {"option_xxx": "..."} |

## 调用示例

### 示例 1：基础分页查询

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0
}
```

**响应示例**：
```json
{
  "code": "0",
  "message": "success",
  "data": {
    "list": [
      {
        "id": "a3f5c9b8e1d2...",
        "event_id": "a3f5c9b8e1d2...",
        "md5_name_asset": "a3f5c9b8e1d2...",
        "name": "Apache Log4j2 远程代码执行漏洞",
        "type": "loophole",
        "risk_level": 2,
        "level": "high",
        "cvss_score": 9.8,
        "cvss_level": 2,
        "fix_priority": 3,
        "vpt_desc": "高",
        "fixed_status": 0,
        "scan_type": [1, 2],
        "tags": ["ATTACK_CODE_DISCLOSURE"],
        "threat_tag": ["有攻击代码披露"],
        "threat_tags": ["有攻击代码披露"],
        "attack_type": "会话劫持",
        "asset_id": 12345,
        "asset": "10.1.1.1",
        "all_ip_list": ["10.1.1.2"],
        "asset_type": "server",
        "asset_name": "web-server-01",
        "host_name": "web-server-01",
        "asset_tags": ["internet-facing"],
        "magnitude": "core",
        "exposure": "yes",
        "asset_exposure": "yes",
        "manager": "alice,bob",
        "user": [{"name": "alice"}, {"name": "bob"}],
        "business_name": "研发部",
        "group_names": "edge-servers,web-servers",
        "order_status": 0,
        "order_update_time": "",
        "order_update_time_stamp": 0,
        "is_hot": 0,
        "is_high_availability": 0,
        "found_time": "2026-08-01 10:00:00",
        "found_time_stamp": 1722506400,
        "last_time": "2026-08-25 10:00:00",
        "last_time_stamp": 1724580000,
        "update_time": "2026-08-25 10:00:00",
        "update_time_stamp": 1724580000,
        "src_type": ["edr", "sip"],
        "platform_id": "platform-001",
        "cve": "CVE-2021-44228",
        "cnvd": "",
        "cnnvd": "",
        "bugtraq_id": "",
        "vul_ids": []
      }
    ],
    "total": 1
  }
}
```

### 示例 2：按风险类型 + 等级 + 处置状态筛选

**请求示例**：
```json
{
  "limit": 50,
  "offset": 0,
  "data_type": ["loophole"],
  "fix_priority": [2, 3],
  "fixed_status": [0, 1]
}
```

**响应示例**：同示例 1 结构，`list` 中仅返回中高优先级、待处置或处置中的漏洞。

### 示例 3：按时间范围 + 关键字模糊查询

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0,
  "keyword": "CVE-2021",
  "latest_time_range": [1700000000, 1700086400]
}
```

### 示例 4：按 md5_name_asset 精确定位

**请求示例**：
```json
{
  "limit": 100,
  "offset": 0,
  "md5_name_assets": ["a3f5c9b8e1d2...", "b4e6d7c9f2e3..."]
}
```

### 示例 5：按威胁标签 + 攻击类型（中文入参，后端反查英文）

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0,
  "threat_tag": ["病毒利用", "有攻击代码披露"],
  "attack_type": "会话劫持"
}
```

### 示例 6：跨平台 + 多业务组 + 资产维度筛选

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0,
  "platform_ids": ["platform-001", "platform-002"],
  "magnitude": ["core"],
  "exposure": ["yes"],
  "attack_state": [2, 3]
}
```

### 示例 7：按数据源筛选

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0,
  "source_device": ["edr", "sip"]
}
```

### 示例 8：name 字段使用 dict 形式精确匹配

**请求示例**：
```json
{
  "limit": 20,
  "offset": 0,
  "name": {"op": "=", "val": "Apache Log4j2 远程代码执行漏洞"}
}
```

### 示例 9：错误响应示例 - 参数校验失败

**请求示例**（limit 超过 100）：
```json
{
  "limit": 200,
  "offset": 0
}
```

**错误响应示例**：
```json
{
  "code": "InvalidParameter",
  "message": "参数异常",
  "data": null
}
```

> 注：参数校验失败走 `v1_open_api=True` 路径，`code` 取自 `V1Error.V1_ERROR_MAP[1104] = "InvalidParameter"`。HTTP 状态码 400。

### 示例 10：错误响应示例 - 鉴权失败

**请求示例**（无权限 token）：
```json
{
  "limit": 20,
  "offset": 0
}
```

**错误响应示例**：
```json
{
  "code": 403,
  "message": "Full authentication is required to access this resource",
  "data": null
}
```

> 注：鉴权失败由 `@auth_expr(auth_fail_response=ACCESS_DENY_RESPONSE)` 直接返回，不走 `output()` 外壳，`code` 为整数 403，HTTP 状态码 403。

## 注意事项与限制

### 参数限制
- `limit`：0–100；0 与 -1 在 DAO 层等价于"不限制"，但 Schema 仅允许 ≥0。
- `offset`：≥0；-1 在 DAO 层等价于"从头开始"，但 Schema 仅允许 ≥0。
- `name`：dict 形式时 `op` 仅支持 `=`、`like`。
- `keyword`：maxLength=100，pattern=COMMON_SPECIAL_CHAR。
- `attack_type`：maxLength=100，pattern=COMMON_SPECIAL_CHAR。
- `source_device`：单元素 maxLength=64。
- `md5_name_assets`：单元素需匹配 `MD5_REGEX`。
- `platform_ids`：单元素 minLength=1, maxLength=100。
- `scan_type`/`data_type`/`fix_priority`/`fixed_status`/`order_status`/`attack_state`/`magnitude`/`exposure`：均为数组，允许空数组（等价于不过滤）。
- `*_time_range`：长度 0–2 的整数数组，每个元素为 UNIX 时间戳 ≥0；分别表示 [begin, end]。

### 参数依赖关系
- `threat_tag` 与 `attack_type`：传入中文，后端反查英文键回查 DB。若传入字典中不存在的中文值，**不会报错，但不会匹配任何记录**。
- `name` 与 `keyword`：可同时使用，`name` 走漏洞名单字段匹配，`keyword` 走多字段 OR 模糊匹配。
- `data_type` 与 `fixed_status`：当 `data_type` 含 `loophole` 时，`fixed_status` 走 `MyVulnerabilityQuery` 简化分支；其它类型走 `MyVulRiskMiddleQuery` 的 `$or` + `$elemMatch` 适配分支。
- `platform_ids` + `branch_ids` + `group_ids`：通过 `build_platform_branch_group_query` 组合成 `$or` 联合查询。
- `md5_asset_name_platform_filter`（注意：非本接口直接入参，是内部组装字段）：若业务方传空列表，直接返回空结果。

### 权限要求
- 需具备 `superAdmin` 或 `riskManageQuery` 权限之一。
- 鉴权由 `@auth_expr` 在参数校验前执行，无权限直接返回 `ACCESS_DENY_RESPONSE`（HTTP 403）。
- 网关层还有 `sangfor-aksk` 插件做 AccessKey 校验，未通过网关鉴权的请求不会到达本服务。

### 性能建议
- `limit` 建议 ≤ 50，过大可能导致 MongoDB 大查询超时。
- 高基数 `md5_name_assets` 列表（>100）建议分批查询。
- 涉及时间范围查询时，建议同时传 `latest_time_range` 而非全表扫描。
- `name` 走 dict 形式时优先使用 `op="="` 精确匹配，避免 like 全表扫描。
- 排序默认按多键组合，已通过 `allow_disk_use=True` 允许 MongoDB 落盘排序，但仍建议加索引覆盖 `deal_status`、`fix_priority_level`、`count`、`last_time`、`found_time`、`md5_name_asset`。

### 数据一致性说明
- **时间精度差异**：所有时间字段同时返回 UTC 字符串与 UNIX 时间戳，前端按需取用；DB 存储为 datetime 对象，转换不丢精度。
- **`level` 字段双重含义**：DAO 返回的 `level` 为 int（如 2），组装后 `risk_level` 保留 int 值，`level` 被覆盖为英文 str（如 "high"）。**取值时需注意区分**。
- **`name` 字段语言**：DAO projection 使用 `f"$name_{lang}"`，按当前语言环境动态选 `name_zh` / `name_en`，**返回的 `name` 字段语言由服务端语言环境决定**。
- **威胁标签中英反查**：`threat_tag` / `threat_tags` 字段已渲染为中文；如果前端需要英文键，需自行维护映射或调用 `/api/xdr/v1/vuls/risk/threattag` 接口取原始英文键。
- **弱密码类型特殊默认值**：`data_type == "weak_pwd"` 时 `is_hot` / `is_high_availability` 强制为 1，**与 DB 实际值可能不符**（详见陷阱 #27）。

## 常见错误

| HTTP | code（响应外层；**本接口 code 类型不统一，见说明**） | 原因 | 解决方案 |
|------|------|------|----------|
| 403 | 整数 `403` | Full authentication is required to access this resource（未携带鉴权 token 或 token 失效） | 检查 Authorization 请求头，重新获取 token |
| 403 | 整数 `403` | Access deny（无 `superAdmin` 或 `riskManageQuery` 权限） | 联系管理员开通对应权限 |
| 200 | 整数 `1` | fixed_status 内容不符合限制（`fixed_status` 数组中包含 schema 不接受的值；实测传 `100` 会触发；文档虽在第 191 行的枚举表里**列出**了 `100`，但 schema 层 `enum` 仅允许 `0–7`，**`100` 是返回值字段的可能取值，不是入参合法值**） | 移除 `100`，仅传 `0–7` 中需要的值 |
| 400 | `"InvalidParameter"`（内部 errno 1104） | 参数异常：请求体不符合 `RISK_LIST` JSON Schema（如 limit>100、name dict 缺 op/val） | 检查参数取值范围与结构 |
| 500 | `"InternalError"`（内部 errno 1235） | 系统繁忙，请稍后再试：DB 查询超时或服务异常 | 减小 limit，简化过滤条件，稍后重试 |
| 500 | `"Unknown.SerComError"`（内部 errno 1103） | 未知错误：未捕获异常 | 联系运维查看后端日志 |

## 最佳实践

1. **分页遍历全量数据时**，建议 `limit=100`，逐次递增 `offset`，避免一次性大查询。
2. **筛选高优先级风险时**，优先使用 `fix_priority=[2,3]` + `fixed_status=[0,1]` 组合，定位待处置的中高优先级风险。
3. **威胁标签 / 攻击类型入参**，统一使用中文名（来自 `MyStatistics.get_threat_tag()` / `get_attack_type()` 返回的 `name` 字段），后端自动反查英文键。
4. **跨平台联合查询**，使用 `platform_ids` 数组而非多次单平台查询，减少网络往返。
5. **精确单条查询**，使用 `md5_name_assets=[<md5>]` 而非 `name` 模糊匹配，性能更优。
6. **时间范围查询**，统一使用 `*_time_range` 数组（[begin, end]），而非自行拼接字符串。
7. **响应解析**，注意 `code` 为字符串型（`"0"`），与 v1 openapi 接口的字符串型 code 一致，但与默认外壳的整数型 code 不同。

## 元数据

- 文档生成时间：2026-08-25
- 源码版本：feature-openapi-skill 分支
- 提取规则版本：`doc/python-extraction-vuln.md`（xdr-vulnerability 项目专项规则，对齐 Java 版要求）
- 已应用的陷阱条目：#2（required 后空格）、#4（output 3 状态外壳）、#11（name 双形态）、#15（threat_tag/attack_type 中英反查）、#16（fixed_status OR 适配）、#27（弱密码强制 is_hot/is_high_availability）
- 已对照的枚举字典：DataType / AssetTypeEn / BigScanType / FixPriorityLevel.Number / FixedStatus / RiskLevel / RiskLevelEn / OrderStatus / AttackState / APIAssetMagnitude / APIExposureField / IsHotSpot / IsHighAvailable（建议加入 enum-dictionary-python.md）
