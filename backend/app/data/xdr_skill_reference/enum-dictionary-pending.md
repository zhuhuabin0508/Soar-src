# OpenAPI 动态分类字段枚举字典（待补充）

> 本文件列出所有在 OpenAPI 接口中使用的"动态分类字段"——即那些无法从 Java 枚举类直接提取静态值的字段。
> 这些字段的值来源于 ES 配置数据、MongoDB 数据字典、i18n 运行时解析枚举标签等，需要人工补充或从数据源查询获取。

---

## 1. 告警一级分类（moduleType / threatClass）

| 属性 | 值 |
|------|-----|
| 字段名 | moduleType（请求参数）/ threatClass（响应字段） |
| 业务域 | 告警管理 |
| 字段类型 | integer（字符串形式） |
| 数据源描述 | AnalysisThreatClassEnum 枚举，共 24 个值，显示标签通过 i18n 解析 |
| 所在API文档 | alert-list.md, alert-getAlertInfo.md, alert-aggregation.md, alert-ipinfosstats.md, alert-branchstats.md, alert-attackrelations-aggregation.md |
| Java枚举类 | xdr-incident-metadata: AnalysisThreatClassEnum |

### 已知枚举值（需运行时 i18n 解析完整标签）

| 枚举Key | 枚举常量名 | i18n Key | 中文标签（参考） |
|---------|-----------|----------|----------------|
| 94 | VULNERABILITY_RISK | incident.threat.class.94 | 脆弱性风险 |
| 214 | ACCESS_RISK | incident.threat.class.214 | 访问风险 |
| 201 | SERVICE_DETECT | incident.threat.class.201 | 服务探测 |
| 215 | HOST_DETECT | incident.threat.class.215 | 主机探测 |
| 90 | WEB_ATTACK | incident.threat.class.90 | 网站攻击 |
| 203 | BACKDOOR_COMM | incident.threat.class.203 | 后门通信 |
| 204 | BRUTE_FORCE | incident.threat.class.204 | 账号暴力破解 |
| 205 | ATTACK_UTILIZE | incident.threat.class.205 | 攻击利用 |
| 96 | EMAIL_ATTACK | incident.threat.class.96 | 邮件攻击 |
| 10 | DOS_ATTACK | incident.threat.class.10 | Dos攻击 |
| 91 | TROJAN | incident.threat.class.91 | 木马 |
| 92 | WORM | incident.threat.class.92 | 蠕虫 |
| 93 | MALWARE | incident.threat.class.93 | 恶意软件 |
| 20 | ABNORMAL_BEHAVIOR | incident.threat.class.20 | 异常行为 |
| 21 | INFO_LEAK | incident.threat.class.21 | 信息泄漏 |
| 30 | OTHER | incident.threat.class.30 | 其他 |
| 206 | WEAK_PASSWORD | incident.threat.class.206 | 弱口令 |
| 11 | PROXY_DETECT | incident.threat.class.11 | 代理探测 |
| 216 | MINING | incident.threat.class.216 | 挖矿 |
| 12 | SCAN_DETECT | incident.threat.class.12 | 扫描探测 |
| 97 | PHISHING | incident.threat.class.97 | 钓鱼 |
| 95 | EXPLOIT | incident.threat.class.95 | 漏洞利用 |
| 98 | SPAM | incident.threat.class.98 | 垃圾邮件 |
| 99 | POLICY_VIOLATION | incident.threat.class.99 | 策略违规 |

---

## 2. 告警二级分类（attackTypeId / threatType）

| 属性 | 值 |
|------|-----|
| 字段名 | attackTypeId（请求参数）/ threatType（响应字段） |
| 业务域 | 告警管理 |
| 字段类型 | integer（字符串形式），与一级分类组合使用 |
| 数据源描述 | AnalysisThreatTypeEnum 枚举，值数量众多，依赖一级分类 key 前缀匹配 |
| 所在API文档 | alert-list.md, alert-getAlertInfo.md, alert-aggregation.md, alert-attackrelations-aggregation.md |
| Java枚举类 | xdr-incident-metadata: AnalysisThreatTypeEnum |

### 待补充枚举值模板

