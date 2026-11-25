# feat/modular-decoupling 分支交接：工具契约 + 统一 Agent 与权限

> **用途**：只讲本分支的两套方案（**工具契约**、**统一 Agent + 工具级权限**）和**分支进度**，便于他人接手合并与验收。  
> **分支**：`origin/feat/modular-decoupling` @ **`3004a9e`**（2026-10-23，**未合并 `main`**）。  
> **对账**：当前 `main` @ `31ccf4b`（2026-11-23）**不包含**本分支代码；`main` 相对分支约多 **154** 提交，分支相对 `main` 约多 **72** 提交。  
> **来源**：分支内 `docs/architecture/模块化阶段-进度总览.md`、`待外部评审-通用Agent与工具级权限.md`、本地 [`模块化阶段-契约定稿与执行单.md`](./architecture/模块化阶段-契约定稿与执行单.md)。  
> **生成日期**：2026-11-24。

---

## 一、分支在做什么（一句话）

工具怎么管：**白名单 + 用户权限 + 网关兜底**。三层的规则都写在 **工具契约**（`ToolDescriptor`）上，装配和执行只读契约，不各模块各写一套。

落地形态：`ToolRegistryBuilder` 唯一装配、`DeviceGateway` / `invoke_tool` 唯一执行缝；统一对话是只挂查询工具的普通 Agent。**阶段 1 代码约 95%，未上线。**

---

## 二、工具方案：白名单 + 用户权限 + 网关兜底

三层串起来，少一层都会假通过。对话弹窗**不是**第三层；弹窗只给人确认并签发凭证，**真正能不能执行由网关读契约裁定**。

```text
① 白名单（场景能力，人工维护）
      Agent.enabled_tools / enabled_devices / enabled_kbs / enabled_workflows
      → 这个场景准备哪些工具（还不看当前登录人）

② 用户权限（角色 RBAC）
      对照契约字段 required_permission 与 Role.permissions
      → 没职权的工具从列表拿掉，LLM 看不见也调不了

③ 网关兜底（最终强制校验）
      call_gateway 自己读契约 danger_level / required_permission
      → 高危须一次性凭证；critical 对话路径直接拒绝；不信前端传的风险标记
```

交给智能体推理的列表 = **① ∩ ②**，再去掉契约上标成 **`critical`** 的工具。

| 层 | 谁维护 | 管什么 | 不管什么 |
|----|--------|--------|----------|
| **① 白名单** | 配 Agent 时勾选 | 这个场景能装哪些工具 | 不看用户是谁 |
| **② 用户权限** | 角色管理页勾模块动作 | 这个人能不能用白名单里的某把工具 | 不发执行许可 |
| **③ 网关** | 引擎 + 契约字段 | 这次调用允不允许执行 | 不替代 ①② 筛名单 |

**对话确认**挂在 ② 和 ③ 之间：有职权且 `danger_level=high` 时弹窗 → 生成 **15 分钟一次性凭证**（绑定工具名、参数哈希、当前用户）→ 网关核销后才执行。确认不能单独当授权；关掉某个 Agent 的确认开关也不能让 `high` 跳过网关。

### 2.1 契约层要怎么处理

权限和风险**不写死在引擎里**，写在每个工具注册时产出的 **`ToolDescriptor`** 上。新模块只改自己的注册处，补两个字段即可。

| 契约字段 | 给哪一层用 | 怎么填 |
|----------|------------|--------|
| （无单独白名单列） | **① 白名单** | 不写在描述符上。Builder 按 Agent 的 `enabled_*` **订阅**已注册工具；没订阅的根本不进本 Agent 的注册表 |
| **`required_permission`** | **② 用户权限** | `(module, action)`，与 `PERMISSION_MODULES` 一致。空则框架工具免检；非空则装配裁一次、执行再验一次 |
| **`danger_level`** | **③ 网关** | `low` / `medium` / `high` / `critical`。网关**重读**此字段，不信调用方自称的等级 |

**装配时（给 LLM 之前）**

1. `ToolRegistryBuilder.build(agent)` 只按白名单产出描述符（**不看人**）。
2. 遍历描述符：用当前用户矩阵核对 `required_permission`，不满足则丢掉；`admin` 跳过这一步。
3. `danger_level=critical` 的工具不进对话列表。
4. 剩下的 `bind_tools`。

**执行时（模型已经发起 tool_call）**

