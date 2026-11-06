# 工单多 IP 安全上下文分层展示与交互设计方案

> 场景：安全告警处置工单（发起 + 详情页「安全上下文」Tab），`src_ip` / `dst_ip` 字段存在多值 IP（逗号/分号分隔，来自 XDR 聚合告警、端口扫描、DDoS 类事件可达数十上百个）。
> 目标：多 IP 风险信息（黑名单 / 资产归属 / 威胁情报）**完整保留**的前提下，默认视图只给结论级统计，展开后再逐 IP 查看与操作，并满足 >50 IP 的渲染性能要求。

---

## 1. 现状与问题

| 位置 | 现状 | 问题 |
|---|---|---|
| `backend/app/core/ticket_enrichment.py` `_extract_ip` | 多值 IP **只取第一个有效地址**研判 | 其余 IP 的资产/情报/黑名单风险完全丢失 |
| `frontend/src/pages/TicketDetail.jsx` `EnrichmentView` | 每个 IP 一张全字段大卡（资产双子卡 + 情报全量字段 + 智能体研判），依次纵向排列 | 10 个 IP 即 >6000px 页面；50 个 IP 不可用 |
| `frontend/src/pages/TicketDetail.jsx` `BanStatusView` | 进入 Tab 自动查全部 IP 封禁状态，**单次 >20 直接报错** | 多 IP 工单黑名单查询直接失败 |
| 工单列表接口 | `_ticket_list_item` 已 pop `enrichment_data` | 列表传输无问题，可沿用 |
| 发起耗时 | 资产发现为外部 HTTP（每 IP 一次）、情报已批量并发 | 200 个 IP 同步研判会拖死发起请求 |

## 2. 总体思路：三层结构

```
┌────────────────────────────────────────────────────────────────────┐
│ L1 统计头（默认折叠态，唯一默认可见层）                                │
│   IP 总数 + 三维风险标签统计 chips（点击 chip = 展开并按该维度过滤）      │
├────────────────────────────────────────────────────────────────────┤
│ L2 工具栏（展开后可见）                                               │
│   风险筛选 chips · 排序 · 全选/反选 · 全部展开/一键收起 · 导出详情      │
│   （选中 IP 后底部浮出批量操作条：查封禁 / 重新研判 / 导出所选）          │
├────────────────────────────────────────────────────────────────────┤
│ L3 IP 列表（按 源IP / 目的IP 分组；行 = 复选框 + IP + 风险徽标 + 展开箭头）│
│   展开详情：≤50 手风琴内联；>50 右侧抽屉（虚拟列表行高统一 44px）        │
└────────────────────────────────────────────────────────────────────┘
```

核心原则：
- **折叠态零成本阅读**：处理人不展开也能看到「共多少 IP、恶意几个、封禁几个、重要资产几个」；
- **数据完整 ≠ 全部平铺**：所有 IP 的核心风险字段（黑名单状态 / 资产归属 / 情报标签）逐行徽标 + 详情完整保留，只是收起为二级结构；
- **黑名单永远实时查、不落库**（设备侧状态随时间变化，落库即过期数据）。

---

## 3. 安全上下文数据结构（enrichment_data v2）

### 3.1 Schema

```jsonc
{
  "version": 2,
  "roles": [
    {
      "role": "src_ip",                  // src_ip / dst_ip
      "label": "源IP地址",
      "ips": [
        {
          "ip": "10.144.1.2",
          "detail": "full",              // full / lite（见 3.3 分级）
          "asset": { ...同 v1 结构（matched/source/discovery/inventory/source_label）... },
          "threat": { ...get_threat_intel 原样，lite 时仅保留精简键... },
          "agent": { ...同 v1：pending 占位 / 研判结果 / null... }
        }
      ]
    }
  ],
  "stats": {                             // 发起时一次性算好，折叠头直接读
    "total": 86, "src": 52, "dst": 34,    // 去重合并后的独立 IP 总数
    "malicious": 6,                       // 情报判定恶意
    "severity_high": 4,                   // 情报严重程度 = high/critical
    "asset_matched": 23, "asset_critical": 5,  // 资产命中数 / 其中重要性=高、严重
    "intel_failed": 2, "asset_failed": 0,      // 各维度查询失败数
    "pending": false                      // >20 IP 走后台研判时为 true，完成后回写
  },
  "enriched_at": "2026-11-06T10:00:00",
  "errors": ["..."]
}
```

