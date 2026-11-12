# 内置设备库：深信服 XDR 接口动作说明

本文档说明系统内置设备库中「深信服XDR」模板的接口动作定义、参数映射、返回数据解析与错误处理方式。
接口定义来源：`XDR-API文档/接口开放列表.html`（安全告警 alerts / 安全事件 incidents / 资产 assets），
文档副本位于 `backend/app/data/xdr_skill_reference/api-docs/`。

## 1. 模板信息

| 项目 | 值 |
| --- | --- |
| 模板名称 | 深信服XDR（内置模板，code=`sangfor_xdr`） |
| 设备厂商 | 深信服 |
| 设备类别 | 自定义（custom） |
| 对接协议版本 | OpenAPI v1 |
| 认证方式 | `sangfor_xdr`：AK/SK 联动码签名（HMAC-SHA256） |
| 动作数量 | 63（告警 24 + 事件 23 + 资产/资产组 16） |
| 默认超时 / 重试 | 30 秒 / 2 次（仅对网络异常与 5xx 自动重试） |

初始化逻辑位于 `backend/app/core/device_template_library.py::seed_sangfor_xdr_template`，
动作定义由 `backend/app/core/sangfor_xdr_actions.py` 固化，服务启动时幂等注册：
已存在 `code=sangfor_xdr` 的模板时不会重复创建；若用户已手动创建深信服 XDR 模板，则复用该条目并补齐动作。
内置清单后续新增动作（如资产查询）时，已初始化环境也会按 `api_path` 去重自动补齐到模板与
`auth_type=sangfor_xdr` 的存量设备（`_complement_sangfor_xdr_actions`），不覆盖用户对既有动作的修改。
内置动作定义升级（`version` 提高，如 v2 修正告警统计口径说明）时，`version` 落后的模板动作与
存量设备动作会被自动同步 description / params_schema / 示例与版本号（`_sync_sangfor_xdr_action_versions`），
用户自改且 `version` 不落后于内置版本的动作不受影响。
动作描述含接口口径与参数说明，可超过 512 字符：`device_actions` /
`device_builtin_template_actions` 的 `description` 列为 `VARCHAR(2000)`，
老库由启动时轻量迁移自动扩列。

## 2. 认证方式

深信服 XDR 开放性接口使用联动码（内含 AccessKey/SecretKey）做 AK/SK 签名：

- 在「内置设备库」复用模板创建设备时，将联动码粘贴到「联动码（AK/SK）」输入框；
- 执行器会解析联动码，将 AK 加密存入 `api_key`、SK 加密存入 `password`，数据库不保存明文；
- 请求签名由动作执行器 `_sangfor_xdr_sign` 自动完成，签名字段为
  `sdk-host`、`sdk-content-type`、`sign-date`，Authorization 形如
  `algorithm=HMAC-SHA256, Access=<AK>, SignedHeaders=..., Signature=...`；
- GET 接口参数自动转为 Query 参数并按排序后的查询串参与签名；POST 接口使用 JSON 请求体，
  签名与实际发送使用同一份序列化字节，避免编码差异导致验签失败。

## 3. 动作清单

