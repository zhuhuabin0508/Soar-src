# 任务清单：工单研判智能体审查问题修复

> 依赖 spec.md 第 3 节精确改动方案；按顺序执行，避免相互干扰。

- [x] T1 问题 1+3：重写 `_run_agent_analysis_for_ips`（采集失败跳过研判并写失败态；gather 后释放事务）— high
- [x] T2 问题 2+10：`agent_runtime.py` 新增 `_validate_reason_modules` 并保留 reasons 原文 — high
- [x] T3 问题 6+9：`ticket_enrichment.py` 补 `_is_entity_ip` 过滤、两处返回补 `agent_ips` — medium
- [x] T4 问题 7：`_submit_bg_task` 同键后续任务排队串行，任务不丢 — medium
- [x] T5 问题 4+5：`ensure.py` 模型配置去硬编码、创建加锁；`client.py` 只解析不创建 — medium
- [x] T6 问题 8+11：compose 改用 `OUTBOUND_*` 插值变量、`.env.dev` 同步、`.gitignore` 追加忽略 — medium
- [x] T7 验证：py_compile + 后端 45 项单测 + 新增适配器断言 + 前端 11 项单测与 build — high
- [x] T8 联调：compose config 校验 → 重启后端/worker → 工单重新研判回归（5 模块卡片、无 pending 卡死） — high
