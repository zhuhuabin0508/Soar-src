# SOAR 平台 · API 开放平台接口文档

> 版本：v1.0 ｜ 更新日期：2026-11-04 ｜ 适用对象：第三方系统对接人员
>
> 本文档描述通过 API 开放平台调取 SOAR 平台数据的全部接口。数据均为**只读查询**。

---

## 1. 概述

| 项目 | 说明 |
|---|---|
| Base URL | `http(s)://<平台地址>/api/v1` |
| 协议 | HTTP / HTTPS（生产环境强烈建议 HTTPS） |
| 数据格式 | 请求：Query String ｜ 响应：`application/json; charset=utf-8` |
| 请求方法 | 全部为 `GET`（只读，无写操作面） |
| 时间格式 | 响应时间均为北京时间 ISO 字符串，如 `2026-11-04T10:30:00+08:00` |

**开放资源一览**

| 资源编码 | 名称 | 说明 | 分页 |
|---|---|---|---|
| `alerts` | 告警事件 | 标准化告警列表（等级/状态/源目IP/时间） | ✅ |
| `assets` | 资产清单 | 资产名称/IP/类型/部门/负责人/状态 | ✅ |
| `banned_ips` | 封禁记录 | IP 封禁记录与到期状态 | ✅ |
| `tickets` | 安全工单 | 工单编号/标题/状态/优先级/当前节点 | ✅ |
| `executions` | 执行记录 | 工作流执行历史与结果 | ✅ |
| `dashboard_stats` | 安全统计汇总 | 告警/封禁/工单/执行聚合指标 | ❌（聚合） |
| `ticket_monitor` | 工单监控大屏 | 大屏聚合数据（KPI/趋势/分布/排名等） | ❌（聚合） |