| 枚举Key | 枚举常量名 | 所属一级分类Key | i18n Key | 中文标签 |
|---------|-----------|---------------|----------|---------|
| （待补充） | | | | |

> 说明：AnalysisThreatTypeEnum 包含大量枚举值，需从源码或运行时 i18n 资源文件中完整提取。
> Key 格式示例："94_1" 表示一级分类 94 下的第 1 个二级分类。

---

## 3. 告警三级分类（attackSubTypeId / threatSubType）

| 属性 | 值 |
|------|-----|
| 字段名 | attackSubTypeId（请求参数）/ threatSubType（响应字段） |
| 业务域 | 告警管理（安全日志） |
| 字段类型 | integer（字符串形式），与一、二级分类组合使用 |
| 数据源描述 | AnalysisThreatSubTypeEnum 枚举，数百个值，三级层级格式 "94_1_-1" |
| 所在API文档 | analysislog-list-networksecurity.md |
| Java枚举类 | xdr-incident-metadata: AnalysisThreatSubTypeEnum |

### 待补充枚举值模板

| 枚举Key | 枚举常量名 | 所属二级分类Key | i18n Key | 中文标签 |
|---------|-----------|---------------|----------|---------|
| （待补充） | | | | |

> 说明：AnalysisThreatSubTypeEnum 包含数百个枚举值，Key 格式为 "一级Key_二级Key_三级Key"（如 "94_1_-1"）。
> 需从源码或运行时 i18n 资源文件中完整提取。

---

## 4. 事件一级分类（incidentThreatClass）

| 属性 | 值 |
|------|-----|
| 字段名 | incidentThreatClass |
| 业务域 | 安全事件 |
| 字段类型 | string |
| 数据源描述 | IncidentThreatClassEnum 枚举，约 30+ 个值，显示标签通过 i18n 解析 |
| 所在API文档 | incident-list.md, incident-aggregation.md, incident-asset-aggregation.md, incident-threatclass.md, incident-threattype.md |
| Java枚举类 | xdr-incident-metadata: IncidentThreatClassEnum |

### 已知枚举值（需运行时 i18n 解析完整标签）

| 枚举Key | 枚举常量名 | i18n Key | 中文标签（参考） |
|---------|-----------|----------|----------------|
| 0101 | MALWARE | incident.threat.class.0101 | 恶意软件 |
| 0102 | RANSOMWARE | incident.threat.class.0102 | 勒索软件 |
| 0103 | TROJAN_BACKDOOR | incident.threat.class.0103 | 木马后门 |
| 0104 | WORM | incident.threat.class.0104 | 蠕虫 |
| 0105 | BOTNET | incident.threat.class.0105 | 僵尸网络 |
| 0106 | EXPLOIT | incident.threat.class.0106 | 漏洞利用 |
| 0201 | BRUTE_FORCE | incident.threat.class.0201 | 暴力破解 |
| 0202 | WEAK_PASSWORD | incident.threat.class.0202 | 弱口令 |
| 0301 | WEB_ATTACK | incident.threat.class.0301 | Web攻击 |
| 0302 | INJECTION | incident.threat.class.0302 | 注入攻击 |
| 0401 | ABNORMAL_ACCESS | incident.threat.class.0401 | 异常访问 |
| 0402 | DATA_EXFILTRATION | incident.threat.class.0402 | 数据外泄 |
| 0501 | POLICY_VIOLATION | incident.threat.class.0501 | 策略违规 |
| 0601 | DOS_DDOS | incident.threat.class.0601 | 拒绝服务 |
| 0701 | PHISHING | incident.threat.class.0701 | 钓鱼 |
| 0702 | SPAM | incident.threat.class.0702 | 垃圾邮件 |
| 0801 | SCAN_DETECT | incident.threat.class.0801 | 扫描探测 |
| 0901 | MINING | incident.threat.class.0901 | 挖矿 |
| 1001 | VULNERABILITY | incident.threat.class.1001 | 脆弱性 |
| 1101 | OTHER | incident.threat.class.1101 | 其他 |

> 说明：IncidentThreatClassEnum 约 30+ 个值，上表为主要分类的示例。
> 完整列表需从源码 IncidentThreatClassEnum.java 或 i18n 资源文件提取。