### 3.2 解析与去重规则（后端 `_extract_ips` 替换 `_extract_ip`）

- 复用 `frontend/src/utils/ipValidation.js` 同口径解析多值表达式：逗号/分号分隔、逐段 `ip_address` 校验，**单 IP 段参与研判**（CIDR/范围段记入 `errors` 提示「网段类条目不参与自动研判」，不阻塞）；
- **跨角色去重合并**：同一 IP 同时出现在源/目的时只保留一份研判结果，`stats.src/dst` 按各自出现次数统计，`stats.total` 为去重后数量（避免重复查询情报/资产、重复渲染）；
- **研判数量上限 `MAX_ENRICH_IPS = 200`**：超出截断，`errors` 记录「IP 共 320 个，仅研判前 200 个」，`stats.total_original = 320`。前端统计头显示截断提示。

### 3.3 存储分级：full / lite（解决 JSON 列体积）

按 IP 计算存储档位，**写入时即瘦身**，读取端零逻辑：

| 档位 | 判定（满足其一） | threat 保留 | asset 保留 |
|---|---|---|---|
| full | 情报恶意 / severity∈(high,critical) / 资产 importance∈(high,critical) / 前 10 个 IP | 全字段（同 v1） | 全字段（同 v1） |
| lite | 其余 | `is_malicious` / `confidence` / `severity` / `tags`（前 3 个）/ `geo_info`（country+city）/ `source` | `matched` / `source` / `source_label` / `asset_name` / `asset_ip` |

- 单条 lite ≈ 250B，200 IP 混合档 ≈ 60–100KB，可控；
- lite IP 详情区底部显示「精简研判结果」提示 + 行内「重新研判」按钮（单条升级为 full，见 §5.2）。

### 3.4 同步 / 后台研判切换（解决发起耗时）

| IP 数 | 策略 |
|---|---|
| ≤ 20 | 同步构建（现状行为，发起响应即带全量 enrichment） |
| > 20 | 发起时仅落 `stats.pending=true` 占位 + IP 清单；资产匹配（资产发现外部 HTTP，`ThreadPoolExecutor(max_workers=10)`）与情报（`Semaphore(20)` 限流）在线程池并发跑，完成后 `flag_modified` 回写——**复用现有 `_agent_bg_worker` 后台线程模式**；前端复用现有 `agent.pending` 轮询机制，统计头显示「自动研判中…」渐进计数 |

### 3.5 传递优化

- **列表接口**：维持现状（`_ticket_list_item` pop 掉 `enrichment_data`），零改动；
- **详情接口**：v2 已在写入时分级瘦身，详情原样返回即可，无需新增按需加载端点（一期）；
- **黑名单**：不落库、不进 enrichment，仅存在于前端会话内存（见 §5.1）；
- **可选二期**（IP 上限提到 500+ 时）：`GET /tickets/{id}/enrichment?ips=a,b,c` 子集端点，详情接口只回 stats + lite，full 详情按需拉取。

---

## 4. 分区间展示规则（<10 / 10–50 / >50）

三档共用 L1 统计头与 L2 工具栏，差异只在 L3 列表形态与详情容器。

| 维度 | <10 个 | 10–50 个 | >50 个 |
|---|---|---|---|
| 默认状态 | 折叠（仅统计头） | 折叠（仅统计头） | 折叠（仅统计头） |
| 列表布局 | 按角色分组的手风琴列表 | 同左；统计头 sticky（`sticky top-0`），分组折叠状态独立记忆 | 同左，但列表容器固定高 `max-h-[480px]` + 虚拟滚动 |
| 详情容器 | **手风琴内联展开**，允许全部展开 | 手风琴内联展开，**建议单开**（同时只展开一行，展开新行自动收起旧行；「全部展开」按钮可突破单开） | **右侧抽屉**（复用项目 Drawer 组件）：行高统一 44px 不被详情撑乱，虚拟滚动才能成立 |
| 虚拟滚动 | 不需要 | 不需要 | `@tanstack/react-virtual`（需新增依赖，React 19 兼容、~3KB），定高 44px 行，overscan 8 |
| 渲染细节 | 详情组件展开时才 mount | 同左（懒挂载）；行组件 `React.memo` + `useCallback` 稳定引用，避免整列表重渲染 | 同左；徽标纯 CSS（无图表无阴影动画） |
| 「全部展开」 | 可用 | 可用（展开后页面长，配合行内收起） | **禁用**（tooltip：「IP 较多，请点击单行在抽屉中查看详情」） |
| 分组折叠 | 源/目的分组默认展开 | 分组默认展开，组标题行带组内风险小计 | 分组默认**收起**（显示组名+数量+组内风险小计），点开后进入虚拟列表 |