1. 网关再读同一份契约，再验 `required_permission`（防漏挂、伪造工具名）。
2. `low` / `medium`：有权限即可执行并审计。
3. `high`：必须带有效凭证（对话确认签发），核对工具名 + 参数哈希 + 用户 + 未过期，**核销一次性**后才执行。
4. `critical`：对话入口拒绝。工作流不传登录用户时按系统主体：不要求凭证、不拦 critical，仍写审计。

**模块注册时建议声明**

| 工具类 | `required_permission` | `danger_level` |
|--------|----------------------|----------------|
| 设备读 | `device:view` | `low` |
| 设备写 / `block_ip` / 投影写动作 | `device:edit` | `high` |
| 工作流当工具 | `workflow_list:execute` + 图内节点权限并集 | 按图取最高 |
| 知识库 | `knowledge_base:view` | `low` |
| 资产查询 | `asset_list:view` | `low` |
| DB 预置/自建 | 默认 `tool:execute`；封禁类改 `device:edit` | 按工具 |
| `clarify` / `delegate_task` | 空 | — |

非框架工具缺 `required_permission`、或模块名不在权限矩阵里，契约测试应失败。漏标会在注册时被发现，而不是上线后漏拦。

**契约上其它治理字段**（并行、证据链、tool_search）仍从描述符派生，与三层权限正交：`mutating`、`parallel_safe`、`deferrable`、`verification`。

### 2.2 白名单对应哪些字段

| 工具类 | 注册来源 | Agent 白名单 |
|--------|----------|----------------|
| DB 工具 | `tools` 表 | `enabled_tools` |
| 知识库 | 动态 | `enabled_kbs` |
| 资产 | `search_assets` 等 | `enabled_tools` / 资产类型 |
| 设备投影 | `_register_device_tools` | `enabled_devices` |
| 工作流包装 | `workflow_{id}_{name}` | `enabled_workflows` |
| 框架 | executor 注入 | 部分需显式启用 |

工作流 / 管理 API（`agent=None`）不按 Agent 白名单过滤，走系统主体 + 网关策略。

---

## 三、统一对话（同一套三层，入口更窄）

不做「挂全部工具的通用壳」。统一对话是普通 Agent，三层规则不变，只是 **① 白名单更窄**。

早期 `is_general=true` 会忽略白名单、靠本人点确认封禁——**已否决**。确认不是授权。

| 项 | 规则 |
|----|------|
| 种子 | 「统一对话」（`variables.platform_entry`） |
| ① 白名单 | 只查询：`check_whitelist`、`get_asset_info`、`get_threat_intel`、`check_subnet`、`query_banned_ip`；**不勾设备** |
| ② 用户权限 | 再按角色裁；分析员无 `device:edit` 时，即使打开处置 Agent 也看不到封禁 |
| ③ 网关 | 同 §2；统一入口因白名单无写工具，admin 在此入口也封不了 |
| 封禁 | 在勾了设备的**处置 Agent** 上；角色要有 `device:edit`；`high` 确认 + 网关核销 |
| UI | 侧栏「统一对话」；Agent 编辑页勾白名单；角色页提示模块权限影响对话可见工具 |
| 工作流当工具 | 契约上 `workflow_list:execute` + 按图推导节点权限，防「包一层工作流」绕过 ② |

**边界**：工作台审批中心不处理 Agent 高危确认；工具测试 / 工作流节点不弹对话确认。

设备真正下发仍走 **`DeviceGateway`**（幂等、审计）；工具调用网关是 **`call_gateway`**（读契约、验权限、核销凭证）。两层都是兜底，不要旁路。

### 3.1 本方案在分支上的进度

| 项 | 状态 | 说明 |
|----|------|------|
| 契约埋点 `danger_level` + `required_permission` | ✅ | 阶段 1 提交 `1a5a070` 等 |
| 确认闸（对话内 Confirm/Reject） | ✅ | 阶段 6d；默认开启 |
| 装配期 + 执行期角色裁剪 + `call_gateway` | ✅ | 2026-10-20 随统一对话落地（§13.9 #1 已关闭） |
| 工作流权限按图推导（R-3） | ✅ | 2026-10-22 |
| **统一对话（C4-7）体验验收** | ⚠️ **待做** | 代码已落地 |
| 独立网关进程 / 审批中心第二人复核 | ⬜ **不做** | 本阶段边界 |

---

## 四、分支总进度表

> 摘自分支 `模块化阶段-进度总览.md` §二，与 `3004a9e` 对齐。