---

## 5. 事件二级分类（incidentThreatType）

| 属性 | 值 |
|------|-----|
| 字段名 | incidentThreatType |
| 业务域 | 安全事件 |
| 字段类型 | string，与一级分类组合使用 |
| 数据源描述 | IncidentThreatTypeEnum 枚举，值数量众多，依赖一级分类 key 前缀匹配 |
| 所在API文档 | incident-list.md, incident-aggregation.md, incident-asset-aggregation.md, incident-threattype.md |
| Java枚举类 | xdr-incident-metadata: IncidentThreatTypeEnum |

### 待补充枚举值模板

| 枚举Key | 枚举常量名 | 所属一级分类Key | i18n Key | 中文标签 |
|---------|-----------|---------------|----------|---------|
| （待补充） | | | | |

> 说明：IncidentThreatTypeEnum 包含大量枚举值，需从源码或运行时 i18n 资源文件中完整提取。
> Key 格式为一级分类Key + "_" + 二级序号（如 "0101_1"）。

---

## 6. 威胁定性（threatDefine / gptResult）

| 属性 | 值 |
|------|-----|
| 字段名 | threatDefine（告警）/ gptResult（事件） |
| 业务域 | 告警管理 + 安全事件 |
| 字段类型 | integer |
| 数据源描述 | PrototypeGptResultEnum 枚举，共 15 个有效值 + OTHER_THREAT_DEFINE 组合值 |
| 所在API文档 | alert-list.md, alert-gptresult-type.md, incident-list.md |
| Java枚举类 | xdr-incident-model: PrototypeGptResultEnum |

### 已知枚举值

| 枚举Key | 枚举常量名 | 中文标签 | 说明 |
|---------|-----------|---------|------|
| 0 | TO_BE_JUDGED | 待研判 | 默认值 |
| 10 | ATTACK_SUCCESS_DEP | （已废弃） | deprecated |
| 20 | HOST_COMPROMISED_DEP | （已废弃） | deprecated |
| 30 | VIRUS_TROJAN_DEP | （已废弃） | deprecated |
| 40 | ATTACK_FAILED_DEP | （已废弃） | deprecated |
| 50 | WEAK_ACCESS_DEP | （已废弃） | deprecated |
| 60 | SUSPICIOUS_DEP | （已废弃） | deprecated |
| 70 | FALSE_POSITIVE_DEP | （已废弃） | deprecated |
| 110 | ATTACK_SUCCESS | 攻击成功 | |
| 115 | HOST_COMPROMISED_ACTIVITY | 主机失陷活动 | |
| 120 | VIRUS_TROJAN_ACTIVITY | 病毒木马活动 | |
| 130 | ATTACK_FAILED | 攻击未成功 | |
| 140 | WEAK_ACCESS | 弱访问 | |
| 150 | SUSPICIOUS_ATTACK | 可疑攻击 | |
| 160 | FALSE_POSITIVE | 误报 | |
| 170 | INSUFFICIENT_DATA | 数据不足 | |
| 180 | CUSTOM_TYPE | 自定义类型 | |

> OTHER_THREAT_DEFINE = [100, 600, 700, 800] 为组合查询值，非单枚举常量。

---

## 7. 主机资产父类型（hostClassify1Id / classify1Id）

| 属性 | 值 |
|------|-----|
| 字段名 | hostClassify1Id（事件）/ classify1Id（告警） |
| 业务域 | 告警管理 + 安全事件 |
| 字段类型 | integer |
| 数据源描述 | Classify1idEnum 枚举，共 11 个值 |
| 所在API文档 | alert-list.md, alert-getAlertInfo.md, alert-ipInfos.md, incident-list.md, incident-asset-aggregation.md, riskassets-list.md, riskassets-aggregation.md, riskassets-trends.md |
| Java枚举类 | xdr-incident-model: Classify1idEnum |

### 已知枚举值

