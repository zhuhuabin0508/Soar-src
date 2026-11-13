# 角色权限补齐 Tasks

> 关联 Spec：`.trae/specs/role-permissions/spec.md`
> 执行前置：Spec 已获用户批准。

## 阶段一：前端矩阵可见性（P0）

- [x] 1. 修改 `frontend/src/pages/RoleManagement.jsx`
  - `MODULE_GROUPS.resources.modules` 加入 `ip_library`
  - `MODULE_GROUPS.config.modules` 加入 `alert_rule`
  - `MODULE_GROUPS.workspace.modules` 移入 `ban_workflow`
  - `ALL_ACTIONS` 增加 `handle`、`pause`
  - 验证：矩阵出现 IP地址库、告警规则；表头出现处置、暂停/恢复

## 阶段二：后端权限定义与迁移（P0）

- [x] 2. 修改 `backend/app/core/permissions.py`
  - `ACTION_LABELS` 增加 `"pause": "暂停/恢复"`
  - `DEFAULT_ROLES` 中 analyst/viewer 的 alert 增加 `export`；不做运行时自动补权
  - 验证：`pytest` 中断言 export 不被 view 自动授予

## 阶段三：后端接口权限校验（P1）

- [x] 3. `backend/app/api/v1/knowledge_base.py`
  - 读 → `knowledge_base:view`；写 → `edit`；删 → `delete`（`/search`、`/file-query` 按只读用 view）
- [x] 4. `backend/app/api/v1/agents.py`
  - 读/模板/监控 → `agent:view`；创建/更新 → `agent:edit`；删除 → `agent:delete`；测试执行 → `agent:execute`
  - 对话接口保持 `agent:execute`
- [x] 5. `backend/app/api/v1/asset_templates.py`
  - 读/导出 → `asset_templates:view`；写/导入 → `edit`；删除 → `delete`
  - 移除 `require_role("admin","analyst")`
- [x] 6. `backend/app/api/v1/feedback.py`
  - 仅管理端接口套 `feedback:view/edit/delete`
  - `/feedbacks/mine` 等提交人接口保持登录即可
- [x] 7. `backend/app/api/v1/system_monitor.py`
  - `/health`、`/performance`、`/services` → `system_monitor:view`
  - 审计接口保持 `audit_log:view`
- [x] 8. `backend/app/api/v1/devices.py` 与 `backend/app/api/v1/log_receivers.py`
  - 读 → `device:view`；写 → `device:edit`
  - 移除 `require_role("admin")`
- [x] 9. `backend/app/api/v1/tools.py` 与 `backend/app/api/v1/banned_ips.py`
  - `tools`：查询 → `tool:view`；`/block_ip` → `tool:execute`
  - `banned_ips`：读 → `ban_workflow:view`；写 → `edit`；删 → `delete`
  - 移除 `require_role("admin")`
- [x] 10. `backend/app/api/v1/alerts.py`
  - `POST /alerts/export` 改为 `alert:export`

## 阶段四：验证与回归（P1）

- [x] 11. 新增 `backend/tests/test_permissions.py`
  - 覆盖 require_permission 的 403/200、handle/pause 定义、alert export 独立性
- [x] 12. 运行 `cd backend && pytest tests -q`
  - 权限相关 6 项、会话 12 项、资产模板 87 项全部通过；全量套件其余失败为环境依赖问题（Postgres/Redis/langchain/bcrypt 缺失），与本次改动无关
- [x] 13. 运行 `cd frontend && npm run test:chat && npm run build`
  - 49 项单测通过，生产构建通过
- [x] 14. 回归验证
  - 自动化覆盖：权限矩阵动作/模块定义、403 拦截、alert export 独立性
  - 受环境限制（本地无 Postgres），未执行多角色登录的浏览器手工回归；部署后按验收标准抽查 admin/analyst/viewer

## 完成定义

- 矩阵模块数与 `PERMISSION_MODULES` 一致
- 九个重点模块权限从“前端隐藏”升级为“后端 403”
- 前后端测试与构建通过
