# main 分支待修改清单（交给 main 维护者）

> 分支：`origin/main` @ `26309c2`（本地 `main` 若停在 `8643ec8`，少这一笔，不能当合并基点）
> 对照分支：`feat/modular-decoupling`（设备契约、`DeviceGateway`、统一对话治理在这边）
> 日期：2026-10-23
> 功能分支已经改完自己能改的部分。本文只列 **main 上仍要改的问题**，以及 **合并时必须由 main 侧配合、不能整文件覆盖** 的点。

## 摘要

| 级别 | 数量 | 优先处理 |
|---|---|---|
| 🔴 Critical | 1 | `action_executor.py` 禁止整文件取 main 或取功能分支 |
| 🟠 High | 3 | `by_id` 直连执行器、门面工具危险等级、对话页冲突 |
| 🟡 Medium | 2 | 工具测试/OpenAPI 拉取、种子提示词双确认 |
| 🔵 Low | 1 | 合并基点写错 |

功能分支已完成、合并时不要改回去的部分见文末「功能分支已改」。

---

## 🔴 Critical

### 1. `action_executor.py` 两边都不是对方的超集

- **位置**：`backend/app/devices/action_executor.py`
- **问题**：main 有路径占位 `{param}`、`validate_outbound_url`、青藤登录失败前先写 `request_summary`，并删除了 `idempotency_key` / `correlation_id`。功能分支保留幂等字段，网关写 `DeviceCallLog` 会传这两个参数；功能分支也已经补上路径占位、出站校验和 `request_summary` 的赋值顺序。
- **影响**：整文件留下 main，网关调用 `record_device_call(..., idempotency_key=...)` 会报意外关键字，设备幂等失效。整文件留下旧的功能分支，青藤带 `{agentId}` 这类路径的接口会去请求字面量花括号。
- **修复**：按符号合并。幂等参数留功能分支；路径替换、出站校验、登录失败日志留两边里已经有的那份（现在两边都有，冲突时保留调用 `validate_outbound_url` 且仍接收 `idempotency_key` 的版本）。

```diff
--- a/backend/app/devices/action_executor.py
+++ b/backend/app/devices/action_executor.py
@@ def record_device_call
     error_message: Optional[str] = None,
+    idempotency_key: Optional[str] = None,
+    correlation_id: Optional[str] = None,
 ) -> None:
@@
             source_ip=source_ip,
+            idempotency_key=idempotency_key,
+            correlation_id=correlation_id,
@@ def execute_device_action
     skip_log: bool = False,
+    idempotency_key: Optional[str] = None,
+    correlation_id: Optional[str] = None,
 ) -> dict[str, Any]:
```

`record_device_call` / `execute_device_action` 里所有写日志的调用都要把这两个参数传下去。不要在解决冲突时删掉 `_build_request` 里的 `{param}` 替换和 `validate_outbound_url`。

---

## 🟠 High

### 2. `execute_device_action_by_id` 绕过设备网关，也没有按动作验权限

- **位置**：`origin/main` 的 `backend/app/devices/action_executor.py`（约 419 行起）；`backend/app/core/tool_runner.py` 约 732 行
- **问题**：main 的 `execute_device_action_by_id` 在线程里直接调用 `execute_device_action`。沙箱用 `functools.partial` 注入，工具代码仍可能用关键字盖掉 `user_id`。功能分支已经有同名函数：走 `DeviceGateway.invoke`，写动作才带幂等键，按 `DeviceAction` 的风险核对 `device:view` / `device:edit`，沙箱包装函数不接收调用方传入的 `agent_id`/`user_id`。
- **影响**：保留 main 这份函数，统一对话和「设备运营助手」都会绕过确认闸和设备调用日志上的幂等。
- **修复**：合并后删除 main 这份直连实现，保留功能分支的 `execute_device_action_by_id` 和 `tool_runner` 里的 `_execute_device_action_by_id` 包装。响应截断保持 30000 字符。`timeout` 要传给 `DeviceGateway.invoke`，不要丢。

```diff
--- a/backend/app/devices/action_executor.py
+++ b/backend/app/devices/action_executor.py
@@ async def execute_device_action_by_id 内部
-            result = execute_device_action(
-                device, action, params or {}, timeout,
-                db=db, source="agent", agent_id=agent_id, user_id=user_id,
-            )
+            result = await DeviceGateway.invoke(
+                db, device.id, action_id=action.id, params=params or {},
+                source="agent", agent_id=agent_id, user_id=user_id,
+                idempotency_key=key, timeout=timeout,
+            )
```

`key` 仅在 `is_write_action(action)` 时生成。动作归属校验（`device_id` 与 `action.device_id` 不一致则拒绝）保留。

