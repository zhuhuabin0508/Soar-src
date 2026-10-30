# SOAR 智能安全运营平台

一个面向安全运营自动化（SOAR）的全栈平台，集成智能体编排、工作流自动化、知识库检索、威胁情报研判与封禁决策能力。基于 Hermes 引擎实现可观测的 ReAct 智能体，支持流式输出、工具调用、技能注入与多轮对话上下文。

## ✨ 核心功能

- **智能体管理**：基于 Hermes 引擎的 ReAct 智能体，支持流式输出（SSE）、工具调用、技能注入、多轮对话上下文持久化、思考过程展示
- **工作流编排**：可视化拖拽编排（React Flow），支持 AI 智能体节点、条件分支、HTTP 节点、Webhook 触发，节点输出变量以卡片形式展示
- **知识库**：文档上传/分段/向量化/检索（BM25 + 向量），支持 Excel/Word/PDF/CSV/TXT，配置分块模式、索引模式、Embedding 模型
- **工具系统**：HTTP/OpenAPI 工具，GET/POST/DELETE 方法色标区分，参数映射、执行时机（自动/确认）、异常处理配置
- **技能系统**：纯文本指令注入智能体 system prompt
- **IP 风险研判与封禁决策**：智能体自动查询资产归属与威胁情报，输出 6 模块研判报告，支持封禁时长计算与记录管理
- **已封禁 IP 管理**：手动/智能体两种来源标识，支持手动新增、解封、硬删除、CSV 导入导出
- **系统监控**：服务健康、容器日志查看、模型调用监控、审计日志（记录所有写操作含 IP）
- **权限体系**：基于角色的访问控制（RBAC），管理员/分析师/访客；用户管理支持 Excel 批量导入（模板下载、行级校验、跳过/覆盖冲突策略、错误明细）与导出（全部/选中，不含密码等敏感字段）
- **通知中心**：系统更新自动推送更新明细

## 🏗️ 技术栈

### 后端
- **FastAPI** + **Uvicorn** — API 服务
- **SQLAlchemy** + **PostgreSQL** — ORM 与数据存储
- **Celery** + **Redis** — 异步任务与消息中间件
- **LangChain** — LLM 编排基础（自研 Hermes ReAct 引擎）
- **PyJWT** + **passlib/bcrypt** — 鉴权与密码哈希

### 前端
- **React 19** + **Vite** — UI 框架与构建工具（本地开发用 dev server，生产走 `vite build` 静态产物）
- **TailwindCSS** — 样式
- **React Flow** — 工作流可视化编排
- **Zustand** — 状态管理
- **ECharts** — 数据可视化

### 基础设施
- **Nginx**（宿主机 systemd 服务）— 生产入口：TLS 终止、托管前端构建产物、反代 API/WebSocket
- **Docker Compose** — 后端栈编排：postgres / redis / backend-dev / worker-dev / beat-dev

## 🚀 生产部署架构

**生产环境不再运行任何开发服务器。** 前端经 `vite build` 产出静态文件由 Nginx 托管；后端栈跑在 Docker 内；Vite dev server 仅存在于本地开发。

```
浏览器 ──HTTPS──> Nginx(:8080) ──┬── 静态文件  frontend/dist
                                ├── /api/、/ws/ ──> soar-backend-dev 容器（127.0.0.1:8001）
         (:80 http 自动 301 跳转 https)
后端栈内部：backend-dev / worker-dev / beat-dev（共用 soar-backend:latest 镜像）
           postgres（127.0.0.1:5432）/ redis（仅容器网络）
```

| 组件 | 运行形态 | 说明 |
|------|---------|------|
| Nginx | 宿主机 systemd（`nginx.service`） | 8080 HTTPS 终止 + 80 跳转；安全响应头；CSP nonce + strict-dynamic |
| 后端 API | 容器 `soar-backend-dev` | 源码挂载，uvicorn 直跑（带 healthcheck；改 `.py` 需 `docker restart soar-backend-dev`）；端口仅绑 `127.0.0.1:8001` |
| 异步任务 | 容器 `soar-worker-dev` | 源码挂载 + Celery（改代码需手动重启容器） |
| 定时调度 | 容器 `soar-beat-dev` | 源码挂载 + Celery Beat |
| 数据库 | 容器 `soar-postgres` | PostgreSQL 15，端口仅绑 `127.0.0.1:5432` |
| 缓存 | 容器 `soar-redis` | Redis 7.4，仅容器网络可达 |