| # | 动作名称 | 方法 | 接口路径 | 参数数 | 分类 |
| --- | --- | --- | --- | --- | --- |
| 1 | 告警聚合统计 | POST | `/api/xdr/v1/alerts/aggregation` | 20 | query |
| 2 | 告警资产维度聚合统计 | POST | `/api/xdr/v1/alerts/asset/aggregation` | 17 | query |
| 3 | 告警攻击区域查询 | POST | `/api/xdr/v1/alerts/attack/area` | 7 | query |
| 4 | 告警攻击连线查询 | POST | `/api/xdr/v1/alerts/attack/link` | 7 | query |
| 5 | 告警攻击源查询 | POST | `/api/xdr/v1/alerts/attack/sources` | 9 | query |
| 6 | 告警受攻击资产查询 | POST | `/api/xdr/v1/alerts/attack/target` | 9 | query |
| 7 | 告警攻击关系聚合统计 | POST | `/api/xdr/v1/alerts/attackrelations/aggregation` | 20 | query |
| 8 | ATT&CK 技术信息查询 | GET | `/api/xdr/v1/alerts/attcktechniques` | 0 | query |
| 9 | 告警分支统计 | POST | `/api/xdr/v1/alerts/branchstats` | 20 | query |
| 10 | 告警融合统计 | POST | `/api/xdr/v1/alerts/countFusion` | 3 | query |
| 11 | 告警处置状态批量查询 | POST | `/api/xdr/v1/alerts/dealstatus/list` | 1 | query |
| 12 | 告警处置状态更新 | POST | `/api/xdr/v1/alerts/dealstatus` | 4 | dispose |
| 13 | 告警数据源列表查询 | GET | `/api/xdr/v1/alerts/devUidName` | 0 | query |
| 14 | DNS 威胁实体查询 | POST | `/api/xdr/v1/alerts/disposition/dns` | 7 | query |
| 15 | 告警详情查询 | POST | `/api/xdr/v1/alerts/getAlertInfo` | 3 | query |
| 16 | 威胁实体信息查询 | POST | `/api/xdr/v1/alerts/getEntityInfo` | 1 | query |
| 17 | 告警 GPT 日志 ID 查询 | POST | `/api/xdr/v1/alerts/getGptLogIds` | 1 | query |
| 18 | 关联告警 ID 查询 | POST | `/api/xdr/v1/alerts/getXenAlertId` | 7 | query |
| 19 | GPT 研判结论枚举查询 | GET | `/api/xdr/v1/alerts/gptresult/type` | 0 | query |
| 20 | 告警 IP 聚合信息查询 | POST | `/api/xdr/v1/alerts/ipInfos` | 18 | query |
| 21 | 告警源 IP+国家聚合统计 | POST | `/api/xdr/v1/alerts/ipinfosstats` | 8 | query |
| 22 | 告警研判标签查询 | POST | `/api/xdr/v1/alerts/labels/list` | 2 | query |
| 23 | 告警列表查询 | POST | `/api/xdr/v1/alerts/list` | 20 | query |
| 24 | 告警趋势统计 | POST | `/api/xdr/v1/alerts/trends` | 20 | query |
| 25 | 事件聚合统计 | POST | `/api/xdr/v1/incidents/aggregation` | 20 | query |
| 26 | 事件资产维度聚合统计 | POST | `/api/xdr/v1/incidents/asset/aggregation` | 18 | query |
| 27 | 事件平均处置时长统计 | POST | `/api/xdr/v1/incidents/averageduration` | 13 | query |
| 28 | 事件资产组 TopN 统计 | POST | `/api/xdr/v1/incidents/branches/count` | 4 | query |
| 29 | 事件关联详情查询 | POST | `/api/xdr/v1/incidents/cot/relate` | 13 | query |
| 30 | 事件新增数统计 | GET | `/api/xdr/v1/incidents/incidentDataGeneration` | 2 | query |
| 31 | 事件处置率统计 | POST | `/api/xdr/v1/incidents/dealrate` | 6 | query |
| 32 | 事件处置状态数量统计 | POST | `/api/xdr/v1/incidents/dealstatus/count` | 4 | query |
| 33 | 事件处置状态批量查询 | POST | `/api/xdr/v1/incidents/dealstatus/list` | 1 | query |
| 34 | 事件检测时长统计 | POST | `/api/xdr/v1/incidents/detectiontime` | 13 | query |
| 35 | 设备 MSS 版本查询 | GET | `/api/xdr/v1/incidents/device_version_mss` | 0 | query |
| 36 | 事件时长列表查询 | POST | `/api/xdr/v1/incidents/durationlist` | 20 | query |
| 37 | 事件列表查询 | POST | `/api/xdr/v1/incidents/list` | 20 | query |
| 38 | 事件驳回 | POST | `/api/xdr/v1/incidents/reject` | 12 | dispose |
| 39 | 安全态势分析 | POST | `/api/xdr/v1/incidents/security/analysis` | 4 | query |
| 40 | 事件等级分布统计 | POST | `/api/xdr/v1/incidents/severity/count` | 2 | query |
| 41 | 事件遏制统计 | POST | `/api/xdr/v1/incidents/suppress` | 2 | query |
| 42 | 事件遏制时长统计 | POST | `/api/xdr/v1/incidents/suppressduration` | 9 | query |
| 43 | 事件类型分布统计 | POST | `/api/xdr/v1/incidents/tag/count` | 4 | query |
| 44 | 事件一级分类查询 | GET | `/api/xdr/v1/incidents/threatclass` | 0 | query |
| 45 | 事件二级分类查询 | GET | `/api/xdr/v1/incidents/threattype` | 0 | query |
| 46 | 事件时延统计 | POST | `/api/xdr/v1/incidents/timedelayduration` | 6 | query |
| 47 | 事件趋势统计 | POST | `/api/xdr/v1/incidents/trends` | 20 | query |
| 48 | 资产组列表查询 | GET | `/api/xdr/v1/bigscreen/branchlist` | 0 | query |
| 49 | 资产组详情信息查询 | POST | `/api/xdr/v1/bigscreen/branchs/detailInfo` | 7 | query |
| 50 | 资产组访问信息查询 | POST | `/api/xdr/v1/bigscreen/branchs/accessInfo` | 3 | query |
| 51 | 资产组资产类型统计 | GET | `/api/xdr/v1/bigscreen/branchs/total` | 0 | query |
| 52 | 资产组资产列表查询 | POST | `/api/xdr/v1/bigscreen/branchs/assets/details` | 6 | query |
| 53 | 资产列表查询 | POST | `/api/xdr/v1/assets/list` | 20 | query |
| 54 | 资产总数查询 | POST | `/api/xdr/v1/assets/total` | 20 | query |
| 55 | 资产类型查询 | GET | `/api/xdr/v1/assets/assetclass` | 0 | query |
| 56 | 资产数据源列表查询 | GET | `/api/xdr/v1/assets/assetsource` | 0 | query |
| 57 | 资产来源设备查询 | GET | `/api/xdr/v1/assets/sourcedevice` | 0 | query |
| 58 | 资产责任人列表查询 | GET | `/api/xdr/v1/assets/user` | 0 | query |
| 59 | 资产部门树查询 | GET | `/api/xdr/v1/assets/department` | 0 | query |
| 60 | 资产IP段树查询 | POST | `/api/xdr/v1/assets/ipsegmenttree` | 20 | query |
| 61 | 待审核资产查询 | POST | `/api/xdr/v1/assets/approve/waitapprove` | 16 | query |
| 62 | 风险主机列表查询 | POST | `/api/xdr/v1/riskassets/list` | 7 | query |
| 63 | 风险主机趋势统计 | POST | `/api/xdr/v1/riskassets/trends` | 8 | query |

