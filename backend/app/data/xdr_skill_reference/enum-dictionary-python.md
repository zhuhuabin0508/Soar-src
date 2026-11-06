# OpenAPI 枚举字典（Python 项目，从源码自动提取）

> 本文件列出 Python 项目（如 XDR asset 仓库 `home/fantom/apps/asset_web`）在 OpenAPI 接口中使用的枚举的完整定义，由源码自动提取。
> 动态分类字段（无法从源码静态提取的枚举，如 i18n 运行时解析的分类字段）请参考 `enum-dictionary-pending.md`。
>
> **与 Java 枚举字典 `enum-dictionary.md` 的关系**：本文件是 Python 项目的等价物，两者独立维护、按项目语言选用。Java 项目读 `enum-dictionary.md`，Python 项目读本文件。

## Python 枚举的来源（提取规则）

Python 项目没有 Java 枚举类，枚举散落在几类源码定义中，提取时必须逐类识别：

| 源码形态 | 识别特征 | 提取方式 |
|---------|---------|---------|
| **`enum.Enum` 类** | `class XxxType(Enum): A = 1` | 提取成员名 + value + 中文 name（若有 `_missing_` 或注释） |
| **`IntEnum` 类** | `class XxxStatus(IntEnum): PENDING = 1` | 同上，value 为 int |
| **常量 dict** | `XXX_EN_DICT = {1: "xx", 2: "yy"}` | 提取 key → value 映射，key 作为枚举值，value 作为说明 |
| **常量 list/tuple** | `XXX_EN = ["A", "B"]` / `SpecialAsset.Type.ALL_FIELDS` | 提取全部合法取值作为枚举集合 |
| **`Literal[...]` 类型注解** | `Literal["1m", "1H", "1d"]` | 提取字面量作为枚举取值 |
| **JSON Schema `enum`** | schema 常量内 `"enum": ["ASC", "DESC"]` 或 `"enum": SpecialAsset.Type.ALL_FIELDS` | 提取 enum 值；若 enum 值引用常量（如 `SpecialAsset.Type.ALL_FIELDS`），必须打开常量定义展开 |
| **i18n 常量（`Param.*` / `Message.*`）** | `"name": Param.AssetCate.ClassifyId1` | 字段的业务描述/错误提示来自 `asset_language.translations.source.param` 或 `message`，打开对应翻译源取中文 |

### 提取注意

1. **枚举含义常缺失**：Python 常量 dict 通常只有 `{value: 中文}` 或 `{value: None}`，**含义必须从 Service/DAO 层用法、注释、相邻常量推理**，推理不出时标"需确认"，禁止凭空解释。
2. **值可能跨语言环境差异**：部分枚举依赖语言环境（如国际化中文 vs 原始数字），参照 `enum-dictionary.md` 的 `WhiteStatusEnum` 格式，必须显式标注语言环境差异。
3. **新发现的枚举字段**：接口使用了本文件未收录的枚举时，记录到 `enum-dictionary-pending.md`（附字段名、所属业务域、涉及接口、Python 源码位置、填写要求模板）。

---

## 1. 资产聚合排序（sort）

- 所属业务域：资产聚合
- Python 源码位置：`home/fantom/apps/asset_web/app/view/asset/params.py`（AGGREGATION_COUNT_REQ）
- 源码形态：JSON Schema `enum`（`"sort": {"type": "string", "enum": ["ASC", "DESC"]}`）
- 默认值：`DESC`（源码 `rest_views.py:185` `data.get("sort", "DESC")`）

| 值 | 含义 |
|----|------|
| ASC | 升序（按 total 从小到大） |
| DESC | 降序（默认，按 total 从大到小） |

---

## 2. 资产搜索类型（searchType / searchTypes）

- 所属业务域：资产聚合
- Python 源码位置：`home/fantom/apps/asset_web/app/view/asset/params.py`（引用 `params.SEARCH_TYPE` / `params.SEARCH_TYPES`，定义于 `asset_common.business.constants.SearchType`）
- 源码形态：`enum.Enum` / 常量类 `SearchType`

> 枚举值含义需从 `home/fantom/apps/asset_common/business/constants.py` 的 `SearchType` 类展开，TODO：确认取值后填写。

---

## 3. 资产量级（magnitude / magnitudes）