| 枚举Key | 枚举常量名 | 中文标签 |
|---------|-----------|---------|
| 0 | UNKNOWN | 未知 |
| 1 | SERVER | 服务器 |
| 2 | TERMINAL | 终端 |
| 3 | INTRANET_DEVICE | 内网设备 |
| 4 | INTERNET_DEVICE | 互联网设备 |
| 5 | NETWORK_DEVICE | 网络设备 |
| 6 | IOT_DEVICE | IoT设备 |
| 7 | MOBILE_DEVICE | 移动设备 |
| 8 | SECURITY_PRODUCT | 网络安全产品 |
| 9 | CLOUD_PLATFORM | 云平台软件 |
| 10 | ENTERPRISE_APP | 企业应用软件 |

---

## 8. 主机资产具体类型（hostClassifyId / classifyId）

| 属性 | 值 |
|------|-----|
| 字段名 | hostClassifyId（事件）/ classifyId（告警） |
| 业务域 | 告警管理 + 安全事件 |
| 字段类型 | integer |
| 数据源描述 | 无 Java 枚举类，值来自 ES 配置数据或资产管理系统数据字典，是 classify1Id 的子分类 |
| 所在API文档 | alert-list.md, alert-getAlertInfo.md, alert-ipInfos.md, incident-list.md |
| Java枚举类 | 无 |

### 待补充枚举值模板

| 枚举Key | 所属父类型(classify1Id) | 中文标签 | 说明 |
|---------|----------------------|---------|------|
| （待补充） | | | |

> 说明：此字段为 classify1Id 的二级细分，具体值需从 ES 配置或资产管理系统查询获取。

---

## 9. 事件类型（eventType）

| 属性 | 值 |
|------|-----|
| 字段名 | eventType |
| 业务域 | 安全事件 |
| 字段类型 | string |
| 数据源描述 | 无 Java 枚举类，值来自 MongoDB 数据字典或 ES 配置 |
| 所在API文档 | incident-list.md |
| Java枚举类 | 无 |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 10. 告警分类（alarmClassifications）

| 属性 | 值 |
|------|-----|
| 字段名 | alarmClassifications |
| 业务域 | 告警管理 |
| 字段类型 | string（数组元素，**逗号分隔的数字 ID 串**） |
| 数据源描述 | 元素格式为 `"moduleType"` 或 `"moduleType,attackTypeId"` 或 `"moduleType,attackTypeId,attackSubTypeId"`，三段均为**数字 ID**。来源：告警分类元数据接口（提供 moduleType/attackTypeId/attackSubTypeId 三级树）。**后端会逐段 `split(",")` 后 `Integer.parseInt`，传中文名（如 `"web攻击"`）会抛 `NumberFormatException` 导致 500**，不可传中文文本。 |
| 所在API文档 | alert-list.md, alert-ipinfosstats.md, alert-ipInfos.md, alert-branchstats.md, alert-attackrelations-aggregation.md, alert-aggregation.md, alert-trends.md |
| Java枚举类 | 无（但格式强约束，非任意字符串，仍需源码校验） |
| 证据来源 | 后端 DAO 屢 `structureAlarmClassificationQuery` 方法 |

### 取值说明

| 格式 | 示例 | 含义 |
|------|------|------|
| `"M"` | `["1"]` | 仅按一级分类（moduleType=1）查询 |
| `"M,A"` | `["1,2"]` | 按一级 + 二级分类查询 |
| `"M,A,S"` | `["1,2,3"]` | 按一级 + 二级 + 三级分类查询 |
| 多个分组 | `["1", "2,3"]` | 同一过滤里多组条件，组内 AND、组间 OR |

**严禁**：传 `["web攻击"]`、`["漏洞利用"]` 等中文文本——后端会 `Integer.parseInt` 失败。

---

## 11. 事件来源（incidentSource）

| 属性 | 值 |
|------|-----|
| 字段名 | incidentSource |
| 业务域 | 安全事件 |
| 字段类型 | string |
| 数据源描述 | 无 Java 枚举类，值来自 MongoDB 数据字典 |
| 所在API文档 | incident-list.md |
| Java枚举类 | 无 |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 12. 攻击意图（attackIntent）

