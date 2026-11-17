# 工单安全分析研判智能体：代码审查问题修复 Spec

## 1. 目标与范围

修复「工单安全分析研判智能体」未提交代码审查确认的 11 项问题（P0/P1 优先），
不改变既有对外契约（3 字段 risk_level/action/reasons、5 要素前缀、前端卡片解析逻辑）
与生产默认行为（出站代理默认仍走宿主机 8999）。

不在范围：新增功能、UI 改版、提示词内容改写（prompt.py 不改）。

## 2. 现状与问题清单

| # | 等级 | 位置 | 问题 | 修复决策 |
|---|------|------|------|----------|
| 1 | major | backend/app/core/ticket_enrichment.py `_run_agent_analysis_for_ips` | 上下文采集失败后仍用空 ctx 研判，命中 no_hit_fallback → 回写「低/监控」伪结论 | 采集失败或单 IP 上下文缺失时**不调用 LLM**：结果置 None、写 errors、回写失败态 |
| 2 | major | backend/app/platform/agent_runtime.py `adapt_ticket_analyst` | 只校验 reasons 非空，不校验 5 模块前缀，前端卡片会错位/内容缺失 | 新增 `_validate_reason_modules`：按 `REASON_ELEMENTS` 校验前缀齐全且顺序正确，不满足抛 `AgentCallError` 触发重试 |
| 3 | medium | 同上 `_run_agent_analysis_for_ips` | gather_contexts 只读事务在 LLM 调用期间未释放，长时占用 DB 连接 | gather 结束后（成功与失败路径）调用 `_safe_rollback(session)` |
| 4 | medium | backend/app/core/ticket_analyst/ensure.py `_resolve_model_config_id` | 硬编码 `Agent.id == 1`，不同环境主键不同，可能取错模型或 None | 改为：`BAN_ANALYST_AGENT_ID` 绑定的模型 → `is_default` 且 enabled 的 chat 模型 → 首个 enabled chat 模型 → None |
| 5 | medium | ensure.py `resolve_ticket_analyst_agent` / client.py `_invoke_ticket_analyst` | 运行时每次 resolve 都可能创建同名智能体，并发下重复创建（Agent.name 无唯一约束） | `resolve_ticket_analyst_agent(db, create=True)` 增加开关；client 侧 `create=False` 只解析；创建路径加模块级 `threading.Lock` 并二次查名 |
| 6 | medium | ticket_enrichment.py `build_ticket_enrichment` | 同步路径 `agent_ips` 未过滤域名（entries 可含域名实体） | 补 `_is_entity_ip(e["ip"])`，与后台路径口径一致 |
| 7 | medium | ticket_enrichment.py `_submit_bg_task` / `start_agent_analysis_bg` | 同键任务在途时新提交被静默丢弃，requery 重置的 pending 永久卡住 | 同键在途时登记为后续任务（`_BG_FOLLOWUPS`），当前任务完成后串行执行；不丢任务 |
| 8 | medium | docker-compose.yml L73-75 | `${HTTP_PROXY-...}` 会优先取宿主机同名变量（如开发机/CI 常见），生产默认被意外覆盖 | compose 插值变量改用专用名 `OUTBOUND_HTTP_PROXY` / `OUTBOUND_HTTPS_PROXY` / `OUTBOUND_NO_PROXY`，容器内 env key 仍为 HTTP_PROXY/HTTPS_PROXY/NO_PROXY |
| 9 | low | ticket_enrichment.py `requery_ticket_enrichment` | 无目标 IP 提前返回缺 `agent_ips` 键；转后台返回同样缺失 | 两处返回补齐 `"agent_ips": []` |
| 10 | low | agent_runtime.py `adapt_ticket_analyst` | `[str(r).strip() ...]` 改写原始字符串，破坏「不得改写/截断」契约 | 改为 `[str(r) for r in reasons if str(r).strip()]`，保留原始格式 |
| 11 | low | .gitignore | `.trae-html-share-packages/` 未忽略 | 追加忽略规则 |

## 3. 精确改动方案

### 3.1 backend/app/core/ticket_enrichment.py

**a) `_submit_bg_task`（约 L97-114）**
- 新增模块级 `_BG_FOLLOWUPS: dict[str, list[tuple[callable, tuple]]] = {}`（复用 `_BG_TASKS_LOCK` 保护）。
- 同键任务在途时不再 return 丢弃：`_BG_FOLLOWUPS.setdefault(key, []).append((target, args))`。
- `_cleanup` 在锁内 pop 当前 future 后，若 `_BG_FOLLOWUPS[key]` 非空：取队首提交为新的 `_BG_TASKS[key]`，剩余留在 `_BG_FOLLOWUPS`，并给新 future 挂同一个 `_cleanup`。保证同键任务串行、任务零丢失。
- 返回值改为 bool（提交/排队成功 True），调用方无需改动。

**b) `_run_agent_analysis_for_ips`（约 L1647-1690）**
- `ips` 为空直接 return。
- `gather_contexts` 抛异常：`_safe_rollback(session)` → 记录 logger.exception →
  `_writeback_agent_results(session, ticket_id, {ip: None for ip in ips}, [f"智能体研判跳过：安全上下文采集失败（{len(ips)} 个 IP），请重新研判"])` → return。
  不再以空 ctx 调用 LLM。
- gather 成功后立即 `_safe_rollback(session)` 释放只读事务（问题 3）。
- 逐 IP 取 `ctx_map.get(ip)`：非 dict 的 IP 直接 `results[ip] = None` + errors（`"{ip} 智能体研判失败: 安全上下文缺失"`），不进入线程池。
- 其余逻辑不变（ThreadPoolExecutor(4) + as_completed + `_writeback_agent_results`）。
- 失败态沿用既有契约 `agent=None`（前端已按「未研判/失败」分支渲染，无需前端改动）。