- 所属业务域：资产聚合
- Python 源码位置：`home/fantom/apps/asset_web/app/view/asset/params.py`（引用 `params.MAGNITUDE_INCLUDE_ALL` / `params.MAGNITUDES_EN`）
- 源码形态：常量（`asset_common.constants` 相关）

> 枚举值含义需从 `home/fantom/apps/asset_common/constants.py` 展开，TODO：确认取值后填写。

---

## 4. 特殊资产子类型（sub_type）

- 所属业务域：特殊资产管理
- Python 源码位置：`home/fantom/apps/asset_web/app/view/asset/params.py`（ADD_SPECIAL_ASSET，`"enum": SpecialAsset.Type.ALL_FIELDS`，`SpecialAsset.Type` 定义见 `rest_views.py` 引入的 `special_asset` 模块）
- 源码形态：常量类 `SpecialAsset.Type.ALL_FIELDS`
- 校验：`pattern` 由 `input` 字段的 `anyOf`（`IP_RANGE_REG` 或 `HTTP_HOST_REGEX`）决定，sub_type 需与 input 元素类型配套

> 枚举值含义需从 `SpecialAsset.Type` 类展开，TODO：确认取值后填写。

---

## 5. 敏感/探活等平台过滤字段（platform_ids / platformIDs / platformId）

- 所属业务域：全局（所有 OpenAPI 接口）
- Python 源码位置：`home/fantom/apps/asset_web/app/common/utils/app_util.py`（v1_open_api_validate / open_api_validate 内 `cascade_query_init`）+ `home/fantom/apps/asset_web/app/common/params.py`（`ASSET_PLATFORM_FILTER`）
- 源码形态：常量 dict + 装饰器注入逻辑
- **非枚举但必填级联字段**：`platform_ids`（下划线）与 `platformIDs`（驼峰）等价的级联平台指定字段，未传时默认只查当前平台（`[get_ctx_platform_id()]`）。部分接口额外支持 `?platformId=N` 查询参数（`OpenApiResource.dispatch_request`）。

> 取值含义：平台 ID 列表，来自平台管理实体（Platform），需由需求分析器结合平台上下文确定。

---

## 6. 脆弱性类型（data_type / type）

- 所属业务域：脆弱性管理（xdr-vulnerability 仓库）
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class DataType`
- 源码形态：常量类（非 `Enum`，纯字符串常量）
- 涉及接口：`/api/xdr/v1/risk/list`、`/api/xdr/v1/vuls/risk/list`、`/api/xdr/v1/vuls/risk/count` 等

| 值 | 含义 |
|----|------|
| "loophole" | 漏洞 |
| "weak_pwd" | 弱密码 |
| "baseline" | 基线（仅 `RISK_TYPE2` 支持，`/risk/list` 接口不支持） |

---

## 7. 资产类型英文（asset_type）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class AssetTypeEn` + `ASSET_TYPE_MAP`
- 源码形态：常量类 + dict 映射（DB int → 英文 str）
- 涉及接口：所有返回资产信息的脆弱性接口

| 值 | 含义 | DB int 原值 |
|----|------|-----------|
| "all" | 全部 | 0 |
| "server" | 服务器 | 1 |
| "terminal" | 终端 | 2 |
| "other" | 其他 | 3 |

---

## 8. 检测方式大类（scan_type）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class BigScanType` + `SCAN_TYPE_SMALL_MAPPING`（小类→大类聚合）
- 源码形态：常量类（int 值）
- 涉及接口：`/api/xdr/v1/risk/list`、`/api/xdr/v1/vuls/risk/list`
- 注意：DAO 返回的是小类 list，组装时用 `ScanTypeUtils.small2big` 聚合为大类 list

| 值 | 含义 |
|----|------|
| 0 | 全部（ALL） |
| 1 | 原理扫描（PRINCIPLE_SCAN） |
| 2 | 版本比对（VERSION_COMPARISON） |
| 3 | 弱密码识别（WEAK_PASSWORD） |

---

## 9. 修复优先级（fix_priority / fix_priority_level）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class FixPriorityLevel.Number` + `FIX_PRIORITY_LEVEL_DESC`
- 源码形态：嵌套常量类（int 值）
- 涉及接口：`/api/xdr/v1/risk/list`（入参 `fix_priority`，出参 `fix_priority`）