| 属性 | 值 |
|------|-----|
| 字段名 | attackIntent |
| 业务域 | 安全事件 |
| 字段类型 | string |
| 数据源描述 | 无 Java 枚举类，值来自配置数据 |
| 所在API文档 | incident-list.md |
| Java枚举类 | 无 |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 13. 安全日志威胁分类（ClickHouse 格式）

| 属性 | 值 |
|------|-----|
| 字段名 | threatClass / threatType / threatSubType |
| 业务域 | 安全日志（ClickHouse 存储格式） |
| 字段类型 | integer（字符串形式），层级格式 "94", "94_1", "94_1_-1" |
| 数据源描述 | 同 AnalysisThreatClassEnum/TypeEnum/SubTypeEnum，但 Key 格式为 ClickHouse 层级编码 |
| 所在API文档 | analysislog-list-networksecurity.md |
| Java枚举类 | xdr-incident-metadata: AnalysisThreatClassEnum/TypeEnum/SubTypeEnum |

### 待补充枚举值模板

| 层级 | Key格式示例 | 枚举类 | 说明 |
|------|-----------|-------|------|
| 一级 | "94" | AnalysisThreatClassEnum | 同第1节 |
| 二级 | "94_1" | AnalysisThreatTypeEnum | 同第2节 |
| 三级 | "94_1_-1" | AnalysisThreatSubTypeEnum | 同第3节 |

---

## 14. 风险标签（riskTag）

| 属性 | 值 |
|------|-----|
| 字段名 | riskTag |
| 业务域 | 风险资产 |
| 字段类型 | string（数组元素） |
| 数据源描述 | RiskSubTagEnum 枚举，值数量较多 |
| 所在API文档 | riskassets-list.md, riskassets-aggregation.md, riskassets-trends.md |
| Java枚举类 | xdr-incident-model: RiskSubTagEnum |

### 待补充枚举值模板

| 枚举Key | 枚举常量名 | 中文标签 | 说明 |
|---------|-----------|---------|------|
| （待补充） | | | |

> 说明：RiskSubTagEnum 包含较多枚举值，需从源码完整提取。

---

## 15. 威胁情报类型（tiType）

| 属性 | 值 |
|------|-----|
| 字段名 | tiType |
| 业务域 | 告警管理 |
| 字段类型 | string（数组元素） |
| 数据源描述 | 可能有 Java 枚举类，需从源码确认 |
| 所在API文档 | alert-list.md, alert-ipinfosstats.md |
| Java枚举类 | 待确认 |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 16. 攻击结果（attackResult / attackState）

| 属性 | 值 |
|------|-----|
| 字段名 | attackResult（告警）/ attackState（响应字段） |
| 业务域 | 告警管理 |
| 字段类型 | string |
| 数据源描述 | 可能有 Java 枚举类，需从源码确认 |
| 所在API文档 | alert-list.md, alert-ipinfosstats.md |
| Java枚举类 | 待确认（可能为 AttackResultEnum） |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 17. 数据源类型（dataSourceType）

| 属性 | 值 |
|------|-----|
| 字段名 | dataSourceType |
| 业务域 | 安全事件 |
| 字段类型 | integer |
| 数据源描述 | 可能有少量固定值 |
| 所在API文档 | incident-list.md |
| Java枚举类 | 待确认 |

### 已知值（参考）

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| 1 | 告警 | 告警生成事件 |
| 2 | 安全日志 | 安全日志生成事件 |
| 3 | 威胁情报 | 威胁情报生成事件 |

---

## 18. 病毒类型（virusType）

| 属性 | 值 |
|------|-----|
| 字段名 | virusType |
| 业务域 | 告警管理 |
| 字段类型 | string |
| 数据源描述 | 无 Java 枚举类，值来自病毒库或配置数据 |
| 所在API文档 | alert-getAlertInfo.md |
| Java枚举类 | 无 |

### 待补充枚举值模板

| 枚举Key | 中文标签 | 说明 |
|---------|---------|------|
| （待补充） | | |

---

## 汇总：已有 Java 枚举类的动态字段