**c) `build_ticket_enrichment` L1819**
```python
agent_ips = [
    e["ip"] for e in entries
    if isinstance(e.get("agent"), dict) and _is_entity_ip(e.get("ip") or "")
]
```

**d) `requery_ticket_enrichment`**
- L1923 提前返回：`{"updated": 0, "unknown": unknown, "pending": False, "agent_ips": []}`。
- 转后台返回（L1941）：补 `"agent_ips": []`（该路径由 `_requery_bg_worker` 内部链式重研判）。

### 3.2 backend/app/platform/agent_runtime.py

- 新增模块级函数：
```python
def _validate_reason_modules(reasons: list[str]) -> None:
    """校验 reasons 的 5 要素模块前缀齐全且顺序正确。"""
    from app.core.ticket_analyst.prompt import REASON_ELEMENTS
    text = "\n".join(reasons)
    cursor = 0
    missing: list[str] = []
    for prefix, _desc in REASON_ELEMENTS:
        idx = text.find(prefix, cursor)
        if idx < 0:
            missing.append(prefix)
            continue
        cursor = idx + len(prefix)
    if missing:
        raise AgentCallError(...)
```
  （`AgentCallError` 在函数内外层 import 与 `adapt_ticket_analyst` 保持一致的局部导入。）
- `adapt_ticket_analyst`：
  - reasons 过滤改为 `[str(r) for r in reasons if str(r).strip()]`（问题 10）。
  - 非空校验后调用 `_validate_reason_modules(reasons)`（问题 2）。
  - 返回结构与多余字段剥离逻辑不变。

### 3.3 backend/app/core/ticket_analyst/ensure.py

- 新增 `import threading` 与 `_CREATE_LOCK = threading.Lock()`。
- `resolve_ticket_analyst_agent(db: Session, create: bool = True)`：
  - `TICKET_ANALYST_AGENT_ID > 0` 精确命中 → 返回；
  - 名称命中 → 返回；
  - `create=False` → 返回 None；
  - 持锁二次查名（防并发重复创建），仍未命中才 `_create_managed_agent(db)`。
- `_resolve_model_config_id` 重写为三级兜底（`BAN_ANALYST_AGENT_ID` → default chat → 首个 enabled chat → None），删除 `Agent.id == 1`。
- `ensure_ticket_analyst_agent` 行为不变（`create` 默认 True）。

### 3.4 backend/app/core/ticket_analyst/client.py

- `_invoke_ticket_analyst` 中 `resolve_ticket_analyst_agent(db, create=False)`；
  未命中时沿用现有 `AgentCallError("未找到工单安全分析研判智能体…")`，提示由启动 ensure 创建。

### 3.5 docker-compose.yml（backend-dev）

```yaml
HTTP_PROXY: ${OUTBOUND_HTTP_PROXY-http://172.19.0.1:8999}
HTTPS_PROXY: ${OUTBOUND_HTTPS_PROXY-http://172.19.0.1:8999}
NO_PROXY: ${OUTBOUND_NO_PROXY-localhost,127.0.0.1,postgres,redis}
```
同步更新上方注释：说明专用变量名避免透传宿主机同名变量。

### 3.6 .env.dev（本地开发，gitignored）

将 `HTTP_PROXY=` / `HTTPS_PROXY=` / `NO_PROXY=...` 改为
`OUTBOUND_HTTP_PROXY=` / `OUTBOUND_HTTPS_PROXY=` / `OUTBOUND_NO_PROXY=localhost,127.0.0.1,postgres,redis,10.223.132.41`，
保持本地直连。生产 `.env` 无需新增任何键（走默认值，行为不变）。

### 3.7 .gitignore

追加 `.trae-html-share-packages/`。

## 4. 验证方案

1. 语法：`python -m py_compile` 覆盖 ticket_enrichment.py、agent_runtime.py、ensure.py、client.py。
2. 后端单测（容器内）：`docker cp backend/tests/* /app/tests/` 后
   `docker exec soar-backend-dev python -m pytest /app/tests/test_ticket_analyst_*.py -q`，42 项全过。
3. 新增/补充断言（在现有 test_ticket_analyst_adapter.py 内）：
   - reasons 缺任一模块前缀 → 抛 `AgentCallError`；
   - 模块顺序错乱 → 抛 `AgentCallError`；
   - 合法 5 条 → 原样保留（含前后空白不被改写）。
4. 前端：`npm run test:ticket`（11 项）+ `npm run build`。
5. 配置渲染：`docker compose --env-file .env.dev config | findstr HTTP_PROXY` 应为空值；
   `docker compose config`（生产默认）应为 `http://172.19.0.1:8999`。
6. 联调：重启 `soar-backend-dev` / `soar-worker-dev`，对存量工单执行「重新研判」：
   - 智研判结果仍为 5 模块卡片、内容逐字一致；
   - 人为构造上下文采集异常（临时把 gather_contexts 抛错或用不存在工单）不再产生低/监控结论；
   - 连续两次点击重新研判不出现 pending 卡死。

## 5. 风险与回滚

- 问题 2 校验变严：模型偶发漏模块会导致该 IP 重试 3 次后失败（失败态可见，不会写入错误结论）。提示词已明确要求 5 条，回归成本可控。
- 问题 8 变量改名：仅影响本地 `.env.dev`，生产 `.env` 无该键，默认值不变；部署脚本若显式传 `HTTP_PROXY` 需改用 `OUTBOUND_HTTP_PROXY`。
- 回滚：按文件 `git diff` 反向修改即可，无数据迁移、无表结构变更。

## 6. 需用户确认

以上 11 项修复方案（尤其是问题 2 的强校验、问题 8 的变量改名）确认后开始实施。