| 值 | 含义 |
|----|------|
| 0 | 无（WITHOUT） |
| 1 | 低（LOW） |
| 2 | 中（MIDDLE） |
| 3 | 高（HIGH） |

> 缺省时组装结果填 `FixPriorityLevel.Number.LOW`（1）。

---

## 10. 处置状态（fixed_status / deal_status）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class FixedStatus` + `FIXED_STATUS_ALL` + `FIXED_STATUS_LANG_NAME_MAP`
- 源码形态：常量类（int 值）
- 涉及接口：所有脆弱性接口

| 值 | 含义 |
|----|------|
| 0 | 待处置（PENDING） |
| 1 | 处置中（HANDLING） |
| 2 | 已修复（FIXED） |
| 3 | 已接受（ACCEPTED） |
| 4 | 已忽略（IGNORED） |
| 5 | 误报（FALSE_POSITIVE） |
| 6 | 改善（IMPROVE） |
| 7 | 加白（WHITELIST） |
| 100 | 处置完成（DISPOSAL_COMPLETED） |

> 注意：`FixedStatus.NEVER_USE = 10` 占位值，实际不会被使用。
> DAO 层 `build_fixed_status_or_query` 因 `VulRiskMiddle` 表 `fixed_status` 字段同时存在 list 和 string 两种存储形式，统一用 `$or` + `$elemMatch` 适配。

---

## 11. 风险等级（risk_level / level）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class RiskLevel`（int）+ `class RiskLevelEn`（英文 str）+ `RISK_LEVEL_MAP`
- 源码形态：常量类 + dict 映射
- 涉及接口：所有脆弱性接口
- 注意：返回值 `risk_level` 为 int 原值，`level` 被覆盖为英文 str

| int 值（risk_level） | 英文 str（level） | 含义 |
|----|----|------|
| -1 | "info" | 信息 |
| 0 | "low" | 低 |
| 1 | "middle" | 中 |
| 2 | "high" | 高 |
| 3 | "critical" | 严重 |

---

## 12. 工单状态（order_status）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class OrderStatus` + `ORDER_STATUS_MAP`
- 源码形态：常量类（int 值）

| 值 | 含义 |
|----|------|
| 0 | 待发起（PENDING） |
| 1 | 工单处理中（RUNNING） |
| 2 | 工单已完成（FINISH） |

> 缺省时组装结果填 `OrderStatus.PENDING`（0）。

---

## 13. 攻击状态（attack_state）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_web/app/common/constants.py` → `class AttackState(IntEnum)`
- 源码形态：`IntEnum` 类
- 涉及接口：`/api/xdr/v1/risk/list`

| 值 | 含义 |
|----|------|
| 0 | 尝试（ATTEMPT） |
| 1 | 失败（FAIL） |
| 2 | 成功（SUCCESS） |
| 3 | 失陷（FALL） |

---

## 14. 资产重要性（magnitude）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_web/app/common/constants.py` → `class APIAssetMagnitude`
- 源码形态：常量类（英文 str 值）
- 涉及接口：`/api/xdr/v1/risk/list`

| 值 | 含义 |
|----|------|
| "normal" | 普通 |
| "core" | 核心 |

---

## 15. 互联网暴露（exposure / asset_exposure）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_web/app/common/constants.py` → `class APIExposureField`
- 源码形态：常量类（英文 str 值）
- 涉及接口：`/api/xdr/v1/risk/list`

| 值 | 含义 |
|----|------|
| "yes" | 暴露 |
| "no" | 未暴露 |
| "unknown" | 未知 |

---

## 16. 是否热点（is_hot）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class IsHotSpot`
- 源码形态：常量类（int 值）

| 值 | 含义 |
|----|------|
| 0 | 否（NO） |
| 1 | 是（YES） |

> 陷阱 #27：当 `data_type == "weak_pwd"` 时，组装结果强制 `is_hot = IsHotSpot.YES`，与 DB 实际值可能不符。

---

## 17. 是否高可用（is_high_availability）

- 所属业务域：脆弱性管理
- Python 源码位置：`soar/apps/vuln_common/constants.py` → `class IsHighAvailable`
- 源码形态：常量类（int 值）