| 序号 | 字段名 | 枚举类 | 模块 | 值数量 | 需补充原因 |
|------|--------|--------|------|--------|-----------|
| 1 | moduleType/threatClass | AnalysisThreatClassEnum | xdr-incident-metadata | 24 | i18n 标签需运行时解析 |
| 2 | attackTypeId/threatType | AnalysisThreatTypeEnum | xdr-incident-metadata | 大量 | 值众多，i18n 标签需运行时解析 |
| 3 | attackSubTypeId/threatSubType | AnalysisThreatSubTypeEnum | xdr-incident-metadata | 数百个 | 值众多，i18n 标签需运行时解析 |
| 4 | incidentThreatClass | IncidentThreatClassEnum | xdr-incident-metadata | 30+ | i18n 标签需运行时解析 |
| 5 | incidentThreatType | IncidentThreatTypeEnum | xdr-incident-metadata | 大量 | 值众多，i18n 标签需运行时解析 |
| 6 | threatDefine/gptResult | PrototypeGptResultEnum | xdr-incident-model | 15+4 | 部分废弃，需标注 |
| 7 | hostClassify1Id/classify1Id | Classify1idEnum | xdr-incident-model | 11 | i18n 标签需运行时解析 |
| 8 | riskTag | RiskSubTagEnum | xdr-incident-model | 较多 | 需完整提取 |
| 9 | attackResult/attackState | （待确认） | （待确认） | （待确认） | 需确认枚举类 |
| 10 | tiType | （待确认） | （待确认） | （待确认） | 需确认枚举类 |

## 汇总：无 Java 枚举类的动态字段

| 序号 | 字段名 | 业务域 | 数据源 | 需补充方式 |
|------|--------|--------|--------|-----------|
| 1 | hostClassifyId/classifyId | 告警+事件 | ES配置/资产系统 | 需从 ES 或资产管理系统查询 |
| 2 | eventType | 事件 | MongoDB数据字典 | 需从 MongoDB 或配置管理查询 |
| 3 | alarmClassifications | 告警 | ES配置 | 需从 ES 配置查询 |
| 4 | incidentSource | 事件 | MongoDB数据字典 | 需从 MongoDB 或配置管理查询 |
| 5 | attackIntent | 事件 | 配置数据 | 需从配置数据查询 |
| 6 | virusType | 告警 | 病毒库/配置 | 需从病毒库或配置查询 |
| 7 | dataSourceType | 事件 | 少量固定值 | 部分已知，需确认完整列表 |

---

## xdr-vulnerability 仓库动态字段（待补充）

### P-1. 威胁标签（threat_tag）

| 属性 | 值 |
|------|-----|
| 字段名 | threat_tag（请求参数，list[string]，中文）/ threat_tags（响应字段，list[string]，中文） |
| 业务域 | 脆弱性管理 |
| 字段类型 | string（中文名） |
| 数据源描述 | 由 `MyStatistics.get_threat_tag()` 运行时从 MongoDB `statistics` 集合查询；返回 `{<英文键>: {"name": <中文名>, "desc": <描述>}}` 字典。前端传入中文名，后端通过 `_assemble_risk_list_statistics` 反查英文键回查 DB。 |
| 所在 API 文档 | risk-list.md, vuls-risk-list.md, vuls-risk-threattag.md |
| Python 源码位置 | `soar/apps/vuln_web/app/models/soar_db/statistics.py` -> `MyStatistics.get_threat_tag` |
| 已知英文键示例 | ATTACK_CODE_DISCLOSURE（有攻击代码披露）、VIRUS_EMPLOY（病毒利用）、HIGH_AVAILABLE、HOT_SPOT、ACTIVE 等（来自 `python-extraction-vuln.md` 注释，需运行时确认完整列表） |

#### 填写要求模板
- 完整运行时字典：`{<英文键>: <中文名>}` 全量
- 与 `LOOPHOLE_TAGS_MAP` 的关系：`LOOPHOLE_TAGS_MAP` 是源码常量，`statistics_threat_tags` 是运行时字典，两者可能重叠或互补

### P-2. 攻击类型（attack_type）