> 说明：每个动作固化文档中前 20 个主要请求参数（`params_schema` 列有 4096 字符上限）；
> 完整参数说明、取值枚举与更多示例以 `XDR-API文档/接口开放列表.html` 及
> `backend/app/data/xdr_skill_reference/api-docs/{alerts,incidents}/*.md` 为准。

### 3.1 资产组（branch）说明

XDR 中「资产组」在接口层面称为分支（branch），`branchId` 即资产组 ID：

- **资产组列表查询**（`GET /api/xdr/v1/bigscreen/branchlist`）返回完整资产组层级树，
  每个节点含 `id`（资产组 ID）、`name`（名称）、`parentId`（父资产组 ID）与
  `children`（下级资产组数组），是资产组名称 ↔ ID 映射、层级遍历、下级（二级）资产组
  检索的统一入口，无需请求参数；
- 告警/事件聚合类接口（如 `alerts/asset/aggregation`、`incidents/branches/count`）返回的
  `hostBranchId` 等字段即上述 `id`，可通过资产组名称查询接口映射回名称；
- `assets/list` 响应中同时含 `branchId` 与 `branchName`，并支持按 `branchId`/`branchIds` 过滤。

## 4. 参数映射规则

动作的 `params_schema` 为 JSON 数组，每个参数包含：