后端镜像 `soar-backend:latest`（Python 依赖预装）需在**目标架构**上构建：`bash scripts/build-and-export-images.sh`（容器出网走内网代理，见 `.env.example`）。

## 🖥️ 本地开发

环境要求：Docker Desktop、Node 20+（本地为 AMD64 亦无妨，本地构建的镜像/依赖只服务本地，详见下方「跨架构注意」）。

```bash
# 1. 环境变量
cp .env.example .env.dev        # 按需修改密码与 JWT_SECRET

# 2. 启动后端栈（postgres/redis/backend/worker/beat）
docker compose --env-file .env.dev up -d

# 3. 前端（宿主机运行 dev server）
cd frontend
npm install
npm run dev                     # http://localhost:8080，/api 自动代理到 localhost:8001
```

首次启动空库时自动建表并 seed 初始管理员（`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` 决定）。

常用操作（`dev.sh`）：

```bash
bash dev.sh logs b      # 后端日志（实时）
bash dev.sh logs w      # worker 日志
bash dev.sh restart w   # 改 Celery 代码后重启 worker
bash dev.sh ps          # 容器状态
bash dev.sh down        # 停止（切勿 down -v，会清空数据卷）
```

> 注意：前端容器（`soar-frontend-dev`）已从编排中移除，`dev.sh` 中带 `f` 的子命令不再适用；本地前端一律在宿主机 `npm run dev`。

### 跨架构注意（AMD64 本地 ↔ ARM64 服务器）

生产服务器为 ARM64（麒麟 V10），本地开发机通常为 AMD64（Windows/macOS）。**git 是本地到服务器的唯一同步通道**，源码（纯文本）无架构概念，直接 push/pull 即可。以下操作跨架构必坏，禁止执行：

- `docker save / load` 传输本地构建的镜像 → 服务器 `exec format error`；服务器镜像须在服务器（或同架构环境）构建
- 拷贝 `node_modules` / `.venv` → 原生二进制（esbuild、psycopg2 等）不兼容
- 拷贝 pgdata 数据卷目录 → 只能走 `pg_dump` SQL 文本同步（Windows 侧导入用 `docker cp` + `docker exec psql -f`，**勿用 PowerShell 管道 `type |`**，会破坏 UTF-8）

## 🔄 日常更新部署（服务器）

标准发版一条命令（拉代码 → 前端构建 → 后端容器重建 → 就绪探测 → Nginx 配置同步）：

```bash
cd /opt/soar-src
bash deploy/deploy.sh
```

只改部分内容时的快速路径：

| 改动 | 生效方式 |
|------|---------|
| 后端 `.py` | `docker restart soar-backend-dev`（uvicorn 已禁用 `--reload`，防 reloader 竞态卡死） |
| Celery 相关 `.py` | `docker restart soar-worker-dev soar-beat-dev` |
| 前端源码 | `cd frontend && npm run build`（Nginx 直接读 dist，改完浏览器强刷） |
| `deploy/nginx.conf` | 拷贝到 `/etc/nginx/conf.d/secops.conf` 后 `nginx -t && systemctl reload nginx`（deploy.sh 第 5 步会自动做） |
| `requirements.txt` | 重建后端镜像：`bash scripts/build-and-export-images.sh` 后 `docker compose --env-file .env.dev up -d` |
| `package.json` 增删依赖 | `cd frontend && npm ci` |

> **纪律**：生产环境永不运行 `vite dev` / `npm run dev` 对外服务——开发服务器暴露源码与模块结构，是历史安全扫描中高危漏洞的根因。

## ⚙️ 配置说明