| 属性 | 值 |
|------|-----|
| 字段名 | attack_type（请求参数，string，中文）/ attack_type（响应字段，string，中文） |
| 业务域 | 脆弱性管理 |
| 字段类型 | string（中文名） |
| 数据源描述 | 由 `MyStatistics.get_attack_type()` 运行时从 MongoDB `statistics` 集合查询；返回 `{<英文键>: <中文名>}` 字典。前端传入中文名，后端通过 `_assemble_risk_list_statistics` 反查英文键回查 DB。 |
| 所在 API 文档 | risk-list.md, vuls-risk-list.md, vuls-risk-attacktype.md |
| Python 源码位置 | `soar/apps/vuln_web/app/models/soar_db/statistics.py` -> `MyStatistics.get_attack_type` |
| 已知示例 | Session Hijacking（会话劫持）、variable coverage（变量覆盖） |

#### 填写要求模板
- 完整运行时字典：`{<英文键>: <中文名>}` 全量

### P-3. 数据源（source_device）

| 属性 | 值 |
|------|-----|
| 字段名 | source_device（请求参数，list[string]） |
| 业务域 | 脆弱性管理 |
| 字段类型 | string（设备 short_name） |
| 数据源描述 | 由 `SOURCE_DEVICE_INFO` 常量提供，但设备列表会随版本迭代扩充。已收录在 `vuln_common/constants.py`，运行时动态可参考设备管理接口。 |
| 所在 API 文档 | risk-list.md, vuls-sourcedevice.md |
| Python 源码位置 | `soar/apps/vuln_common/constants.py` -> `SOURCE_DEVICE_INFO` |
| 已知设备 | edr、sip、cwpp、yj、sta、report_import、nsfocus、manual、aes、cc、nc |

#### 填写要求模板
- 完整 short_name -> long_name -> manufacturer 映射
- 标注每个设备的图标索引、type 编号

### P-4. 基线类型（baselineType / baseline_type）

| 属性 | 值 |
|------|-----|
| 字段名 | baselineType（请求参数，camelCase）/ baseline_type（业务层字段，snake_case） |
| 业务域 | 脆弱性管理 - 基线核查 |
| 字段类型 | integer（业务层最终存储为整数枚举值） |
| 数据源描述 | 入参可能为字符串类型（如 "password_policy"），由 `BaseLineTypeConverter.to_type()` 在业务层转换为整数枚举值。具体整数枚举值的完整列表需运行时从该 Converter 提取。 |
| 所在 API 文档 | vuls-baseline-list.md, vuls-risk-baseline.md |
| Python 源码位置 | `soar/apps/vuln_common/constants.py` -> `BaseLineTypeConverter.to_type()`（具体枚举常量类需运行时确认） |

#### 已知信息
- `BASELINE_TYPE_LIST`（`vuln_web/app/common/params.py`）只是 JSON Schema 校验用的占位常量，**实际枚举值不通过该常量暴露**
- 业务层 `add_baseline_data` 通过 `type_converter.to_type(baseline.get("baseline_type"))` 将字符串类型转换为整数枚举值
- 字段重命名链：入参 `type` → 业务层 `baseline_type`（trap，在 `add_baseline_data` 内完成）

#### 填写要求模板
- 完整整数枚举值 → 字符串类型名映射：`{0: "xxx", 1: "yyy", ...}`
- 字符串类型名 → 中文说明：`{"password_policy": "密码策略", ...}`
- 标注 BaseLineTypeConverter 实现位置（具体类名 + 文件路径）
- 与 `BASELINE_TYPE_LIST` 常量的关系（是否一致或互补）

### P-6. 来源类型（src_type）

| 属性 | 值 |
|------|-----|
| 字段名 | src_type（响应字段） |
| 业务域 | 脆弱性管理 |
| 字段类型 | string |
| 数据源描述 | 业务层将 DB 中的 `src_type` uids（如 "uid_xxx"）转换为设备 short_name。具体 short_name 列表与 `SOURCE_DEVICE_INFO` 同源，但响应字段会做反向转换。 |
| 所在 API 文档 | risk-list.md（v2 通道） |
| Python 源码位置 | `soar/apps/vuln_web/app/open_api/v1/risk/business.py` -> `get_risk_detail_proof`（具体反向转换函数需运行时确认） |

#### 填写要求模板
- uid → short_name 反向映射表
- 与 `SOURCE_DEVICE_INFO` 的对应关系