| 字段 | 含义 |
| --- | --- |
| `name` | 参数名，与 XDR OpenAPI 请求字段一致（如 `startTimestamp`、`pageSize`、`filterParam`） |
| `label` | 参数展示名 |
| `type` | 参数类型：`string` / `integer` / `number` / `boolean` / `array` / `object` |
| `required` | 是否必填；必填参数为空时执行前直接报「参数不能为空」 |
| `description` | 文档中的取值范围/说明 |
| `default` | 文档声明的默认值，调用方未传时自动回填 |

映射规则：

- 调用方传入的参数按 `name` 原样映射到请求体字段（POST）或 Query 参数（GET）；
- 有默认值且调用方未传（或传空串）时使用默认值，避免设备 4xx；
- 参数类型为 `integer/number` 时按裸数值下发（不加引号），`array/object` 支持 JSON 字符串自动解析；
- 批量处置状态查询接口（`alerts/dealstatus/list`、`incidents/dealstatus/list`）请求体为**原始数组**，
  动作使用 `uuIds` 数组参数 + `body_template={{uuIds}}` 下发，避免被包装成对象；
- 路径中如包含 `{param}` 占位符会自动替换为对应参数值。

## 5. 返回数据解析

- 执行器以 HTTP 响应解析 JSON 后写入 `response_body`，动作的 `example_response` 保存了文档中的
  成功响应样例（无成功示例的接口按响应结构表生成字段骨架）；
- 深信服 XDR 响应统一为 `{ "code": "Success", "message": "success", "data": ... }`：
  - 列表类接口：`data.item` 为数据数组，`data.total/page/pageSize` 为分页信息；
  - 聚合/统计类接口：数据位于 `data`（对象或数组），字段含义见文档；
  - 详情类接口：`data` 为告警/事件详情对象或数组；
- 动作执行结果结构：`{ success, status_code, response_body, error, latency_ms }`，
  `response_body` 为已解析的 Python 对象，可在剧本后续节点直接按 `data.item[0].uuId` 等路径取值。

## 6. 错误处理机制

| 场景 | 处理方式 |
| --- | --- |
| HTTP 4xx（参数/权限错误） | 不重试，返回 `success=false`、`error="HTTP <code>: <响应体前 300 字符>"` |
| HTTP 5xx / 网络异常 | 按模板 `max_retries=2` 自动重试，仍失败则记录调用日志并返回错误 |
| 联动码未配置/解析失败 | 执行前返回明确错误「设备未配置 XDR 联动码」/「XDR 联动码解析失败」 |
| 必填参数缺失 | 执行前校验并返回「参数「xxx」不能为空」，不发起请求 |
| 参数类型错误 | 返回「参数「xxx」必须是整数/数字/JSON 数组/JSON 对象」 |
| 非 JSON 响应 | 保留原始文本并在调用日志中记录，便于定位网关/证书问题 |
| 调用留痕 | 每次执行写入设备调用日志（请求摘要、状态码、耗时、错误信息） |

## 7. 使用方式

1. 进入「设备对接 → 内置设备库」，找到「深信服XDR」模板（来源：系统内置/手动新增均会复用同一条目）；
2. 点击「复用创建」，填写设备名称、XDR 管理地址（如 `https://<xdr-host>`）与联动码；
3. 创建完成后在设备详情中可直接查看并编辑 63 个告警/事件/资产动作；
4. 动作可在「测试」中单独执行，也可在剧本编排中选择「深信服XDR」下的动作节点，
   按 `params_schema` 填写参数即可；
