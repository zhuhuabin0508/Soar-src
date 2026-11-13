# 角色权限体系补齐 Spec

## 1. 背景与审计结论

当前权限体系由三部分组成：

- 后端权限矩阵定义：[permissions.py](file:///d:/trae%20project/soar-src/backend/app/core/permissions.py) 中的 `PERMISSION_MODULES`
- 后端接口校验：`require_permission("<module>", "<action>")`
- 前端角色管理矩阵：[RoleManagement.jsx](file:///d:/trae%20project/soar-src/frontend/src/pages/RoleManagement.jsx)

审计发现两类缺口。

### A. 前端矩阵缺失（有权限点，但页面看不到/勾不了）

| 缺失项 | 现状 | 影响 |
| --- | --- | --- |
| `ip_library`（IP地址库） | 后端已定义 `view/edit`，但未加入 `MODULE_GROUPS` | 角色管理页面无该行，无法授权 |
| `alert_rule`（告警规则） | 后端已定义 `view/edit`，但未加入 `MODULE_GROUPS` | 角色管理页面无该行，无法授权 |
| `alert.handle`（处置） | 后端已定义，前端 `ALL_ACTIONS` 无 `handle` | 表头无“处置”列，无法勾选 |
| `ticket.pause`（暂停/恢复） | 后端已定义，前端 `ALL_ACTIONS` 无 `pause`，后端 `ACTION_LABELS` 也无该动作 | 无法勾选且无中文标签 |
| `ban_workflow` 分组 | 侧栏在“运营中心 → 触发规则”，矩阵在“智能体编排” | 分组与目录不一致 |

> `resolveModuleGroups` 只会自动补 `asset_*` / `govcloud`，不会补 `ip_library` 和 `alert_rule`，因此这两项确实完全不渲染。

### B. 后端权限开关未生效（有开关，但接口不校验）

| 文件/模块 | 现状 | 结果 |
| --- | --- | --- |
| [knowledge_base.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/knowledge_base.py) | 全部接口只有 `get_current_user` | `knowledge_base` 的 view/edit/delete 均不生效 |
| [agents.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/agents.py) | 智能体增删改查、模板等只有 `get_current_user` | `agent` 的 view/edit/delete 不生效（仅对话执行用了 `execute`） |
| [asset_templates.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/asset_templates.py) | 读取接口无鉴权；写入用 `require_role("admin","analyst")` | `asset_templates` 权限点完全不生效，且存在未登录读取风险 |
| [feedback.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/feedback.py) | 只有 `get_current_user` | `feedback` 权限不生效 |
| [system_monitor.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/system_monitor.py) | `/health`、`/performance`、`/services` 仅登录；审计日志接口正确用 `audit_log` | `system_monitor:view` 不生效 |
| [devices.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/devices.py) | 多数仅登录，导出仅 admin | `device` 权限不生效 |
| [log_receivers.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/log_receivers.py) | 读接口仅登录，写接口 `require_role("admin")` | `device` 权限不生效 |
| [tools.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/tools.py) | `/block_ip` 用 `require_role("admin","analyst")`，查询接口无 `tool` 校验 | `tool` 权限部分不生效 |
| [banned_ips.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/banned_ips.py) | 全部 `require_role("admin")` | `ban_workflow` 权限无法用于黑名单管理 |
| [alerts.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/alerts.py#L389) | `POST /alerts/export` 使用 `alert:view` | 已定义的 `alert:export` 是死开关 |

### C. 明确不改（避免误伤）

- `chat` 保留为前端菜单/路由级权限，对话接口继续使用 `agent:execute`，避免双重校验导致存量角色无法对话。
- 备份恢复、关于页继续复用 `system_config`。
- 数据血缘、接收器、数据源条目继续复用 `device`。
- 资源级 owner / 共享逻辑（`can_edit`、`resource_shares`）不变。
- 用户、角色、工单、值班、技能、工作流等已正确校验的模块不动。

---

## 2. 目标

1. 角色管理页面的权限矩阵完整覆盖 `PERMISSION_MODULES`，每个已定义动作都有可勾选列。
2. 矩阵中的权限开关在对应后端接口真实生效：无权限返回 403，而不是仅前端隐藏。
3. 不破坏 admin / analyst / viewer 现有默认角色能力。

---

## 3. 详细改动

### 3.1 前端：补全权限矩阵

文件：[RoleManagement.jsx](file:///d:/trae%20project/soar-src/frontend/src/pages/RoleManagement.jsx)

1. `MODULE_GROUPS.resources.modules`
   - 在 `asset_discovery` 之后加入 `ip_library`。
2. `MODULE_GROUPS.config.modules`
   - 在 `alert` 之后加入 `alert_rule`。
3. `MODULE_GROUPS.workspace.modules`
   - 将 `ban_workflow` 从 `orchestration` 移到 `workspace`，顺序置于 `approval` 之后。
4. `ALL_ACTIONS`
   - 改为 `['view', 'edit', 'delete', 'execute', 'approve', 'export', 'handle', 'pause']`。
5. `LOCAL_MODULE_FALLBACK` / `LOCAL_MODULE_LABELS`
   - 保留现有兜底；无需新增，因为 `ip_library`、`alert_rule` 会从 `/roles/modules` 正常返回。

### 3.2 后端：补动作中文标签与迁移

文件：[permissions.py](file:///d:/trae%20project/soar-src/backend/app/core/permissions.py)

1. `ACTION_LABELS` 增加：
   ```python
   "pause": "暂停/恢复",
   ```
2. 默认角色授权：
   - `DEFAULT_ROLES` 中 `analyst` 的 `alert` 增加 `export`，`viewer` 的 `alert` 增加 `export`，保持升级前的导出能力。
   - 不在 `migrate_permissions` 中按 `view` 自动补 `export`：该函数会在每次请求时对角色矩阵生效，自动补权会让 `alert:export` 开关永远失效。
   - 存量自定义角色如需导出，由管理员在角色管理中显式勾选。

### 3.3 后端：接口权限校验补齐

统一原则：

- 读取类接口 → `<module>:view`
- 新增/修改类接口 → `<module>:edit`
- 删除类接口 → `<module>:delete`
- 执行类接口 → `<module>:execute`
- 原 `require_role(...)` 改为对应权限矩阵校验

逐文件改动：

1. [knowledge_base.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/knowledge_base.py)
   - `APIRouter(dependencies=...)` 改为 `require_permission("knowledge_base", "view")`。
   - 所有 POST/PUT/PATCH 接口追加 `knowledge_base:edit`。
   - 所有 DELETE 接口追加 `knowledge_base:delete`。
2. [agents.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/agents.py)
   - `GET ""`、`GET /templates`、详情/监控类 → `agent:view`。
   - `POST` 创建、`POST /from-dsl`、`PUT /{agent_id}` → `agent:edit`。
   - `DELETE /{agent_id}` → `agent:delete`。
   - 对话相关接口保持 `agent:execute` 不变。
3. [asset_templates.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/asset_templates.py)
   - `GET ""`、`GET /{code}`、`GET /export` → `asset_templates:view`（同时修复未登录可读）。
   - `POST ""`、`POST /import`、`PUT /{code}` → `asset_templates:edit`。
   - `DELETE /{code}` → `asset_templates:delete`。
   - 移除 `require_role("admin", "analyst")`。
4. [feedback.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/feedback.py)
   - 读接口 → `feedback:view`；写接口 → `feedback:edit`；删除 → `feedback:delete`。
   - 注意：`/feedbacks/mine` 属于“我的反馈”，所有登录用户可用，不套 `feedback` 权限；仅 `/feedbacks/admin` 管理接口套权限。
5. [system_monitor.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/system_monitor.py)
   - `/health`、`/performance`、`/services` → `system_monitor:view`。
   - `/audit-logs`、`/audit-logs/export`、`/services/{name}/logs` 保持 `audit_log:view`。
6. [devices.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/devices.py)
   - 读取、模板、明细、调用日志 → `device:view`。
   - 新增/修改/删除、设备动作 → `device:edit`。
   - `GET /export` 移除 `require_role("admin")`，改用 `device:view`。
7. [log_receivers.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/log_receivers.py)
   - 读取、统计、条目 → `device:view`。
   - PUT/POST/DELETE → `device:edit`。
   - 移除 `require_role("admin")`。
8. [tools.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/tools.py)
   - `/block_ip` → `tool:execute`。
   - 其他查询接口 → `tool:view`。
9. [banned_ips.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/banned_ips.py)
   - 读接口 → `ban_workflow:view`。
   - 新增/同步/删除 → `ban_workflow:edit` / `ban_workflow:delete`。
   - 移除 `require_role("admin")`。
10. [alerts.py](file:///d:/trae%20project/soar-src/backend/app/api/v1/alerts.py#L389)
    - `POST /alerts/export` 权限从 `alert:view` 改为 `alert:export`。

### 3.4 测试补充

新增/扩展 `backend/tests/test_permissions.py`（若不存在则新建）：

- viewer 访问 `GET /api/v1/knowledge-bases` → 403。
- viewer 访问 `GET /api/v1/asset-templates` → 403。
- viewer 访问 `GET /api/v1/system-monitor/health` → 403。
- 仅 `agent:view` 的角色 `POST /api/v1/agents` → 403；补 `agent:edit` 后 → 成功。
- 仅 `alert:view` 的角色 `POST /api/v1/alerts/export` → 403；补 `alert:export` 后 → 成功。
- `migrate_permissions` 对旧角色 `alert:["view"]` 不自动补 `export`，保证开关独立生效；内置 analyst/viewer 默认角色已包含 `export`。

前端验证：

- 角色管理矩阵出现“IP地址库”“告警规则”两行。
- 表头出现“处置”“暂停/恢复”两列，且对应模块可勾选。
- 保存后刷新，勾选状态保持。

### 3.5 验证命令

```bash
# 后端
cd backend && pytest tests -q

# 前端
cd frontend && npm test -- --run && npm run build
```

---

## 4. 验收标准

1. 角色管理页面模块行数 = `PERMISSION_MODULES` 模块数，无遗漏。
2. 所有已定义动作均有可勾选列（含 `handle`、`pause`）。
3. 抽查 knowledge_base、agent、asset_templates、device、feedback、system_monitor、tool、ban_workflow、alert 九个模块：无对应权限时后端返回 403。
4. admin 全权限、analyst / viewer 默认角色功能不回退。
5. 前后端测试与构建全部通过。

---

## 5. 风险与兼容

- 收紧校验后，存量自定义角色可能因缺少模块权限出现 403。`alert:export` 不做运行时自动补权（否则开关失效），内置 analyst/viewer 已在默认角色中包含导出；存量自定义角色需管理员在角色管理中显式授权。
- `asset_templates` 读取从“无鉴权”变为“需 `asset_templates:view`”，未登录访问会被拒绝，这是预期修复。
- 建议上线前用 admin 账号检查各角色权限，重点确认 analyst 是否仍可管理知识库、设备、工具。

## 6. 待批准

本 Spec 仅覆盖“补齐开关 + 让开关生效”，不包含权限矩阵页面视觉改版。确认后按 `tasks.md` 执行。
