# OpenAPI 枚举字典（从源码自动提取）

> 本文件列出所有在 OpenAPI 接口中使用的 Java 枚举类的完整定义，由源码自动提取。
> 动态分类字段（无法从源码静态提取的枚举，如 i18n 运行时解析的分类字段）请参考 `enum-dictionary-pending.md`。

---

## 1. WhiteStatusEnum（加白状态）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/WhiteStatusEnum.java`
- 字段类型：String
- 语言环境差异：**中文环境数据库存国际化中文值（如"未加白"），国际版存原始 value（如"0"）**

| value | 枚举常量名 | label（英文） | 国际化值（中文） |
|-------|-----------|-------------|----------------|
| "0" | NO_WHITE | unwhitened | 未加白 |
| "1" | ALL_WHITE | whitened | 已加白 |
| "2" | PART_WHITE | partiallyWhitened | 部分加白 |

> 接口传值注意：中文环境传"未加白"/"已加白"/"部分加白"，国际版传"0"/"1"/"2"。

---

## 2. DealStatusEnum（告警处置状态）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/alert/DealStatusEnum.java`
- 字段类型：int（statusCode）
- 语言环境差异：通过 i18nCode 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） | i18nCode |
|-------|-----------|-------------|----------------|----------|
| 1 | PENDING | Pending | 待处置 | alert.deal.status.pending |
| 2 | DISPOSING | Fixing | 处置中 | alert.deal.status.disposing |
| 3 | DISPOSED | Fixed | 处置完成 | alert.deal.status.disposed |
| 6 | SUPPRESSED | Suppressed | 已遏制 | alert.deal.status.suppressed |

---

## 3. AttackResultEnum（攻击结果）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/alert/AttackResultEnum.java`
- 字段类型：int（resultCode）
- 语言环境差异：通过 i18nCode 国际化；另有 tmgResultCode 映射

| value(resultCode) | 枚举常量名 | label（英文） | 国际化值（中文） | tmgResultCode | i18nCode |
|-------------------|-----------|-------------|----------------|---------------|----------|
| 0 | TRY | Attempted | 尝试 | 0 | alert.attack.result.try |
| 1 | SUCCESS | Successful | 成功 | 2 | alert.attack.result.success |
| 2 | FAILED | Failed | 失败 | 1 | alert.attack.result.failed |
| 3 | TRAP | Compromised | 失陷 | 3 | alert.attack.result.trap |

> 注意：源码声明顺序为 TRY(0), FAILED(2), SUCCESS(1), TRAP(3)，但 resultCode 分别为 0/1/2/3。
> 另有 xen 包下同名枚举仅含 EMPTY(0)/SUCCESS(1)，用于特殊场景。

---

## 4. AttackDirectionEnum（攻击方向/访问方向）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/alert/AttackDirectionEnum.java`
- 字段类型：int（value）
- 语言环境差异：通过 EnumI18nUtil 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） |
|-------|-----------|-------------|----------------|
| 0 | NON | Unknown | 无 |
| 1 | IN_TO_OUT | Outbound | 内->外 |
| 2 | OUT_TO_IN | Inbound | 外->内 |
| 3 | IN_TO_IN | Lateral | 内->内 |

> 注意：value=2 是 OUT_TO_IN（外->内），value=3 是 IN_TO_IN（内->内），不要弄反。

---

## 5. SeverityEnum（告警严重等级）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/alert/SeverityEnum.java`
- 字段类型：Integer（scoreNum）+ String（i18nCode）
- 语言环境差异：通过 i18nCode 国际化

| scoreNum | 枚举常量名 | label（英文） | 国际化值（中文） | score 区间 |
|----------|-----------|-------------|----------------|----------|
| -1 | UNKNOWN | Unknown | 未知 | 0~0 |
| 0 | INFO | Information | 信息 | 1~20 |
| 1 | LOW | Low | 低危 | 21~40 |
| 2 | MID | Medium | 中危 | 41~60 |
| 3 | HIGH | High | 高危 | 61~80 |
| 4 | CRITICAL | Critical | 严重 | 81~99 |

> 前端映射：UNKNOWN=0, INFO=1, LOW=2, MID=3, HIGH=4, CRITICAL=5

---

## 6. PrototypeGptResultEnum（GPT研判结论/威胁定性）