5. 需要修改参数默认值或补充说明时，编辑模板动作仅影响模板，不影响已创建的设备；
   复用后设备的动作是独立副本，同样不会反向影响模板。

## 8. 验证记录

- 单元测试 `backend/tests/test_sangfor_xdr_template.py`：5 个用例通过
  （模板与 63 个动作固化、手动模板复用不重复、签名与 GET/POST 请求构造、
  已初始化环境按 api_path 补齐新增资产动作且不覆盖用户修改、
  内置定义升级后 version 落后的模板/设备动作自动同步且不覆盖用户 v2+ 修改）；
- 真实环境联调（通过动作执行器、使用联动码签名）：
  - `告警列表查询 POST /api/xdr/v1/alerts/list` → HTTP 200，正确返回 `data.item` 告警数据；
  - `事件列表查询 POST /api/xdr/v1/incidents/list` → HTTP 200，正确返回 `data.item` 事件数据；
  - `资产组列表查询 GET /api/xdr/v1/bigscreen/branchlist` → HTTP 200，正确返回资产组层级树
    （全量 89 个资产组，含「深圳市政数局资产」id=4 及其 84 个二级资产组）；
  - 以上接口均验证了请求签名、参数映射、JSON 响应解析与调用日志记录。

## 9. 告警统计口径与资产组过滤注意事项（v2 动作说明要点）

针对"资产组今日告警统计查出 4 万多条 vs 平台 385 条"问题实测确认的口径要点，
已固化到 4 个告警动作（`aggregation` / `countFusion` / `list` / `trends`，version=2）
的 description 与 params_schema 中：

| 事项 | 结论 |
| --- | --- |
| 时间口径 `timeField` | `lastTime`=按最近发生时间统计（当日**活跃**告警，平台告警页"今日"默认口径，含仍在活跃的历史告警，数值偏大）；`firstTime`=按首次产生时间统计（当日**新增**告警） |
| 资产组过滤（trends/aggregation） | 必须用 `filterParam.hostBranchIds`（数据库字段 hostBranchId），且数组须同时包含目标资产组及其**全部下挂子资产组 ID**（用「资产组列表查询」展开），与平台资产组树筛选行为一致 |
| `platformHostBranchIds` | 在 trends / aggregation 上实测**不生效**（服务端忽略，带与不带结果完全相同），禁止用于资产组过滤 |
| `alerts/list` 资产组过滤 | 实测不可用（`filterParam.hostBranchIds` 与 `platformHostBranchIds` 均不生效），按资产组筛选/统计请改用「告警趋势统计」或「告警资产维度聚合统计」 |
| `alerts/countFusion` | 不支持按资产组过滤（统计结果为全平台口径），按资产组统计请用「告警趋势统计」 |
| `fuzzyParam` | 实测平台侧未生效，勿依赖 |

实测基线（2026-11-12，"深圳市政数局资产" id=4 + 83 子组）：
`trends timeField=lastTime filterParam.hostBranchIds=[4+子组]` ≈391（早上）→ 413（午后），
严重 173→179 / 高危 140→155 / 中危 78→79，与平台告警页"今日 + 资产组筛选"一致；
全平台 lastTime ≈4.35 万、firstTime ≈1.11 万。

## 10. 智能体工具包

XDR 的 63 个设备动作已封装为标准化智能体工具，每个动作对应一个工具，可直接在智能体
「工具」配置中勾选启用，由智能体按功能描述自主选择调用。另有 2 个组合工具：
资产组查询专用 `query_xdr_asset_group`（见 10.6）与
资产组告警统计专用 `query_xdr_alert_stats`（见 10.7）。

### 10.1 工具命名与代码位置