> 实际可调用的资源以平台管理员为你的应用**授权的子集**为准，可通过 [`GET /open`](#31-查询可用资源目录) 自助查询。

---

## 2. 鉴权

### 2.1 API Key

每个接入应用由平台管理员签发一对密钥：

| 凭证 | 说明 | 示例 |
|---|---|---|
| Access Key | 公开标识，`ak_` 前缀 | `ak_165c068a4c18fae96afa2df9b1220b3a` |
| Secret | 私密钥，`sk_` 前缀，**仅在签发/重置时一次性展示** | `sk_490e62aa...8cd8648` |

### 2.2 调用方式

请求头携带 API Key（Access Key 与 Secret 用英文冒号拼接）：

```
X-API-Key: {access_key}:{secret}
```

示例：

```bash
curl -H "X-API-Key: ak_xxxx:sk_xxxx" \
  "http://<平台地址>/api/v1/open/alerts?page=1&page_size=20"
```

### 2.3 鉴权校验链

按以下顺序校验，任一环节失败即拒绝：

1. **密钥校验**：Key 存在、Secret 正确（连续失败 10 次锁定该 Key 10 分钟）
2. **应用状态**：未被停用、未过有效期
3. **IP 白名单**：应用配置白名单时，仅允许名单内来源 IP
4. **数据授权**：应用必须被授权所请求的资源
5. **限流配额**：不超过应用的每分钟调用配额（默认 60 次/分钟）

### 2.4 错误码约定

| 状态码 | message 说明 | 排查建议 |
|---|---|---|
| `200` | 成功 | — |
| `401` | API Key 格式错误 / API Key 无效 | 检查 `X-API-Key` 头与 Secret 是否正确 |
| `403` | 应用已被停用 / 密钥已过期 / IP 不在白名单 / 未授权访问资源 | 联系平台管理员确认授权与白名单 |
| `404` | 资源不存在 | 资源编码拼写错误，先调 `GET /open` 确认 |
| `429` | 调用频率超过配额 / 密钥连续失败被临时锁定 | 退避重试，或联系管理员调高配额 |
| `500` | 服务内部错误 | 携带时间戳联系平台管理员 |

错误响应体（FastAPI 标准格式）：

```json
{ "detail": "该应用未被授权访问资源: assets" }
```

---

## 3. 接口定义

### 3.1 查询可用资源目录

`GET /open` ｜ 返回当前 Key 有权访问的资源目录及各资源支持的过滤参数。

**请求示例**

```bash
curl -H "X-API-Key: ak_xxxx:sk_xxxx" "http://<平台地址>/api/v1/open"
```

**响应示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "app_name": "SOC 集成系统",
    "resources": [
      {
        "code": "alerts",
        "name": "告警事件",
        "description": "标准化告警列表：告警名称、等级、威胁类型、源/目的IP、处置状态、发生时间等",
        "filters": ["deal_status", "risk_level", "keyword", "start_time", "end_time", "page", "page_size"]
      },
      { "code": "dashboard_stats", "name": "安全统计汇总", "description": "…", "filters": [] }
    ]
  }
}
```

### 3.2 统一数据端点（分页类资源）

`GET /open/{resource_code}` ｜ 通用约定适用于所有分页类资源。

**通用查询参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int | 否 | 页码，默认 `1` |
| `page_size` | int | 否 | 每页条数，默认 `20`，**最大 `100`** |
| `start_time` | string | 否 | 过滤起始时间，`YYYY-MM-DD HH:MM:SS` 或 ISO 格式 |
| `end_time` | string | 否 | 过滤结束时间，同上 |

**统一响应结构**

```json
{
  "code": 0,
  "message": "ok",
  "resource": { "code": "alerts", "name": "告警事件", "filters": ["…"] },
  "data": {
    "items": [ { "…": "…" } ],
    "total": 1234,
    "page": 1,
    "page_size": 20
  }
}
```

---

### 3.2.1 告警事件 `GET /open/alerts`

**过滤参数**（在通用参数之外）

| 参数 | 类型 | 说明 |
|---|---|---|
| `deal_status` | int | 处置状态：`0` 未处置 / `1` 已处置（以平台实际枚举为准） |
| `risk_level` | int | 风险等级 |
| `keyword` | string | 关键字，匹配告警名称 / UUID / 源IP |

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 告警 ID |
| `uuid` | string | 告警唯一标识 |
| `alert_name` | string | 告警名称 |
| `description` | string | 描述（超长截断至 500 字符） |
| `device_type` | string | 设备类型 |
| `alert_rule_name` | string | 命中规则名 |
| `src_ip` / `dst_ip` | string | 源 / 目的 IP |
| `src_port` / `dst_port` | int | 源 / 目的端口 |
| `protocol` | string | 协议 |
| `direction_name` | string | 方向 |
| `risk_level_name` | string | 风险等级名称 |
| `severity` | string | 严重级别 |
| `threat_class` / `threat_type` | string | 威胁分类 / 类型 |
| `attack_state_name` | string | 攻击状态 |
| `deal_status` / `deal_status_name` | int / string | 处置状态码 / 名称 |
| `assignee_name` | string | 处置人 |
| `handled_at` | string | 处置时间 |
| `aggregation_count` | int | 聚合条数 |
| `occur_timestamp` / `first_timestamp` / `last_timestamp` / `created_at` | string | 发生 / 首次 / 最近 / 入库时间 |

---

### 3.2.2 资产清单 `GET /open/assets`

**过滤参数**：`asset_type`（资产类型）、`status`（生命周期状态）、`criticality`（重要性）、`keyword`（名称/标识/IP 模糊）

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 资产 ID |
| `name` | string | 资产名称 |
| `identifier` / `identifier_type` | string | 资产标识 / 标识类型 |
| `asset_type` / `type_code` | string | 资产类型 / 类型编码 |
| `ip` | string | IP 地址 |
| `department` / `owner` / `location` | string | 部门 / 负责人 / 位置 |
| `criticality` | string | 重要性 |
| `status` | string | 生命周期状态 |
| `source` | string | 来源 |
| `created_at` / `updated_at` | string | 创建 / 更新时间 |

---

### 3.2.3 封禁记录 `GET /open/banned_ips`

**过滤参数**：`status`（状态）、`ban_level`（封禁等级）、`ip`（IP 模糊）

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 记录 ID |
| `ip` | string | 被封禁 IP |
| `ban_level` | string | 封禁等级 |
| `ban_duration` | string | 封禁时长 |
| `expired_at` | string | 到期时间 |
| `region` | string | 归属地区 |
| `violation_count` | int | 违规次数 |
| `reason` | string | 封禁原因 |
| `status` | string | 状态（`active` 生效中 / 其他为已解封） |
| `source` / `device_name` | string | 来源 / 来源设备 |
| `created_at` / `updated_at` | string | 创建 / 更新时间 |

---

### 3.2.4 安全工单 `GET /open/tickets`

**过滤参数**：`status`（状态）、`priority`（优先级）、`keyword`（标题模糊）
> 默认排除已归档工单。

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `ticket_no` | int / string | 工单 ID / 编号 |
| `title` | string | 标题 |
| `flow_name` | string | 所属流程 |
| `status` | string | 状态 |
| `priority` | string | 优先级 |
| `current_node_name` | string | 当前节点 |
| `created_by_name` | string | 发起人 |
| `related_alert_uuid` | string | 关联告警 UUID |
| `created_at` / `updated_at` / `closed_at` | string | 创建 / 更新 / 关闭时间 |

---

### 3.2.5 执行记录 `GET /open/executions`

**过滤参数**：`status`（状态）、`trigger_type`（触发类型）

**返回字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 执行 ID |
| `workflow_id` / `workflow_name` | int / string | 工作流 ID / 名称 |
| `status` | string | 执行状态（`success` / `failed` / …） |
| `trigger_type` | string | 触发类型 |
| `created_at` / `finished_at` | string | 开始 / 完成时间 |

---

### 3.3 安全统计汇总 `GET /open/dashboard_stats`

无过滤参数。**响应结构为聚合 dict（无 items 分页包装）**。

**响应示例**

```json
{
  "code": 0,
  "message": "ok",
  "resource": { "code": "dashboard_stats", "name": "安全统计汇总" },
  "data": {
    "generated_at": "2026-11-04T10:30:00+08:00",
    "alerts":       { "total": 12034, "today": 56, "unhandled": 12 },
    "banned_ips":   { "total": 834,   "active": 210 },
    "tickets":      { "total": 456,   "processing": 23 },
    "executions":   { "total": 2380,  "success": 2215 }
  }
}
```

---

### 3.4 工单监控大屏 `GET /open/ticket_monitor`

返回与平台内部工单监控大屏完全一致（同源同口径）的聚合数据。

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `flow_id` | int | 否 | 指定流程模板 ID；缺省自动选取进行中工单最多的流程 |
| `light` | bool | 否 | `1` 轻量模式：仅返回 `kpi` + 最新工单，适合高频轮询 |
| `include_drill` | bool | 否 | `0` 不下发下钻工单集（默认下发） |
| `drill_limit` | int | 否 | 下钻集条数上限，默认 `2000`，范围 `100~2000` |

**响应结构（`data` 为聚合 dict）**

| 字段 | 说明 |
|---|---|
| `kpi` | 工单总量 / 今日新增 / 进行中 / 已关闭 / 按时率等核心指标 |
| `trend` | 新增 / 关闭趋势时间序列 |
| 优先级、类型分布 | 分布饼图数据 |
| `team_stats` | 团队/处理组工作量排名 |
| 来源平台、封禁IP、流转节点统计 | 大屏各板块对应数据 |
| `latest` | 最新工单列表 |
| 下钻集（drill） | 可下钻的工单明细集合 |

> 字段较多，建议先调用一次获取样例，再按需取用；高频轮询场景务必携带 `light=1`。

---

## 4. 调用规范与最佳实践

1. **分页拉取**：全量同步请按 `page` 递增循环拉取，直到 `items` 为空或累计达到 `total`；`page_size` 固定用 `100` 减少请求次数。
2. **增量同步**：用 `start_time` / `end_time` 按时间窗口拉取增量，避免每次全量。
3. **限流退避**：收到 `429` 后请按指数退避重试（建议 ≥ 60s 后再试）；调用 QPS 峰值不要超过 配额/60。
4. **密钥安全**：Secret 仅展示一次，请加密保存；切勿写入前端代码或日志；泄露后立即联系管理员重置（旧密钥即时失效）。
5. **时间处理**：所有时间为北京时间 ISO 字符串，解析时注意 `+08:00` 时区后缀。
6. **不要硬编码资源列表**：接入前先调 `GET /open` 获取当前授权资源与过滤参数，平台侧扩容后无需改代码。

---

## 5. 对接检查清单

- [ ] 已获得 Access Key + Secret，并确认已授权所需资源
- [ ] （如启用）出口 IP 已加入应用白名单
- [ ] `GET /open` 能正常返回资源目录
- [ ] 各资源接口试调通过（200）
- [ ] 已实现 401/403/429 错误处理与退避重试
- [ ] 已确认限流配额满足业务峰值调用量
- [ ] Secret 已妥善加密保存

---

*如有问题请联系平台管理员。本文档由 SOAR 平台 API 开放平台提供。*