- 所属业务域：告警 + 事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/PrototypeGptResultEnum.java`
- 字段类型：int（threatDefine）
- 语言环境差异：通过 EnumI18nUtil 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） | deprecated |
|-------|-----------|-------------|----------------|-----------|
| 0 | PENDING | Pending | 等待GPT研判 | 否 |
| 10 | TARGETED_ATTACK_EVENTS | Intrusion | 人工入侵 | 是(2.0.30) |
| 20 | VIRUS | Trojan | 病毒木马 | 是(2.0.30) |
| 30 | SUSPECTED_TARGETED_ATTACK | Suspected Intrusion | 疑似入侵 | 是(2.0.30) |
| 40 | UNKNOWN_THREAT | Business False Positive | 业务误报 | 是(2.0.30) |
| 50 | VULNERABILITY_RISK | Weakness | 脆弱性风险 | 是(2.0.30) |
| 60 | SCANNER_ATTACKS | Risk | 风险探测 | 是(2.0.30) |
| 70 | BUSINESS_IRREGULARITIES | Suspicious Activity | 可疑行为 | 是(2.0.30) |
| 110 | REAL_ATTACK_SUCCESS | Successful Attack | 真实攻击成功 | 否 |
| 115 | HOST_CRASH_ACTIVITY | Endpoint Compromise | 主机失陷活动 | 否 |
| 120 | VIRUS_TROJANS_ACTIVITY | Malware Infection | 病毒木马活动 | 否 |
| 130 | REAL_ATTACK_NOT_SUCCESS | Failed Attack | 真实攻击未成功 | 否 |
| 140 | WEAK_ACCESS | Insecure Access | 脆弱性访问 | 否 |
| 150 | SUSPICIOUS_ATTACK | Suspected Attack | 疑似攻击行为 | 否 |
| 160 | NEW_FALSE_POSITIVE | False Positive | 误报 | 否 |
| 170 | LAKE_OF_DATA | Insufficient Data | 数据不足 | 否 |
| 180 | CUSTOMIZE_TYPE | Custom Type | 自定义类型 | 否 |

> 额外常量：OTHER_THREAT_DEFINE = [100, 600, 700, 800]，用于兼容旧数据的组合查询。
> 告警域字段名：threatDefine；事件域字段名：gptResult。

---

## 7. TMGIncidentDealStatusEnum（TMG事件处置状态）

- 所属业务域：事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/incident/TMGIncidentDealStatusEnum.java`
- 字段类型：int（statusCode）
- 语言环境差异：通过 i18nCode 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） | i18nCode |
|-------|-----------|-------------|----------------|----------|
| 0 | PENDING | Pending | 待处置 | tmg.deal.status.pending |
| 10 | DISPOSING | Fixing | 处置中 | tmg.deal.status.disposing |
| 20 | NOTICED | Notification Sent | 已通告 | tmg.deal.status.noticed |
| 30 | PROTECTED | Protected | 已防护 | tmg.deal.status.protected |
| 40 | DISPOSED | Fixed | 已处置 | tmg.deal.status.disposed |
| 50 | HANGUP | Suspended | 已挂起 | tmg.deal.status.hungUp |
| 60 | ACCEPTRISK | Risk Accepted | 接受风险 | tmg.deal.status.acceptRisk |
| 70 | SUPPRESS | contained | 已遏制 | tmg.deal.status.contained |
| 80 | IGNORED | contained | 已遏制 | tmg.deal.status.contained |

> **注意**：30=已防护（PROTECTED），70=已遏制（SUPPRESS），不要弄反。80=IGNORED 的 i18nCode 与 70 相同（历史兼容）。

---

## 8. IncidentDealStatusEnum（事件处置状态）

- 所属业务域：事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/incident/IncidentDealStatusEnum.java`
- 字段类型：int（statusCode）
- 语言环境差异：通过 i18nCode 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） | ifTreated | i18nCode |
|-------|-----------|-------------|----------------|-----------|----------|
| 1 | PENDING | Mark as Pending | 待处置 | false | incident.deal.status.pending |
| 2 | DISPOSING | Mark as Fixing | 处置中 | false | incident.deal.status.disposing |
| 3 | DISPOSED | Mark as fixed | 处置完成 | true | incident.deal.status.disposed |
| 4 | HANGUP | Mark as suspended | 挂起 | false | incident.deal.status.hungUp |
| 5 | IGNORED | Tag ignored | 已忽略 | true | incident.deal.status.ignored |
| 6 | SUPPRESS | Mark as suppressed | 已遏制 | true | incident.deal.status.suppress |

---

## 9. IncidentSeverityEnum（事件严重等级）

- 所属业务域：事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/incident/IncidentSeverityEnum.java`
- 字段类型：Integer（value）+ String（code）+ String（i18nCode）
- 语言环境差异：通过 i18nCode 国际化