- 工具定义：`backend/app/core/tools/definitions/xdr_actions.py`（由内置动作清单自动生成）
- 统一调用入口：`backend/app/tools/xdr_action_tools.py` 的 `run_xdr_action`
- 命名规则：由 API 路径生成，`/api/xdr/v1/` 前缀去掉后按层级拼接并转 snake_case，统一加
  `xdr_` 前缀。例如：
  - `/api/xdr/v1/alerts/list` → `xdr_alerts_list`
  - `/api/xdr/v1/incidents/trends` → `xdr_incidents_trends`
  - `/api/xdr/v1/alerts/countFusion` → `xdr_alerts_count_fusion`
  - `/api/xdr/v1/bigscreen/branchlist` → `xdr_bigscreen_branchlist`
  - `/api/xdr/v1/assets/list` → `xdr_assets_list`
- 每个工具的参数来自动作 `params_schema`，已映射为工具协议类型
  （`Integer`/`Number`/`Boolean`/`Array`/`Object`/`String`），带必填标记、默认值、枚举与
  字段说明；所有工具额外提供可选参数 `device_id`（多台 XDR 设备时指定目标）。

### 10.2 统一调用链路

```
智能体 → 工具代码（仅透传 action_key/params/device_id）
      → run_xdr_action（参数校验 → 解析设备与动作 → 权限门禁）
      → execute_device_action（AK/SK 签名、超时、重试、调用日志）
      → 结构化结果
```

- 认证鉴权：复用设备已配置的 XDR 联动码完成 HMAC-SHA256 签名，工具层不接触明文凭据；
- 超时/重试：默认使用设备配置（超时 30 秒、最多重试 2 次），入口支持按调用覆盖超时；
- 异常处理：参数、设备、权限、网络、HTTP、业务码错误均转换为结构化错误，不向智能体抛出异常；
- 审计：调用日志来源记为 `agent`，并记录 `agent_id`/`user_id`；中高风险处置动作
  （如事件驳回、处置状态更新）沿用服务端权限门禁，缺少用户上下文时直接拒绝。

### 10.3 返回格式

```json
{
  "ok": true,
  "status": "success",
  "http_status": 200,
  "code": "Success",
  "message": "success",
  "data": { "item": [], "total": 0 },
  "error": null,
  "latency_ms": 123,
  "device": { "id": 20, "name": "深信服XDR", "type": "custom" },
  "action": { "key": "xdr_alerts_list", "name": "告警列表查询", "api_path": "/api/xdr/v1/alerts/list" }
}
```

- `ok=true`：`data` 为已解包的 XDR 业务数据（统一响应中的 `data`），完整原始响应在
  `raw_response`；
- `ok=false`：`error` 包含 `type`、`message`、`retryable`、`details`，智能体可按类型决策。

| error.type | 含义 | 是否可重试 |
| --- | --- | --- |
| `validation_error` | 缺少必填、类型错误、未知参数 | 否（修正参数后重试） |
| `device_not_configured` / `device_ambiguous` / `device_not_found` / `device_disabled` | 设备未配置、多台需指定、设备不存在或已禁用 | 否 |
| `action_not_found` | 设备上未同步该动作 | 否（重新复用模板设备） |
| `permission_denied` | 中高风险动作缺少用户上下文或权限不足 | 否 |
| `auth_error` | 401/403、联动码/签名/凭据错误 | 否 |
| `not_found_error` / `http_error` | 404 或其他 4xx | 否 |
| `rate_limited` | 429 限流 | 是 |
| `server_error` | 5xx | 是 |
| `timeout` / `connection_error` | 超时、连接失败 | 是 |
| `business_error` | HTTP 200 但 XDR 业务码非成功 | 否 |
| `internal_error` | 工具层未预期异常 | 否 |

### 10.4 智能体调用示例

```json
// 工具：xdr_alerts_list
{
  "page": 1,
  "pageSize": 10,
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime"
}
```