> 判定阈值常量：`VIRTUAL_THRESHOLD = 50`（复用需求口径），阈值判断用**去重后 total**。

### 4.1 统计头（L1）设计

```
┌──────────────────────────────────────────────────────────────────────┐
│ 🛡 安全上下文（自动研判）                          研判时间：…  [展开 ▾] │
│ IP 共 86 个（源 52 · 目的 34）                                          │
│ [威胁情报] 恶意 6  高危 4  失败 2      ← 红/橙/灰 chips，可点击         │
│ [资产匹配] 命中 23  重要资产 5  未匹配 63  ← 主色/橙/灰 chips          │
│ [黑名单·实时] 封禁中 8  查询中 3/5 批     ← 查询完成后固化计数          │
│ （>200 截断时：⚠ IP 共 320 个，仅研判前 200 个）                        │
└──────────────────────────────────────────────────────────────────────┘
```

- chip 点击 = 展开列表 + 自动应用对应筛选（如「恶意 6」→ 展开并只看恶意 IP）——把统计头变成快捷下钻入口；
- 黑名单 chip 为实时查询进度：进入 Tab 自动分批查询，计数渐进递增。

### 4.2 IP 行设计（L3）

```
┌────────────────────────────────────────────────────────────────────┐
│ 源IP地址（52）  组内全选 ☑  ▾收起                                     │
│ ☐  10.144.1.2   [恶意][高危]  [封禁中]  [Web服务器·重要]        ▸详情 │
│ ☑  203.0.113.7  [非恶意]      [--]     [未匹配]                 ▸详情 │
└────────────────────────────────────────────────────────────────────┘
```

- 行高 44px；IP 等宽字体；复选框遵循项目规范：**仅点击复选框本身触发选中**，行点击 = 展开/打开抽屉；
- 徽标（全部 ≤ 22px 高、固定色系，参考现有 EnrichSourceView 配色）：
  - 情报：`恶意`（红）/ `高危`（橙）/ `非恶意`（绿，仅统计头+详情展示，行内非恶意省略以降噪）/ 失败（灰「查询失败」）
  - 黑名单：`封禁中`（红）/ `--`（未封禁，灰）；**未查询到**（该批次未覆盖时）不显示徽标
  - 资产：命中显示「资产名 · 重要性」，`criticality∈(high,critical)` 橙色；未匹配灰字
  - 智能体研判（开启时）：风险等级徽标（复用 `AGENT_RISK_CLS`）
- 行尾操作：`复制 IP`（图标按钮）、`重新研判`（lite/失败行显示）。

---

## 5. 交互逻辑

### 5.1 黑名单批量查询（分批自动 + 手动）

- **自动**：进入「安全上下文」Tab 自动查询全部研判 IP。设备端点约束单次 ≤20（`GET /tickets/ban-status`），前端按 **20/批分组、并发 2 批**串行推进，结果渐进渲染到行徽标与统计头计数；IP >200 时也仅查前 200；
- **失败处理**：某批失败 toast「第 N 批黑名单查询失败」，统计头黑名单区显示「重试失败批次」按钮，不影响其余批次；
- **会话缓存**：查询结果存 `Map<ip, status>`（组件级 state，随页面卸载丢弃），导出、筛选、重复进入 Tab 复用，避免重复请求；现有 `BanStatusView` 手动输入查询框保留（作为自定义 IP 查询兜底），查询结果合并进同一 Map。

### 5.2 批量操作（选中后底部浮出操作条）

```
┌──────────────────────────────────────────────────────┐
│ 已选 5 项  │ 查询封禁 │ 重新研判 │ 导出所选 │ 取消选择   │  ← fixed bottom 浮条
└──────────────────────────────────────────────────────┘
```

- **查询封禁**：选中 IP 自动按 20/批、并发 2 分批执行（同 §5.1），选中集 >20 时操作条提示「将分 N 批查询」；
- **重新研判**（新增后端端点）：`POST /tickets/{id}/enrichment/requery`，body `{ "ips": ["…"] }`，对选中 IP 重跑资产匹配 + 情报查询，`detail` 升级为 full 回写 `enrichment_data`（`flag_modified`，`deepcopy` 防 JSON 列值相等折叠——沿用 `_agent_bg_worker` 的坑位经验），`stats` 同步重算；写入审计 `ticket_enrichment_requery`；权限与工单详情一致（`ticket:view`，写 enrichment 需当前节点处理人/admin，复用 `_require_cc_manage_permission` 同型校验）；选中 >20 IP 时走后台线程 + 轮询（同 §3.4）；
- **导出所选**：见 §5.4。