| value | code | 枚举常量名 | label（英文） | 国际化值（中文） | score 区间 |
|-------|------|-----------|-------------|----------------|----------|
| -1 | health | HEALTH | Information | 信息 | 0~10 |
| 0 | info | INFO | Information | 信息 | 0~10 |
| 1 | low | LOW | Low | 低危 | 10~30 |
| 2 | mid | MID | Medium | 中危 | 30~50 |
| 3 | high | HIGH | High | 高危 | 50~70 |
| 4 | critical | CRITICAL | Critical | 严重 | 70~100 |

---

## 10. Classify1idEnum（主机资产父类型）

- 所属业务域：告警 + 事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/Classify1idEnum.java`
- 字段类型：Integer（value）
- 语言环境差异：通过 EnumI18nUtil 国际化

| value | 枚举常量名 | label（英文） | 国际化值（中文） |
|-------|-----------|-------------|----------------|
| 0 | UNKNOW | Unknown | 未知 |
| 1 | SERVER | Server | 服务器 |
| 2 | TERMINAL | Endpoint | 终端 |
| 3 | INTRANET | Intranet Device | 内网设备 |
| 4 | INTERNET | Internet Device | 互联网设备 |
| 5 | NETWORK_DEVICES | Network Device | 网络设备 |
| 6 | IOT_DEVICES | IoT Device | 物联网设备 |
| 7 | MOBILE_DEVICES | Mobile Device | 移动设备 |
| 8 | CYBERSECURITY_PRODUCTS | Network Security Product | 网络安全产品 |
| 9 | CLOUD_PLATFORM_SOFTWARE | Cloud Platform | 云平台 |
| 10 | ENTERPRISE_APPLICATION_SOFTWARE | Enterprise Software | 企业应用软件 |

> 注意：枚举名拼写为 UNKNOW（少一个 N）。

---

## 11. RiskSubTagEnum（风险标签）

- 所属业务域：风险资产
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/RiskSubTagEnum.java`
- 字段类型：String（riskSubTag, riskTag）
- 语言环境差异：通过 EnumI18nUtil 国际化
- 值数量：200+，按大类(A00x)分组

| riskTag 大类 | 子标签数量 | 中文含义 |
|-------------|----------|---------|
| A000 | 1 | 疑似业务误报 |
| A001 | 76 | 脆弱性风险 |
| A002 | 5 | 访问风险 |
| A003 | 16 | 服务探测 |
| A004 | 4 | 主机探测 |
| A005 | 41 | 网站攻击 |
| A006 | 15 | 后门通信 |
| A007 | 15 | 账号暴力破解 |
| A008 | 20 | 攻击利用 |
| A009 | 9 | 邮件攻击 |
| A010 | 10 | Dos攻击 |
| A011 | 1 | 黑链 |
| A012 | 14 | 漏洞攻击 |
| A013 | 11 | 黑客工具 |
| A014 | 5 | 数据库攻击利用 |
| A015 | 2 | 访问恶意文件 |
| A016 | 13 | 感染病毒 |
| A017 | 29 | 行为异常 |
| A018 | 13 | 流量异常 |
| A019 | 5 | 登录异常 |
| A020 | 7 | 终端行为异常 |

> 完整子标签列表（A001_B001~A020_B007）见源码。国际化键格式：`incident.risksubtagenum.{枚举名小写}`。

---

## 12. AlertTimeFieldTypeEnum（告警时间字段类型）