```json
// 工具：xdr_alerts_aggregation（按告警严重等级统计）
{
  "startTimestamp": 1782604800,
  "endTimestamp": 1783209600,
  "timeField": "lastTime",
  "aggBy": ["alertSeverity"],
  "aggFuncs": [{ "name": "count", "func": "count", "param": "name" }],
  "limit": 20
}
```

### 10.5 验证记录

- 单元测试 `backend/tests/test_xdr_action_tools.py`：31 个用例通过，覆盖 63 个工具定义
  完整性（命名唯一、类型合法、必填/嵌套字段正确、描述含使用场景与示例）、工具代码透传、
  正常调用、参数缺失/类型错误/未知参数、设备未配置/不存在、高风险权限门禁，以及
  401/403/404/429/500/502/400、超时、连接失败、业务码失败等接口异常场景；
  另含 `query_xdr_asset_group`（6 个场景）与 `query_xdr_alert_stats`
  （7 个场景：正常统计与参数校验、跨时间桶/兼容桶形态求和、不含子组、缺省今日、
  未命中、上游失败）专用工具用例；
- 真实环境联调：`xdr_alerts_list`（page=1, pageSize=5）返回 HTTP 200，`data` 含
  `item/page/total/pageSize`；`pageSize=1` 时正确归类为 `http_error` 并返回设备业务提示
  `param pageSize min is 5`，验证了签名、超时、错误消息透传与结构化分类。

### 10.6 资产组查询专用工具：query_xdr_asset_group

针对"已知资产组名称求 ID / 查下属二级资产组"的高频场景，在 63 个原子动作工具之外
封装了组合工具 `query_xdr_asset_group`（定义位于
`backend/app/core/tools/definitions/xdr.py`，实现位于
`backend/app/tools/xdr_action_tools.py::query_xdr_asset_group`）。

**参数定义：**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `group_name` | String | 二选一 | 目标资产组名称（如 `深圳市政数局资产`），先精确后包含匹配 |
| `group_id` | Number | 二选一 | 目标资产组 ID；与 `group_name` 同时提供时按 ID 优先 |
| `include_descendants` | Boolean | 否 | 是否返回全部下级资产组（默认 `true`） |
| `device_id` | Number | 否 | 目标 XDR 设备 ID；仅一台已启用 XDR 设备时可省略 |

**返回值结构（命中时）：**

```json
{
  "ok": true,
  "matched": true,
  "group": { "id": 4, "name": "深圳市政数局资产", "parent_id": -1, "depth": 1, "path": "深圳市政数局资产" },
  "children": [ { "id": 5, "name": "深圳市数字政府盾立方▪安全防御平台", "parent_id": 4, "children_count": 0 } ],
  "descendants": [ { "id": 5, "name": "...", "parent_id": 4, "depth": 2, "path": "深圳市政数局资产/..." } ],
  "descendant_ids": [5, 6, 7, "..."],
  "total_groups": 89
}
```

- `group`：目标资产组（ID、名称、父组 ID、深度、层级路径）；
- `children`：直接下级（二级）资产组列表；
- `descendants` / `descendant_ids`：全部后代资产组（含二级及更深）与 ID 清单；
- `total_groups`：全树资产组总数。

**错误处理：**

| 场景 | 返回 |
| --- | --- |
| `group_name` 与 `group_id` 均未提供 | `{ok:false, error:{type:"invalid_params"}}` |
| 资产组未命中 | `matched=false`，`error.type=group_not_found`，附 `available_groups` 全量清单（id/name/parent_id）供智能体自纠错重试 |
| 上游 XDR 调用失败 | 透传 `run_xdr_action` 的结构化错误（`auth_error`/`http_error`/`business_error` 等） |
| 资产组树为空 | `error.type=empty_data` |