### 5.3 全局操作

- **展开/收起（统计头按钮）**：控制 L1 ↔ L2/L3 整体切换，展开偏好持久化 `localStorage`（key：`ticket-enrich-expanded-v1`，沿用告警列表列配置的版本化惯例）；
- **全部展开**：仅 <50 场景可用；>50 禁用（§4 表）；
- **一键收起**：回到折叠统计头（等价统计头按钮，冗余入口放在工具栏右侧）；
- **风险筛选 chips**（工具栏）：`全部 / 仅恶意 / 黑名单命中 / 资产命中 / 高重要资产 / 未匹配 / 查询失败`，多选取交集按维度、单维内互斥；筛选作用于行渲染与「已选」计数，**虚拟列表筛选后仍 >50 继续窗口化**；
- **排序**：默认（字段原序）/ 风险优先（恶意 > 黑名单 > 高危情报 > 重要资产 > 未匹配，风险内按 IP 数值序）/ IP 升序。

### 5.4 导出详情

- 依赖现成 `xlsx@0.18.5`，前端生成 `.xlsx`（与流程模板导出同为纯前端 Blob 下载惯例，零后端改动）；
- 导出范围：全部或所选；导出前若选中 IP 存在「黑名单未查询」，弹 confirm「部分 IP 尚未查询黑名单状态，导出中该列为空，是否继续？」；
- 列：`角色 / IP / 黑名单状态（含剩余时长）/ 情报结论 / 置信度 / 严重程度 / 威胁标签 / 地理归属 / 资产名 / 资产来源 / 部门 / 负责人 / 重要性 / 智能体风险等级 / 研判档位`；
- 数值列右对齐、空值 `--`、文件名 `安全上下文-工单{ticket_no}-{时间}.xlsx`。

### 5.5 处理面板紧凑摘要适配

右侧处理面板顶部摘要（随流转每节点可见）从「逐 IP 徽标」改为统计口径一行：

```
IP 12 个：恶意 3 · 封禁中 2 · 重要资产 1 · 未匹配 6   [查看安全上下文 →]
```

点击跳转「安全上下文」Tab 并展开。多 IP 场景摘要不逐 IP 平铺，避免处理面板被撑长。

---

## 6. 组件选型与拆分

| 组件 | 选型 / 来源 | 说明 |
|---|---|---|
| 虚拟列表 | **新增依赖 `@tanstack/react-virtual`** | React 19 兼容、headless 无样式负担、定高行场景极简（`useVirtualizer` ~20 行接入）；备选 `react-window` 但其 v2 对 React 19 适配弱，不选 |
| 详情抽屉 | 项目现有 `Drawer`（`components/ui.jsx`，AlertDetailDrawer 同款） | >50 场景详情容器；≤50 场景用原生手风琴（无需新组件） |
| 复选框 / chips / toast / confirm / Badge | 现有组件体系 | 徽标沿用 `EnrichSourceView` 现有色系，视觉零跳变 |
| 状态管理 | 组件内 `useReducer`（选中 Set / 展开 Set / 过滤 / 排序 / 黑名单 Map） | 无跨页共享需求，不进 zustand，避免过度设计 |
| 导出 | `xlsx`（已有） | §5.4 |
| 图标 | `lucide-react`（已有） | ShieldCheck / AlertTriangle / ShieldBan / Download / Copy / RefreshCw / ChevronDown |

新建 `frontend/src/components/TicketEnrichment.jsx`，自 `TicketDetail.jsx` 迁出 `EnrichmentView` / `EnrichSourceView`（详情子卡原样复用）并重构为：

```
TicketEnrichment（容器：数据解析 / 轮询 / 分批黑名单 / 导出）
 ├─ EnrichStatsHeader     L1 统计头（chips 可点击下钻）
 ├─ EnrichToolbar         L2 工具栏（筛选 / 排序 / 全选 / 全部展开 / 导出）
 ├─ EnrichRoleGroup       分组容器（组标题 + 组内小计 + 组折叠）
 │   ├─ EnrichIpRow       行（44px，memo；<50 内联箭头 / >50 打开抽屉）
 │   └─ VirtualIpList     >50 定高虚拟窗口
 ├─ EnrichDetailDrawer    单 IP 详情抽屉（内部复用双子卡子组件）
 ├─ EnrichBatchBar        选中浮动批量条
 └─ BanQueryBox           手动黑名单查询框（迁自 BanStatusView）
```