| 值 | 含义 |
|----|------|
| 0 | 否（NO） |
| 1 | 是（YES） |

> 陷阱 #27：当 `data_type == "weak_pwd"` 时，组装结果强制 `is_high_availability = IsHighAvailable.YES`。

---

## 18. V1 错误码（V1Error）

- 所属业务域：OpenAPI v1 错误响应
- Python 源码位置：`soar/apps/vuln_web/app/common/response/errors.py` → `class V1Error` + `V1_ERROR_MAP`
- 源码形态：常量类 + dict 映射
- 涉及接口：所有 OpenAPI v1 / v2 接口的错误响应
- 注意：`output(open_api=True)` 走 `str(code)` 分支，**不经过 V1_ERROR_MAP**；`output(v1_open_api=True)` 才走 V1_ERROR_MAP

| int code | 字符串 code（V1_ERROR_MAP） | 含义 | HTTP 状态码 |
|----|----|------|----|
| 1001 | "Success" | 成功 | 200 |
| 1103 | "Unknown.SerComError" | 未知错误 | 400 |
| 1104 | "InvalidParameter" | 参数异常 | 400 |
| 1235 | "InternalError" | 系统繁忙 | 500 |

---

## 补充说明

本文件为 Python 项目枚举字典的起始模板。**新的 Python 接口生成文档时，若发现本文件未收录的枚举字段，必须按上面"提取规则"识别来源、填入本文件对应条目，并同步在接口文档的"取值范围"列给内联简要对照；无法从源码确定含义的标'需确认'，并记录到 `enum-dictionary-pending.md`。**

> xdr-vulnerability 仓库的枚举主要由 `vuln_common/constants.py` 与 `vuln_web/app/common/constants.py` 提供，多数为常量类（非 `Enum`），提取时需直接展开常量值。`MyStatistics.get_threat_tag()` / `get_attack_type()` 返回的威胁标签和攻击类型为运行时字典数据，**记录到 `enum-dictionary-pending.md`**（涉及接口：`/api/xdr/v1/risk/list`、`/api/xdr/v1/vuls/risk/threattag`、`/api/xdr/v1/vuls/risk/attacktype`）。

---

## 19. 基线风险等级（BASELINE_RISK_LEVEL_NUM_LIST / baseline level）

- 所属业务域：脆弱性管理 - 基线核查
- Python 源码位置：`soar/apps/vuln_web/app/common/params.py` → `BASELINE_RISK_LEVEL_NUM_LIST`
- 涉及接口：`/api/xdr/v1/vuls/baseline/list`

| 枚举值 | 含义 |
|-------|------|
| 1 | 低风险 |
| 2 | 中风险 |
| 3 | 高风险 |

> 注意：与漏洞风险等级 (RISK_LEVEL_INT 0/1/2/3) 不同，基线 level 没有 0（无风险）这一档。

---

## 20. 基线等保级别（BASELINE_STANDARD_NUM_LIST / standard）

- 所属业务域：脆弱性管理 - 基线核查
- Python 源码位置：`soar/apps/vuln_web/app/common/params.py` → `BASELINE_STANDARD_NUM_LIST`
- 涉及接口：`/api/xdr/v1/vuls/baseline/list`

| 枚举值 | 含义 |
|-------|------|
| 1 | 第一级（自主保护级） |
| 2 | 第二级（指导保护级） |
| 3 | 第三级（监督保护级） |
| 4 | 第四级（强制保护级） |
| 5 | 第五级（专控保护级） |

> 对应国家等保 1.0 五级分级标准。

---

## 21. 基线类型（BASELINE_TYPE_LIST / baselineType）

- 所属业务域：脆弱性管理 - 基线核查
- Python 源码位置：`soar/apps/vuln_web/app/common/params.py` → `BASELINE_TYPE_LIST`
- 涉及接口：`/api/xdr/v1/vuls/baseline/list`
- 注意：业务层在 `add_baseline_data` 中通过 `BaseLineTypeConverter.to_type()` 将字符串类型转换为整数枚举值，**具体枚举值需运行时从该 Converter 获取**（→ 记录到 `enum-dictionary-pending.md`）

---

## 23. SIR 列表数据类型（RISK_SIR_LIST.dataType）