| 阶段 | 任务 | 状态 |
|------|------|------|
| 阶段 0 | Hermes 基座冻结 | ✅（与 `main` 分叉点前一致） |
| P0 | 证据链 + RegistryBuilder + 名单派生 | ✅ |
| P1 | framework 门控、search_assets 单轨、LLM 工厂下沉 | ✅ |
| P2 | DeviceGateway、设备投影、`enabled_devices`、`block_ip`、invoke_tool、工作流接 Gateway | ✅ |
| §十三 | 危险×场景 + 对话确认 + 纠偏（6d） | ✅ |
| **C4-7** | **统一对话 + 权限 + 调用网关** | ⚠️ 代码 ✅，**体验未验** |
| 下一阶段 | 资产组物理模块化试点 | ⬜ |

**测试基线（文档记录）**：全量约 **10 failed / 200 passed**（既有失败，合并时不要算进本次回归）。

**主要提交线索**：`f2f628f`（RegistryBuilder）、`9f3125f`（Gateway）、`526145d`（invoke_tool）、`1a5a070`（危险契约）、`16f3129`/`3b40493`（对话确认纠偏）、`cc772e9`（Mock 封禁退役等）、`3004a9e`（设备契约网关）。

---

## 五、验收清单（接手人优先做）

### 5.1 统一对话 + 权限（C4-7）

- [ ] 统一入口：**能查**（威胁情报/白名单等），**不能封**（即使 admin，入口白名单无设备写）。
- [ ] **analyst**（`device:view` 无 `edit`）：处置 Agent 上**看不到**封禁类工具。
- [ ] **有 `device:edit`** 的用户：可见 `high` 工具；确认后**仅执行一次**；改参数或过期凭证 → 网关拒绝。
- [ ] **`critical`**：不出现在对话工具列表；对话直调被拒绝。
- [ ] 工作流封禁节点：仍**直接执行**，不走对话确认。
- [ ] 侧栏种子「统一对话」：库表含 `agents.enabled_workflows` 等列，否则 `ensure_platform_agent` 失败。

### 5.2 契约与网关（合并前）

- [ ] 工单/工作台/手动封禁在分支上走 **DeviceGateway**（合并 `main` 时勿保留 `main` 的直连 `anbotong` 旁路）。
- [ ] §9.3 **现有智能体配置盘点**（`computer_use` / `schedule_cron` 需显式启用等）。
- [ ] 跑分支 pytest 基线（10 failed 不变差）。

### 5.3 与 `main` 合并注意

- 冲突高发：`action_executor`、`tickets`、封禁前端、`devices/`。
- 合并策略见 [`项目进度与任务规划.md`](./项目进度与任务规划.md) **P1**；原则：**网关与治理以分支为准，工单与大屏业务以 `main` 为准**。

---

## 六、代码与文档索引（分支内）

| 主题 | 路径（相对 `backend/app`） |
|------|---------------------------|
| 工具契约 | `core/tools/descriptor.py`、`registry_builder.py`、`governance_legacy.py` |
| 危险策略 | `core/tools/policy.py` |
| 调用网关 | `core/tools/call_gateway.py` |
| 设备缝 | `devices/gateway.py`、`devices/as_tool.py` |
| 工具入口 | `platform/tool_runtime.py` |
| Agent 门面 | `platform/agent_runtime.py` |
| 确认 / 工单 | `platform/approval.py`（对话确认与 `ApprovalTicket`） |
| 种子统一对话 | `core/seed.py`（`ensure_platform_agent`） |

| 文档（**在分支上更全**，`main` 本地可能缺） | 用途 |
|--------------------------------------------|------|
| `architecture/模块化阶段-进度总览.md` | **本交接的进度权威** |
| `architecture/待外部评审-通用Agent与工具级权限.md` | 问题背景 + 三道防线初稿 + 评审问题 |
| `architecture/分支修复与合并交接文档.md` | 合并步骤与冲突 |
| `architecture/模块化分支遗留问题清单.md` | 遗留项 |
| `architecture/模块化阶段-部署手册.md` | SQL、部署顺序 |

---

## 七、与架构定稿的关系

- 模块边界、设备暴露、不用 MCP：**仍以** [`architecture/soar架构方案.md`](./architecture/soar架构方案.md) 为准。
- 本分支交付的是架构 **阶段 1～2 的工具契约 + DeviceGateway + 对话权限闭环**，**不是**整仓按业务域拆包（资产拆分见进度总览 §14.2，**未开始**）。

---

## 八、变更记录

| 日期 | 说明 |
|------|------|
| 2026-11-24 | 初版：合并分支进度总览 §十三/§十四、通用 Agent 评审文档与契约定稿 |
| 2026-11-25 | 工具方案收成「白名单 + 用户权限 + 网关兜底」；契约层写清 `required_permission` / `danger_level` 的装配与执行用法 |