---

## 7. 后端改动清单

| 文件 | 改动 |
|---|---|
| `backend/app/core/ticket_enrichment.py` | ① `_extract_ip` → `_extract_ips`（全量解析/去重合并/上限 200）；② `build_ticket_enrichment` 输出 v2（`roles[].ips[]` + `stats` + full/lite 分级 + `pending` 后台模式）；③ 资产发现 `ThreadPoolExecutor(10)`、情报 `Semaphore(20)`；④ `decorate_asset_source_labels` 兼容 v2 遍历 `roles[].ips[]`；⑤ 新增 `_requery_enrichment`（重查指定 IP 并重算 stats 回写） |
| `backend/app/api/v1/tickets.py` | ① 新增 `POST /tickets/{id}/enrichment/requery`（权限：当前节点处理分组或 admin；审计 `ticket_enrichment_requery`）；② `_ticket_detail` 序列化兼容 v1/v2（原样返回，无需结构转换） |
| 兼容性 | v1 结构（`sources[].ip` 单 IP）**不迁移**：前端检测 `version===2 ? v2 渲染 : 现有 EnrichSourceView 渲染**，存量工单零回归 |

## 8. 前端改动清单

| 文件 | 改动 |
|---|---|
| `frontend/package.json` | + `@tanstack/react-virtual` |
| `frontend/src/components/TicketEnrichment.jsx` | 新建（§6 结构），EnrichSourceView 双子卡、`AssetMatchFields`、`DiscoveryMatchFields`、`SourceLabel` 原样迁入复用 |
| `frontend/src/pages/TicketDetail.jsx` | ① 安全上下文 Tab 接入新组件；② `EnrichmentView`/`BanStatusView` 迁出；③ 处理面板紧凑摘要改统计口径（§5.5）；④ `agent.pending` 轮询扩展为 `pending || stats.pending` |
| `frontend/src/api/tickets.js` | + `requeryEnrichment(ticketId, ips)`；`banStatus` 不变（分批在前端） |
| `frontend/src/utils/ticketEnrichExport.js` | 新建导出工具（xlsx 组装，§5.4 列定义） |

实施顺序：后端 v2 + requery 端点 → 前端组件迁移与统计头/列表 → 分批黑名单 → 虚拟滚动 → 导出 → 紧凑摘要。每步可独立验证。

---

## 9. 性能与体验保障要点

- **渲染**：>50 虚拟窗口仅渲染可视区 ±8 行；行组件 memo；详情懒挂载；徽标纯 CSS 无重动画；
- **请求**：黑名单 20/批 × 并发 2、会话内缓存去重；重新研判 >20 转后台不阻塞浏览；
- **体积**：full/lite 分级控制 JSON 列 ≤100KB；列表接口不传 enrichment（现状）；
- **可读性**：折叠统计头一行给全量结论；行内非恶意/未封禁降噪省略（详情完整展示，信息不缺失，仅默认视图降噪）；
- **完整性保障**（对应需求 3）：黑名单（实时查询覆盖全部研判 IP）、资产归属（`source_label` + 资产名逐行保留）、情报标签（lite 档保留 top3 标签、详情/导出含全量）——三个维度逐 IP 均有落点，无一处因折叠丢字段。

## 10. 验证要点

- 构造多 IP 工单：容器内 Python 脚本 POST `/tickets`（src_ip 填 60 个逗号分隔 IP）→ 检查 `enrichment_data` v2 结构、stats 计数、full/lite 档位、JSON 体积；
- 浏览器验证：折叠默认态（仅统计头）→ 展开 → 筛选「恶意」→ 全选 → 批量查封禁（观察分批进度）→ 导出 xlsx → 一键收起；
- >50 虚拟滚动：60 IP 展开列表 `querySelectorAll` 计数应 ≈ 可视区行数而非 60；快速滚动无白屏；
- 兼容回归：旧单 IP 工单详情页安全上下文渲染不变（v1 分支）；
- 权限：1001（external）访问安全上下文 Tab、发起重新研判请求应被正确放行/拦截并 toast 提示。