同一文件之外，main 上这些调用在合并时不要盖回直连：

- `backend/app/api/v1/devices.py` 里设备测试
- `backend/app/api/v1/banned_ips.py` 里手动封禁
- `backend/app/core/node_executors.py` 里 `device_action` 节点

功能分支上述路径已经调用 `DeviceGateway.invoke`。`devices.py` 在两边重叠名单里，冲突时保留网关调用。

### 3. 不要把 `execute_device_action` 整把标成高危

- **位置**：`backend/app/core/tools/definitions/device_query.py` 的 `DEVICE_QUERY_TOOLS`；`backend/app/core/qingteng_wanxiang_actions.py`
- **问题**：青藤目录是 144 条，`risk_level` 全部 `readonly`，`category` 全部 `query`，其中 GET 130、POST 14。POST 不等于写。功能分支在真正执行 `execute_device_action` 前会按 `action_id` 读库：写动作 `danger_level=high` 且需要 `device:edit`，只读动作 `low` 且需要 `device:view`。投影工具 `device_{设备}_{动作}` 本来就是按条目标的。
- **影响**：如果在预设里把整个执行工具写成 `mutating=True`、`danger_level=high`，144 次只读查询都会进确认闸。如果用「参数里有 IP」去走封禁证据链，按 IP 查主机会被当成封禁。
- **修复**：预设里不要写死危险等级。查询工具声明查看权限即可。执行工具的危险等级留给运行时按动作覆盖。

```diff
--- a/backend/app/core/tools/definitions/device_query.py
+++ b/backend/app/core/tools/definitions/device_query.py
@@ query_device_actions 字典
         "is_preset": True,
         "tool_source": TOOL_SOURCE_DEVICE,
+        "required_permission": ("device", "view"),
+        "mutating": False,
+        "deferrable": False,
@@ execute_device_action 字典
         "is_preset": True,
         "tool_source": TOOL_SOURCE_DEVICE,
+        "required_permission": ("device", "view"),
+        "mutating": False,
+        "deferrable": False,
```

不要加 `"danger_level": "high"`。写动作的高危和 `device:edit` 由功能分支的 `policy_for_action_id` 在调用前覆盖。

### 4. 合并 `ChatPage.jsx` 时会丢掉确认弹窗或丢掉 main 的界面

- **位置**：`frontend/src/pages/ChatPage.jsx`、`frontend/src/pages/AgentWorkspace.jsx`、`frontend/src/pages/AgentList.jsx`
- **问题**：自共同祖先 `201c666` 起，两边都改过的路径有 23 个。`ChatPage.jsx` 相差约 435/504 行。功能分支有高危工具确认弹窗（`tool_confirm`）。main 的 `26309c2` 含工单、滑块验证码、登录页和大量界面改动，不只是青藤。
- **影响**：冲突时整文件选一边，要么没有确认出口，要么丢掉 main 的界面。没有弹窗时，高危写动作没有确认入口。
- **修复**：`ChatPage.jsx` 同时保留 main 的界面改动和功能分支的 `tool_confirm` 处理。下面这些重叠文件都要逐段看，不能 `checkout --ours/--theirs`：

`backend/app/api/v1/agents.py`、`devices.py`、`skills.py`、`tools_manage.py`、`backend/app/core/permissions.py`、`security.py`、`seed.py`、`tool_runner.py`、`backend/app/core/tools/definitions/builtin.py`、`framework.py`、`legacy.py`、`security.py`、`backend/app/devices/action_executor.py`、`backend/app/models/agent.py`、`device.py`、`backend/app/tasks/__init__.py`、`frontend/src/api/client.js`、`frontend/src/components/AgentDslPanel.jsx`、`frontend/src/pages/AgentEditor.jsx`、`AgentQuickCreate.jsx`、`AgentWorkspace.jsx`、`ChatPage.jsx`、`RoleManagement.jsx`。

`registry_builder.py`、`devices/gateway.py`、`devices/as_tool.py` 只在功能分支，不会和 main 冲突，直接保留。

---

## 🟡 Medium

### 5. 工具测试和 OpenAPI 拉取在 main 上仍只要求登录

- **位置**：`backend/app/api/v1/tools_manage.py` 的 `POST /{tool_id}/test`、`POST /import-openapi`
- **问题**：路由依赖目前只有 `get_current_user`。`import-openapi` 会按请求里的 `url` 让服务端去拉取。功能分支已经加上 `tool:edit`，并对拉取地址拒绝非 http(s)、云元数据、环回、链路本地和私网。`tools_manage.py` 在重叠名单里。
- **影响**：合并若留下 main 的这两个路由，任意登录用户仍可测试启用工具，并指定服务端请求的 URL。设备联调不要用这个测试按钮代替对话网关验收。
- **修复**：冲突时保留功能分支这两个端点的权限依赖和 `validate_public_fetch_url`。若 main 在同函数里还有别的改动，把那些改动接到带权限的版本上，不要删掉校验。

