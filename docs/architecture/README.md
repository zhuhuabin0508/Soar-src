# SOAR 方案文档目录

路径：`docs/architecture/`

本目录集中存放**架构定稿、基座优化、Agent 收口、设备对接**相关方案，与 `docs/` 下其他产品/迭代文档分离。

## 阅读顺序（推荐）

当前进度不在本目录里维护。先看 [项目进度与任务规划](../项目进度与任务规划.md)（2026-11-02）：`main` 上的封禁/大屏，以及未合并的 `feat/modular-decoupling`。

| 顺序 | 文档 | 用途 |
|------|------|------|
| 1 | [soar架构方案.md](./soar架构方案.md) | **总架构定稿 v2.0**（原则、模块边界、设备工具化） |
| 2 | [待办与开工清单.md](./待办与开工清单.md) | 可迭代细节、分阶段任务与状态勾选（**开工盯这份**） |
| 3 | [SOAR Agent 平台基座优化方案.md](./SOAR%20Agent%20平台基座优化方案.md) §13.2 | 本季度 MVP 执行清单 |
| 4 | [LangGraph → Hermes 统一.md](./LangGraph%20→%20Hermes%20统一.md) | Agent 运行时契约与收口 Step |
| 5 | [LangGraph → Hermes 实施进度.md](./LangGraph%20→%20Hermes%20实施进度.md) | 阶段 0 收口任务勾选与证据 |
| 6 | [module-responsibilities-and-relations.md](./module-responsibilities-and-relations.md) | 五模块职责与已知问题 |
| 7 | [device-integration-architecture.md](./device-integration-architecture.md) | 设备对接代码落点（细节以 soar架构方案 §6 为准） |

## 其他

| 文档 | 用途 |
|------|------|
| [platform-architecture-llm-base-modules.md](./platform-architecture-llm-base-modules.md) | 早期高层草案（已被 soar架构方案吸收，备查） |
| [LLM-底座-设备工具化-落地方案.md](./LLM-%E5%BA%95%E5%BA%A7-%E8%AE%BE%E5%A4%87%E5%B7%A5%E5%85%B7%E5%8C%96-%E8%90%BD%E5%9C%B0%E6%96%B9%E6%A1%88.md) | 设备工具化执行稿（待与待办清单对齐后启用） |
| [数据库连接与并发优化方案.md](./数据库连接与并发优化方案.md) | **已完成**：双池+短会话+触发并发；**下一阶段**：大屏 Redis 快照 |

## 冲突时怎么判

1. 现在做没做完、下一步做什么 → **[项目进度与任务规划](../项目进度与任务规划.md)**
2. 模块边界、设备暴露形态 → **soar架构方案.md**
3. Agent 运行时技术契约 → **LangGraph → Hermes 统一.md**
4. 本季度做不做某项 → **基座方案 §13.2**
5. 阶段 0 是否 Done → **LangGraph → Hermes 实施进度.md** §2
6. 10 月开工台账（历史，不覆盖第 1 条） → **待办与开工清单.md**