所有配置通过 `.env.dev` 注入（不入库，从 `.env.example` 复制）。主要配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `POSTGRES_DB` | 数据库名 | `soar` |
| `POSTGRES_PASSWORD` | 数据库密码 | `postgres`（生产必须修改） |
| `JWT_SECRET` | JWT 签名密钥 | 见 `.env.example`（生产必须强随机） |
| `SEED_ADMIN_USERNAME` | 初始管理员账号 | `admin` |
| `SEED_ADMIN_PASSWORD` | 初始管理员密码 | `admin123`（生产必须修改） |

> **安全提示**：LLM 的 API Key 在系统「模型设置」页面配置，存储于数据库，不出现在代码或环境变量中。

## 📁 项目结构

```
.
├── backend/                  # FastAPI 后端
│   ├── app/
│   │   ├── agent/            # Hermes ReAct 引擎
│   │   ├── api/v1/           # REST API 端点
│   │   ├── core/             # 配置、安全、种子数据、Celery
│   │   ├── models/           # SQLAlchemy 数据模型
│   │   ├── tools/            # 工具实现（资产查询、威胁情报、封禁等）
│   │   └── tasks/            # Celery 异步任务
│   ├── Dockerfile
│   ├── requirements.txt
│   └── entrypoint.sh
├── frontend/                 # React 前端
│   ├── src/
│   │   ├── pages/            # 页面组件
│   │   ├── components/       # 通用组件
│   │   ├── api/              # API 客户端
│   │   └── store/            # Zustand 状态
│   ├── vite.config.js        # 本地开发配置（8080 + /api 代理 → 8001）
│   └── package.json
├── deploy/                   # 生产部署（入库版本化）
│   ├── nginx.conf            # 生产 Nginx 配置（TLS/CSP/反代）
│   └── deploy.sh             # 一键发版脚本
├── scripts/
│   ├── build-and-export-images.sh  # 构建后端镜像并导出 tar
│   ├── proxy-forwarder.py          # 容器出网代理转发
│   └── update.sh                    # （旧热重载更新脚本，已被 deploy/deploy.sh 取代）
├── docs/                     # 设计文档
├── docker-compose.yml        # 后端栈运行环境（无前端容器）
├── docker-compose.security-tools.yml  # DefectDojo / BloodHound（可选）
├── .env.example              # 环境变量模板
└── dev.sh                    # 本地/容器运维便捷脚本
```

## 📖 设计文档

- [Hermes 引擎集成](docs/hermes-engine-integration.md)
- [Hermes 附加功能集成](docs/hermes-additional-features-integration.md)
- [技能系统 Prompt 注入](docs/skill-system-prompt-injection.md)
- [工具迁移到系统级](docs/hermes-tools-migration-to-system.md)

## 🔒 安全说明

生产入口（Nginx）已按安全扫描整改加固：

- **TLS**：仅 TLS 1.2/1.3 + ECDHE 前向保密套件（禁用 RSA 密钥交换与 SHA-1 套件）；`server_tokens off` 隐藏版本号
- **CSP**：`script-src 'nonce-…' 'strict-dynamic'`，由 Nginx `sub_filter` 按请求注入 nonce
- **安全响应头**：HSTS、X-Content-Type-Options、Referrer-Policy 全量下发（含 80 端口跳转响应）
- **网络边界**：后端（8001）与 PostgreSQL（5432）仅监听 `127.0.0.1`，Redis 仅容器网络可达；敏感路径（`.git`、`src/`、`node_modules/` 等）一律拒绝访问

应用层：

- 密码使用 bcrypt 哈希存储，永不存明文；API 请求体严格校验（多余字段拒绝，防成批分配）
- JWT 鉴权，所有 API 需登录访问
- 审计日志记录所有写操作（操作人、模块、资源 ID、IP）
- 数据库凭证、JWT 密钥等均通过环境变量注入；TLS 证书放服务器 `/etc/nginx/ssl/`（`.gitignore` 覆盖 `*.key`/`*.crt`，证书与 `.env*` 永不入库）
- 业务数据存储于 Docker 数据卷（`soaragent_pgdata`），不在代码仓库中

## 📄 许可证

本项目仅供学习与内部使用。