- 所属业务域：告警
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/openness/AlertTimeFieldTypeEnum.java`
- 字段类型：String（timeField）
- 语言环境差异：无国际化，值为 ES 数据库字段名

| value | 枚举常量名 | 说明 |
|-------|-----------|------|
| "firstTime" | FIRST_TIME | 首次发现时间 |
| "lastTime" | LAST_TIME | 最近发生时间 |
| "updateTime" | UPDATE_TIME | 更新时间 |
| "dealTime" | DEAL_TIME | 处置时间 |
| "occurTime" | OCCUR_TIME | 发生时间 |
| "uploadTime" | UPLOAD_TIME | 上传时间 |
| "_insertTime" | INSERT_TIME | 入库时间 |

---

## 13. DataSourceTypeEnum（数据源类型）

- 所属业务域：事件
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/openness/DataSourceTypeEnum.java`
- 字段类型：Integer（type）
- 语言环境差异：无国际化

| value | 枚举常量名 | 说明 |
|-------|-----------|------|
| 1 | SANGFOR | 深信服内部 |
| 2 | SANGFOR_AND_THIRD | 深信服内部+第三方 |
| 3 | MULTI_THIRD | 三方多源 |

---

## 国际化机制说明

本项目的枚举国际化使用两种机制：

1. **EnumI18nUtil** — 键格式：`incident.{枚举类名小写}.{枚举常量名小写}`
   - 适用于：WhiteStatusEnum, AttackDirectionEnum, Classify1idEnum, PrototypeGptResultEnum, RiskSubTagEnum
   - 资源文件：`enum.properties`（英文）/ `enum_zh_CN.properties`（中文）

2. **IncidentModelI18nUtil** — 键为硬编码 i18nCode 字符串
   - 适用于：DealStatusEnum, AttackResultEnum, SeverityEnum, TMGIncidentDealStatusEnum, IncidentDealStatusEnum, IncidentSeverityEnum
   - 资源文件：`messages.properties`（英文）/ `messages_zh_CN.properties`（中文）

资源文件位置：`xdr-incident-model/src/main/resources/incident/model/`

---

## 14. AttackStateEnum（攻击状态/攻击结果）

- 所属业务域：告警 + 安全日志
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/incident/AttackStateEnum.java`
- 字段类型：int（resultCode）
- 语言环境差异：通过 IncidentModelI18nUtil 国际化
- 使用说明：QO 中通常用 `@Enum(clazz = AttackStateEnum.class, method = "getResultCode")` 校验

| value(resultCode) | 枚举常量名 | 说明（中文） | i18nCode |
|-------------------|-----------|-------------|----------|
| 0 | ATTEMPT | 尝试 | incident.attack.story.line.result.attempt |
| 1 | ATTACK_FAILED | 失败 | incident.attack.story.line.result.attack.failed |
| 2 | ATTACK_SUCCESS | 成功 | incident.attack.story.line.result.attack.success |
| 3 | TRAP | 失陷 | incident.attack.story.line.result.trap |
| 4 | SUCCESS | 成功 | incident.attack.story.line.result.success |

> 注意：value=1 是 ATTACK_FAILED（失败），value=2 是 ATTACK_SUCCESS（成功）。value=0 是 ATTEMPT（尝试），value=4 也是 SUCCESS（成功，区别于 value=2 的 ATTACK_SUCCESS）。告警域 AttackResultEnum 的 resultCode 与之不同（0=TRY, 1=SUCCESS, 2=FAILED, 3=TRAP），注意区分。

## 15. SortTypeEnum（排序方式）

- 所属业务域：通用
- 源码位置：`xdr-incident-model/src/main/java/com/sangfor/ngsoc/incident/model/enums/incident/SortTypeEnum.java`
- 字段类型：String（type）
- 语言环境差异：无国际化

| value(type) | 枚举常量名 | 说明 |
|-------------|-----------|------|
| "ASC" | ASC | 正序（升序） |
| "DESC" | DESC | 倒序（降序） |

## 聚合函数白名单（非枚举，但与接口参数相关）

### 告警聚合（ES）

支持以下 func 值（DAO 层实现）：

| func 值 | 说明 |
|---------|------|
| count | 计数 |
| cardinality | 去重计数 |
| avg | 平均值 |
| max | 最大值 |
| min | 最小值 |
| sum | 求和 |

> 注意：不支持 ES 原生 `value_count` 函数名。

### 事件资产聚合（MongoDB）

支持以下 func 值（DAO 层实现）：

| func 值 | 说明 |
|---------|------|
| count | 计数 |
| distinct | 去重计数 |