- 所属业务域：脆弱性管理 - SIR 列表
- Python 源码位置：`soar/apps/vuln_web/app/open_api/v1/risk/params.py` → `RISK_SIR_LIST.properties.dataType`
- 涉及接口：`/api/xdr/v1/asm/risk/sir/list`

| 枚举值 | 含义 |
|-------|------|
| "loophole" | 漏洞 |
| "weak_pwd" | 弱密码 |

> 注意：本接口的 dataType 是 **字符串数组**（与 list 接口的单值字符串不同）。

---

## 24. 是否显示密码（PASSWORD_IS_SHOW / is_show）

- 所属业务域：脆弱性管理 - 弱密码证据
- Python 源码位置：`soar/apps/vuln_web/app/common/params.py` → `PASSWORD_IS_SHOW`
- 涉及接口：`/api/xdr/v1/asm/risk/detail/proof`、`/api/xdr/v1/vuls/asset/list`（仅列表）

| 枚举值 | 含义 |
|-------|------|
| 0 | 脱敏（返回 `need_pwd=true`，pwd 显示为 "-"） |
| 1 | 显示明文（需要 2FA 权限） |

> 注意：在 `/detail/proof` 接口中，`is_show=0` 时业务层设置 `result["need_pwd"] = True`，前端可显示脱敏标识。

---

## 25. 是否包含空值（need_empty）

- 所属业务域：脆弱性管理 - 攻击类型/威胁标签查询
- Python 源码位置：`soar/apps/vuln_web/app/open_api/v1/risk/params.py` → `GET_ATTACK_TYPE.properties.need_empty`
- 涉及接口：`/api/xdr/v1/asm/risk/attack_type`、`/api/xdr/v1/vuls/risk/attacktype`、`/api/xdr/v1/vuls/risk/threattag`

| 枚举值 | 含义 |
|-------|------|
| "true" | 包含空值攻击类型/威胁标签（字符串，非布尔） |
| "false" | 不包含空值 |

> 陷阱：本字段是 **字符串类型**，不是布尔。默认值 `"true"`。传入布尔 `true` 会导致校验失败。

---

## 26. v1 接口响应通道区分

- 所属业务域：OpenAPI v1 错误响应
- 涉及接口：所有 v1/v2 OpenAPI 接口
- 注意：v1 openapi 接口存在两种响应通道，错误码格式不同：

| 通道标识 | 错误码格式 | 错误码示例 | 涉及接口示例 |
|---------|----------|-----------|--------------|
| `output(open_api=True)` | str(code) | "200"/"400"/"500" | `/api/xdr/v1/risk/list`、`/api/xdr/v1/asm/risk/detail/*`、`/api/xdr/v1/asm/risk/sir/list`、`/api/xdr/v1/asm/risk/risk_by_person`、`/api/xdr/v1/asm/risk/attack_type` |
| `output(v1_open_api=True)` | string V1Error 语义码 | "Success"/"InvalidParameter"/"Unknown.SerComError"/"InternalError" | `/api/xdr/v1/vuls/sourcedevice`、`/api/xdr/v1/vuls/baseline/list`、`/api/xdr/v1/vuls/risk/list`、`/api/xdr/v1/vuls/risk/count`、`/api/xdr/v1/vuls/risk/attacktype`、`/api/xdr/v1/vuls/risk/threattag`、`/api/xdr/v1/vuls/asset/list` |

> 规则：路径在 `/api/xdr/v1/asm/risk/*` 下的走 `open_api=True`（字符串 str(code)）；路径在 `/api/xdr/v1/vuls/*` 下的走 `v1_open_api=True`，**实测 `code` 为字符串 V1Error 语义码**（`"Success"`/`"InvalidParameter"`/`"Unknown.SerComError"`/`"InternalError"`），**非整数**。v2 OpenAPI 全部走 `open_api=True`。
>
> ⚠️ **2026-09-17 实测修订**：此前本表将 `v1_open_api=True` 误记为整数 `1001/1103/1104/1235`。实测 `/api/xdr/v1/vuls/baseline/list` 返回 `{"code":"Success",...}`，确认该通道错误码为**字符串** V1Error 语义码。配套已修订 `vuls-baseline-list.md`。若后续实测其余 `vuls/*` 接口返回格式不同，以活体实测为准持续修订。