```diff
--- a/backend/app/api/v1/tools_manage.py
+++ b/backend/app/api/v1/tools_manage.py
@@
-@router.post("/{tool_id:int}/test")
+@router.post("/{tool_id:int}/test", dependencies=[Depends(require_permission("tool", "edit"))])
@@
-@router.post("/import-openapi")
+@router.post("/import-openapi", dependencies=[Depends(require_permission("tool", "edit"))])
 async def import_openapi(body: OpenAPIImportRequest) -> dict:
@@
     if not spec_text and body.url:
+        validate_public_fetch_url(body.url, field="OpenAPI URL")
         async with httpx.AsyncClient(timeout=15) as client:
```

设备 `api_url` 仍允许内网，那条规则在 `validate_outbound_url`，不要把设备出站改成拒绝私网。

### 6. 「设备运营助手」提示词和平台确认闸会各确认一次

- **位置**：`backend/scripts/seed_device_agent.py` 的 `_SYSTEM_PROMPT`
- **问题**：提示词要求处置类动作先调用 `clarify` 让用户确认。功能分支的对话确认闸对写动作会再建一张待确认单。青藤 144 条都是只读，这段提示词对它们几乎不会触发；一旦接上真正的写动作，用户会看到两次确认。
- **影响**：联调时分不清是提示词挡住了，还是网关挡住了。
- **修复**：只读动作参数齐全后直接执行。写动作不要再要求模型用 `clarify` 做一次确认，改成等待平台确认闸。

```diff
--- a/backend/scripts/seed_device_agent.py
+++ b/backend/scripts/seed_device_agent.py
@@
-- 用户要求的动作属于处置类或中高风险（risk_level 为 medium/high，如封禁 IP、隔离主机、删除数据、变更配置）：描述将执行的动作、目标与影响，请用户确认。
+- 只读动作（risk_level=readonly 或 category=query）参数齐全后直接调用 execute_device_action。
+- 写动作不要自己再用 clarify 做一次确认。调用后如果平台返回待确认，把工单信息告诉用户，等用户在对话里确认。
@@
-- 处置类动作必须在用户明确确认后才能执行；
+- 写动作由平台确认闸决定是否执行；
```

这个种子是更新已有行的（`_upsert_agent`）。改完要在目标库重跑一次脚本，否则旧提示词还在。

---

## 🔵 Low

### 7. 合并基点不要用落后的本地 main

- **位置**：执行合并的仓库
- **问题**：`origin/main` 是 `26309c2290afb4774b742cd6d60bae86e78993f3`。有的本地 `main` 还停在 `8643ec8`，少了青藤目录、设备种子和 `26309c2` 里的工单/登录改动。
- **修复**：合并前 `git fetch origin`，基点用 `origin/main`，不要用落后的本地 `main`。

---

## 功能分支已改（合并时不要退回）

这些不在 main 上改，列在这里是避免冲突解决时被覆盖：

- `validate_outbound_url`：设备出站只允许 http/https，拒绝云元数据，允许内网。`validate_public_fetch_url`：只用于用户提供的 OpenAPI URL。
- `_build_request` 替换 `{param}`，并把该键从后续 query/body 里去掉。
- 青藤登录失败时，`request_summary` 在使用前赋值。
- `execute_device_action_by_id` 走 `DeviceGateway`；读动作不设幂等键。
- `policy_for_action_id`：调用 `execute_device_action` 前按动作改危险等级和权限。只读不进确认闸，写动作要 `device:edit` 并走确认闸。
- 单台设备读动作超过 20 条时不逐条投影，核心写动作仍然投影。枚举工具 `list_device_actions` 和门面 `device_action` 还在。
- 统一对话的种子提示词不再写「不要调用封禁、设备写入」。已入库且提示词里仍有「不要调用封禁」的行，启动时只更新提示词、描述和问候，不改 `enabled_tools` / `enabled_devices`。设备白名单仍然是智能体编辑页的 `enabled_devices`，不是 144 个动作名。
- 角色页说明改在「智能体编排 → 工具」和「连接配置 → 设备对接」。系统管理组没有按单个工具授权，这次也不做。

验收用非管理员，在统一对话里测：只勾一台设备；只有 `device:view` 的人能查、不能写；有 `device:edit` 的人写动作要先确认，并且 `DeviceCallLog` 来自网关。不要用工具管理的测试按钮或工作流节点代替这次验收。