调用链路复用 10.2 的统一入口（签名、超时、重试、审计日志一致），工具沙箱由
`tool_runner` 注入宿主函数。真实环境验证：
`query_xdr_asset_group(group_name="深圳市政数局资产")` 命中 id=4，返回 84 个二级资产组
ID（5~114）与完整层级路径，全树 89 个资产组。

### 10.7 资产组告警统计专用工具：query_xdr_alert_stats

针对"某资产组今日/某时间段内各等级告警数量"的高频场景，在原子动作工具之外封装了
组合工具 `query_xdr_alert_stats`（定义位于 `backend/app/core/tools/definitions/xdr.py`，
实现位于 `backend/app/tools/xdr_action_tools.py::query_xdr_alert_stats`）。
它一步完成与 XDR 平台告警页资产组筛选一致的统计：

1. 调用「资产组列表查询」展开目标资产组为「自身 ID + 全部下挂子资产组 ID」；
2. 调用「告警趋势统计」（`/api/xdr/v1/alerts/trends`，`aggBy=["severity"]`、
   `filterParam.hostBranchIds=<全部ID>`、`interval="1d"`）按等级分桶统计；
3. 对各时间桶按等级求和，返回与平台口径一致的结果。

**参数定义：**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `group_name` | String | 二选一 | 目标资产组名称（如 `深圳市政数局资产`），先精确后包含匹配 |
| `group_id` | Number | 二选一 | 目标资产组 ID；与 `group_name` 同时提供时按 ID 优先 |
| `time_field` | String | 否 | 统计口径：`lastTime`=当日活跃告警（默认，与平台告警页一致）；`firstTime`=当日新增告警 |
| `start_timestamp` | String | 否 | 开始时间：秒级时间戳或北京时间字符串（如 `2026-11-12 00:00:00`）；缺省为今日 00:00:00 |
| `end_timestamp` | String | 否 | 结束时间：秒级时间戳或北京时间字符串（日期自动取 23:59:59）；缺省为今日 23:59:59 |
| `include_descendants` | Boolean | 否 | 是否把全部下级资产组并入统计（默认 `true`，与平台资产组树筛选一致） |
| `device_id` | Number | 否 | 目标 XDR 设备 ID；仅一台已启用 XDR 设备时可省略 |

**返回值结构（命中时）：**

```json
{
  "ok": true,
  "matched": true,
  "group": { "id": 4, "name": "深圳市政数局资产", "path": "深圳市政数局资产" },
  "time_field": "lastTime",
  "time_field_meaning": "lastTime=当日活跃告警（平台告警页默认口径）",
  "time_range": { "start_timestamp": 1794412800, "end_timestamp": 1794499199,
                  "start": "2026-11-12 00:00:00", "end": "2026-11-12 23:59:59" },
  "group_scope": { "include_descendants": true, "branch_id_count": 84, "descendant_group_count": 83 },
  "total": 413,
  "by_severity": [ { "level": 70, "name": "严重", "count": 179 },
                   { "level": 50, "name": "高危", "count": 155 },
                   { "level": 30, "name": "中危", "count": 79 } ]
}
```

- 告警等级映射（实测）：`70`=严重、`50`=高危、`30`=中危；未知等级保留数字并按数值降序排列；
- `group_scope.branch_id_count`：实际参与过滤的资产组 ID 数（目标组 + 全部后代）。

**错误处理：** 与 `query_xdr_asset_group` 一致（`invalid_params` / `group_not_found` 附
`available_groups` / 透传上游结构化错误）。时间范围缺省按北京时间今日全天。

真实环境验证（2026-11-12）：`query_xdr_alert_stats(group_name="深圳市政数局资产")`
返回 total=413（严重 179 / 高危 155 / 中危 79），与平台告警页"今日 + 资产组筛选"
口径一致（当日 385~413 区间随时间小幅增长），彻底消除此前直调 trends +
`platformHostBranchIds` 造成的"查出 4 万多条"错误。
